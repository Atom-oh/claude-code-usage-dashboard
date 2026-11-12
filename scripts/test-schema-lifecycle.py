#!/usr/bin/env python3
"""Exercise the actual schema runner against a disposable replicated ClickHouse."""

from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import json
import re
import subprocess
import time
import unittest
import xml.etree.ElementTree as ET
from schema_lifecycle_fixture import SchemaFixture

ROOT = Path(__file__).resolve().parents[1]


class SchemaLifecycle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = SchemaFixture(ROOT)
        cls.fixture.__enter__()
        cls.addClassCleanup(cls.fixture.__exit__, None, None, None)
        cls.bootstrap = cls.fixture.runner()
        if cls.bootstrap.returncode != 0:
            raise RuntimeError(cls.bootstrap.stdout + cls.bootstrap.stderr)

    def snapshot(self, fixture=None):
        fixture = fixture or self.fixture
        fixture.query("SYSTEM FLUSH LOGS")
        return {
            "mutations": fixture.rows(
                "SELECT table, mutation_id, command FROM system.mutations "
                "WHERE database = 'claude_code' ORDER BY table, mutation_id"
            ),
            "writes": fixture.rows(
                "SELECT count() AS count FROM system.query_log "
                "WHERE (startsWith(query_id, 'schema-bootstrap-') "
                "OR startsWith(query_id, 'schema-verify-') OR startsWith(query_id, 'schema-inspect-')) "
                "AND query_kind != 'Select'"
            ),
        }

    def verify_without_writes(self, success, fixture=None, **environment):
        fixture = fixture or self.fixture
        before = self.snapshot(fixture)
        result = fixture.runner(**environment)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        self.assertEqual(before, self.snapshot(fixture), "Runner issued writes or scheduled mutations")
        return result

    def test_empty_installation_bootstraps_and_records_all_versions(self):
        self.assertIn("bootstrapping an empty database", self.bootstrap.stdout)
        self.assertIn("every expected replica", self.bootstrap.stdout)
        self.assertEqual(
            [row["version"] for row in self.fixture.rows(
                "SELECT version FROM claude_code.schema_migrations ORDER BY version"
            )], [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        )

    def test_populated_compatible_installation_only_reads_metadata(self):
        self.fixture.query("""INSERT INTO claude_code.otel_metrics_sum
          (ResourceAttributes, MetricName, Attributes, StartTimeUnix, TimeUnix, Value,
           AggregationTemporality, IsMonotonic)
          VALUES (map('user.email','fixture@example.invalid'),
            'claude_code.cost.usage', map('session.id','fixture','model','claude-sonnet-4-6'),
            now64(9), now64(9), 1, 2, 1)""")
        before = self.fixture.rows(
            "SELECT count() AS rows, sum(Value) AS value FROM claude_code.otel_metrics_sum"
        )
        for _ in range(2):
            result = self.verify_without_writes(True)
            self.assertIn("verifying existing replicas", result.stdout)
            self.assertNotIn("bootstrapping", result.stdout)
        self.assertEqual(before, self.fixture.rows(
            "SELECT count() AS rows, sum(Value) AS value FROM claude_code.otel_metrics_sum"
        ))

    def test_wrong_replica_count_fails_without_writes(self):
        result = self.verify_without_writes(False, CH_EXPECTED_REPLICAS="2")
        self.assertIn("replica count", result.stderr)

    def test_codex_view_security_drift_is_rejected_without_repair(self):
        for view in ("claude_code.codex_cost_events_v1_mv", "claude_code.codex_diagnostic_events_v1_mv"):
            with self.subTest(view=view):
                self.fixture.query(f"ALTER TABLE {view} MODIFY SQL SECURITY NONE")
                try:
                    result = self.verify_without_writes(False)
                    self.assertIn("Codex views require explicit definer security", result.stderr)
                finally:
                    self.fixture.query(
                        f"ALTER TABLE {view} MODIFY DEFINER = CURRENT_USER SQL SECURITY DEFINER"
                    )

    def test_cost_view_destination_drift_is_rejected_without_repair(self):
        for target in ("claude_code.codex_cost_events_v1", "claude_code.codex_cost_scope_v1",
                       "claude_code.codex_diagnostic_events_v1"):
            with self.subTest(target=target):
                view = target + "_mv"
                ddl = self.fixture.query(f"SHOW CREATE TABLE {view} FORMAT TSVRaw").stdout
                self.fixture.query(f"CREATE TABLE {target}_other AS {target} ENGINE=MergeTree ORDER BY tuple()")
                self.fixture.query(f"DROP VIEW {view}")
                try:
                    self.fixture.query(ddl.replace("TO " + target, "TO " + target + "_other", 1))
                    result = self.verify_without_writes(False)
                    self.assertIn("Codex materialized view target differs", result.stderr)
                finally:
                    self.fixture.query(f"DROP VIEW IF EXISTS {view}")
                    self.fixture.query(ddl)
                    self.fixture.query(f"DROP TABLE {target}_other")

    def test_cost_backfill_preserves_values_when_columns_are_reordered(self):
        table = "claude_code.codex_cost_events_v1"
        self.fixture.query("""INSERT INTO claude_code.otel_logs
          (Timestamp, ResourceAttributes, LogAttributes)
          VALUES (now64(9), map('user.email','column-order@example.invalid'),
            map('event.name','codex.sse_event','event.kind','response.completed',
              'input_token_count','11','output_token_count','7'))""")
        self.fixture.query(f"ALTER TABLE {table} MODIFY COLUMN InputValue Float64 AFTER OutputValue")
        self.fixture.query(f"ALTER TABLE {table} MODIFY COLUMN OutputValue Float64 AFTER Rejected")
        try:
            bounds = self.fixture.rows(
                "SELECT toString(toStartOfHour(now(), 'UTC')) AS start, "
                "toString(toStartOfHour(now(), 'UTC') + INTERVAL 1 HOUR) AS end"
            )[0]
            for count, zone in enumerate(("UTC", "Asia/Seoul"), start=2):
                self.fixture.query((ROOT / "clickhouse-backfill-007.sql").read_text(),
                                   param_backfillFrom=bounds["start"], param_backfillTo=bounds["end"],
                                   session_timezone=zone, insert_deduplicate=0)
                where = f"FROM {table} WHERE UserEmail = 'column-order@example.invalid'"
                self.assertEqual(self.fixture.rows("SELECT DISTINCT InputValue, OutputValue " + where),
                                 [{"InputValue": 11, "OutputValue": 7}])
                self.assertEqual(self.fixture.rows("SELECT toUInt32(count()) AS n " + where), [{"n": count}])
        finally:
            self.fixture.query(f"ALTER TABLE {table} MODIFY COLUMN OutputValue Float64 AFTER InputValue")
            self.fixture.query(f"ALTER TABLE {table} MODIFY COLUMN InputValue Float64 AFTER Rejected")

    def test_zero_timeout_cannot_disable_the_process_deadline(self):
        result = self.verify_without_writes(False, SCHEMA_QUERY_TIMEOUT_SECONDS="00")
        self.assertIn("must be positive integers", result.stderr)

    def test_diagnostic_live_and_backfill_states_merge_exact_identities(self):
        table = "claude_code.codex_diagnostic_events_v1"
        self.fixture.query("""INSERT INTO claude_code.otel_logs
          (Timestamp, ResourceAttributes, LogAttributes)
          SELECT toStartOfSecond(now64(9)) + toIntervalNanosecond(number % 2),
            map('user.email','diagnostic-lifecycle@example.invalid'),
            map('event.name','codex.sse_event','event.kind','response.output_text.delta',
              'conversation.id','diagnostic-lifecycle','duration_ms','4.25')
          FROM numbers(4)""")
        bounds = self.fixture.rows(
            "SELECT toString(toStartOfHour(now(), 'UTC')) AS start, "
            "toString(toStartOfHour(now(), 'UTC') + INTERVAL 1 HOUR) AS end"
        )[0]
        expected = self.fixture.rows("""SELECT toUInt32(uniqExact(tuple(
          toString(toTimeZone(Timestamp,'UTC')),mapSort(ResourceAttributes),mapSort(LogAttributes)))) AS n
          FROM claude_code.otel_logs
          WHERE ResourceAttributes['user.email']='diagnostic-lifecycle@example.invalid'""")
        self.assertEqual(expected, [{"n": 2}])
        selected = f"""SELECT toUInt32(sum(finalizeAggregation(Identities))) AS n
          FROM {table} FINAL WHERE UserEmail='diagnostic-lifecycle@example.invalid'"""
        self.assertEqual(self.fixture.rows(selected), expected)
        self.fixture.query(f"SYSTEM STOP MERGES {table}")
        try:
            for zone in ("UTC", "Asia/Seoul"):
                self.fixture.query((ROOT / "clickhouse-backfill-008.sql").read_text(),
                                   param_backfillFrom=bounds["start"], param_backfillTo=bounds["end"],
                                   session_timezone=zone, insert_deduplicate=0)
                self.assertEqual(self.fixture.rows(selected), expected)
        finally:
            self.fixture.query(f"SYSTEM START MERGES {table}")
        self.fixture.query(f"OPTIMIZE TABLE {table} FINAL")
        self.assertEqual(self.fixture.rows(selected), expected)

    def test_provider_live_and_backfill_rows_keep_session_membership(self):
        table = "claude_code.claude_session_providers_v1"
        self.fixture.query("""INSERT INTO claude_code.otel_metrics_sum
          (ResourceAttributes, MetricName, Attributes, StartTimeUnix, TimeUnix, Value,
           AggregationTemporality, IsMonotonic)
          SELECT map('user.email','provider-lifecycle@example.invalid'), 'claude_code.cost.usage',
            map('session.id', 'provider-lifecycle', 'model', 'claude-sonnet-5',
                'anthropic.provider', if(number = 0, 'bedrock', 'firstParty'),
                'anthropic.custom_base_url', 'https://gateway.example.invalid'),
            now64(9), now64(9), number + 1, 2, 1
          FROM numbers(3)""")
        bounds = self.fixture.rows(
            "SELECT toString(toStartOfHour(now(), 'UTC')) AS start, "
            "toString(toStartOfHour(now(), 'UTC') + INTERVAL 1 HOUR) AS end"
        )[0]
        selected = f"""SELECT Provider FROM {table} FINAL
          WHERE SessionId = 'provider-lifecycle' ORDER BY Provider"""
        expected = [{"Provider": "bedrock"}, {"Provider": "firstParty"}]
        self.assertEqual(self.fixture.rows(selected), expected)
        for zone in ("UTC", "Asia/Seoul"):
            self.fixture.query((ROOT / "clickhouse-backfill-009.sql").read_text(),
                               param_backfillFrom=bounds["start"], param_backfillTo=bounds["end"],
                               session_timezone=zone, insert_deduplicate=0)
            self.assertEqual(self.fixture.rows(selected), expected)
        columns = self.fixture.rows(
            "SELECT name FROM system.columns WHERE database = 'claude_code' "
            "AND table = 'claude_session_providers_v1' ORDER BY name"
        )
        self.assertEqual(columns, [{"name": "Provider"}, {"name": "SessionId"}, {"name": "hour"}])

    def test_provider_view_security_drift_is_rejected_without_repair(self):
        view = "claude_code.claude_session_providers_v1_mv"
        self.fixture.query(f"ALTER TABLE {view} MODIFY SQL SECURITY NONE")
        try:
            result = self.verify_without_writes(False)
            self.assertIn("Claude provider view target or definer security differs", result.stderr)
        finally:
            self.fixture.query(f"ALTER TABLE {view} MODIFY DEFINER = CURRENT_USER SQL SECURITY DEFINER")

    def test_session_turns_live_and_repeated_backfill_keep_exact_key_sets(self):
        table = "claude_code.session_turns_v1"
        keys = json.loads(subprocess.run(
            ["node", "--input-type=module", "-e",
             "import * as m from './dashboard/server/sessionTurnsSchema.js';"
             "console.log(JSON.stringify({turn: m.claudeTurnKeySql(''), call: m.claudeCallKeySql(''), codex: m.codexTurnKeySql()}))"],
            cwd=ROOT, text=True, capture_output=True, check=True).stdout)
        bounds = self.fixture.rows(
            "SELECT toString(toStartOfHour(now(), 'UTC')) AS start, "
            "toString(toStartOfHour(now(), 'UTC') + INTERVAL 1 HOUR) AS end"
        )[0]
        user = "session-turns-lifecycle@example.invalid"
        # (event, seconds into the hour, attributes). Duplicates repeat Timestamp and attributes.
        claude = {"event.name": "user_prompt", "session.id": "turns-lifecycle"}
        call = {"event.name": "api_request", "session.id": "turns-lifecycle", "model": "claude-sonnet-5"}
        codex = {"event.name": "codex.user_prompt", "conversation.id": "turns-lifecycle-codex"}
        rows = [
            (1, {**claude, "prompt.id": "a"}), (2, {**claude, "prompt.id": "a"}),
            (3, {**claude, "prompt.id": "b"}),
            (4, {**call, "event.sequence": "1"}), (4, {**call, "event.sequence": "1"}),
            (5, {**call, "event.sequence": "2"}),
            (6, {**codex, "text": "x"}), (6, {**codex, "text": "x"}), (7, {**codex, "text": "y"}),
            (8, {"event.name": "user_prompt", "prompt.id": "no-session"}),
        ]
        def attributes(attrs):
            return ", ".join(f"'{key}', '{value}'" for key, value in attrs.items())
        values = ",\n".join(
            f"(toDateTime64('{bounds['start']}', 9, 'UTC') + {second}, "
            f"map('user.email','{user}'), map({attributes(attrs)}))"
            for second, attrs in rows
        )
        self.fixture.query(
            f"INSERT INTO claude_code.otel_logs (Timestamp, ResourceAttributes, LogAttributes) VALUES {values}"
        )
        selected = f"""SELECT Client, Kind, toString(uniqExactMerge(Keys)) AS keys FROM {table}
          WHERE UserIdentity = '{user}' GROUP BY Client, Kind ORDER BY Client, Kind"""
        expected = [
            {"Client": "claude", "Kind": "request", "keys": "2"},
            {"Client": "claude", "Kind": "turn", "keys": "2"},
            {"Client": "codex", "Kind": "turn", "keys": "2"},
        ]
        raw = f"""SELECT * FROM (
          SELECT 'claude' AS Client, 'request' AS Kind,
            toString(uniqExactIf(cityHash64({keys['call']}), EventName IN ('api_request', 'claude_code.api_request'))) AS keys
          FROM claude_code.otel_logs WHERE ResourceAttributes['user.email'] = '{user}' AND SessionId != ''
          UNION ALL SELECT 'claude', 'turn',
            toString(uniqExactIf(cityHash64({keys['turn']}), EventName IN ('user_prompt', 'claude_code.user_prompt')))
          FROM claude_code.otel_logs WHERE ResourceAttributes['user.email'] = '{user}' AND SessionId != ''
          UNION ALL SELECT 'codex', 'turn',
            toString(uniqExactIf(cityHash64({keys['codex']}), EventName = 'codex.user_prompt'))
          FROM claude_code.otel_logs WHERE ResourceAttributes['user.email'] = '{user}'
            AND LogAttributes['conversation.id'] != ''
        ) ORDER BY Client, Kind"""
        # The oracle reuses the transform key expressions emitted by the module that owns them;
        # `expected` is hardcoded from the fixture rows.
        self.assertEqual(self.fixture.rows(raw), expected)
        self.assertEqual(self.fixture.rows(selected), expected)
        # The same record yields the same key under any session time zone (view vs backfill).
        digest = f"""SELECT toString(sum(cityHash64({keys['turn']}, {keys['call']}, {keys['codex']}))) AS d
          FROM claude_code.otel_logs WHERE ResourceAttributes['user.email'] = '{user}'"""
        digests = {zone: self.fixture.query(digest, session_timezone=zone, format="TSV").stdout
                   for zone in ("UTC", "Asia/Seoul", "America/Los_Angeles")}
        self.assertEqual(len(set(digests.values())), 1, digests)
        for zone in ("UTC", "Asia/Seoul", "UTC"):
            self.fixture.query((ROOT / "clickhouse-backfill-010.sql").read_text(),
                               param_backfillFrom=bounds["start"], param_backfillTo=bounds["end"],
                               session_timezone=zone, insert_deduplicate=0)
            self.assertEqual(self.fixture.rows(selected), expected)
        sessions = self.fixture.rows(
            f"SELECT DISTINCT SessionId FROM {table} WHERE UserIdentity = '{user}' ORDER BY SessionId")
        self.assertEqual(sessions, [{"SessionId": "turns-lifecycle"}, {"SessionId": "turns-lifecycle-codex"}])
        # The exact reader SQL, with bound parameters, over the backfilled table.
        reader = subprocess.run(
            ["node", "--input-type=module", "-e",
             "import { turnsSql } from './dashboard/server/tokenEconomicsSource.js'; process.stdout.write(turnsSql());"],
            cwd=ROOT, text=True, capture_output=True, check=True).stdout
        def read_turns(clients):
            text = self.fixture.query(
                reader + " FORMAT JSONEachRow", param_from=bounds["start"], param_to=bounds["end"],
                param_bucketSeconds=3600, param_clientUser="", param_clientUserExact="",
                param_clients=clients, session_timezone="UTC").stdout
            return [r for r in map(json.loads, text.splitlines()) if clients == "[]" or r["user"] == user]
        result = read_turns("['claude','codex']")
        window = [r for r in result if r["bucket"] == ""]
        buckets = [r for r in result if r["bucket"] != ""]
        self.assertTrue(window and buckets)
        for r in buckets:
            self.assertRegex(r["bucket"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
            self.assertEqual(r["bucket"], bounds["start"].replace(" ", "T") + "Z")
        totals = {(r["Client"], r["Kind"]): int(r["keys"]) for r in self.fixture.rows(selected)}
        self.assertEqual({(r["client"], r["kind"]): int(r["n"]) for r in window}, totals)
        self.assertEqual({(r["client"], r["kind"]): int(r["n"]) for r in buckets}, totals)
        self.assertEqual(read_turns("[]"), [])
        # The runbook's activation gate: table keys equal raw keys for the window, and a lost
        # table state is reported as a difference until the backfill restores it.
        verify = (ROOT / "clickhouse-verify-010.sql").read_text()
        def compare():
            text = self.fixture.query(verify, param_verifyFrom=bounds["start"], param_verifyTo=bounds["end"],
                                      session_timezone="UTC", format="JSONEachRow").stdout
            return {(r["Client"], r["Kind"]): r for r in map(json.loads, text.splitlines()) if "Client" in r}
        rows = compare()
        self.assertTrue({("claude", "request"), ("claude", "turn"), ("codex", "turn")} <= set(rows))
        self.assertTrue(all(r["differs"] == 0 for r in rows.values()), rows)
        self.fixture.query(f"ALTER TABLE {table} DELETE WHERE SessionId = 'turns-lifecycle-codex'",
                           mutations_sync=2)
        lost = compare()[("codex", "turn")]
        self.assertEqual((lost["differs"], int(lost["raw_keys"]) - int(lost["table_keys"])), (1, 2))
        self.fixture.query((ROOT / "clickhouse-backfill-010.sql").read_text(),
                           param_backfillFrom=bounds["start"], param_backfillTo=bounds["end"],
                           session_timezone="UTC", insert_deduplicate=0)
        self.assertTrue(all(r["differs"] == 0 for r in compare().values()))
        bad = self.fixture.query(verify, param_verifyFrom=bounds["start"].replace(":00:00", ":30:00"),
                                 param_verifyTo=bounds["end"], check=False)
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("hour-aligned", bad.stdout + bad.stderr)

    def test_session_turns_view_security_drift_is_rejected_without_repair(self):
        view = "claude_code.session_turns_v1_mv"
        self.fixture.query(f"ALTER TABLE {view} MODIFY SQL SECURITY NONE")
        try:
            result = self.verify_without_writes(False)
            self.assertIn("Session turns view target or definer security differs", result.stderr)
        finally:
            self.fixture.query(f"ALTER TABLE {view} MODIFY DEFINER = CURRENT_USER SQL SECURITY DEFINER")

    def test_source_contract_mismatch_fails_before_schema_execution(self):
        self.fixture.docker("exec", self.fixture.name, "sh", "-c",
            "mkdir /tmp/schema-mismatch && cp /sql/* /tmp/schema-mismatch/ && "
            "printf '\\n-- synthetic source drift\\n' >> /tmp/schema-mismatch/clickhouse-schema-replicated.sql")
        result = self.verify_without_writes(False, SCHEMA_DIRECTORY="/tmp/schema-mismatch")
        self.assertIn("does not match the SQL file", result.stderr)

    def test_verifier_connection_rejects_an_injected_write(self):
        self.fixture.docker("exec", self.fixture.name, "sh", "-c",
            "mkdir /tmp/schema-readonly && cp /sql/* /tmp/schema-readonly/ && "
            "printf '\\nCREATE TABLE claude_code.fixture_forbidden_write "
            "(Marker UInt8) ENGINE=MergeTree ORDER BY Marker;\\n' "
            ">> /tmp/schema-readonly/clickhouse-schema-contract.sql")
        mutations = self.snapshot()["mutations"]
        result = self.fixture.runner(SCHEMA_DIRECTORY="/tmp/schema-readonly")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertRegex(result.stderr, r"(?i)readonly|read.only")
        self.assertEqual(self.fixture.rows(
            "SELECT count() AS rows FROM system.tables WHERE database = 'claude_code' "
            "AND name = 'fixture_forbidden_write'"
        )[0]["rows"], "0")
        self.assertEqual(mutations, self.snapshot()["mutations"])

    def test_missing_ledger_is_not_fabricated_on_retry(self):
        row = self.fixture.rows(
            "SELECT name, checksum FROM claude_code.schema_migrations WHERE version = 6"
        )[0]
        self.fixture.query(
            "ALTER TABLE claude_code.schema_migrations DELETE WHERE version = 6", mutations_sync=2
        )
        try:
            for _ in range(2):
                result = self.verify_without_writes(False)
                self.assertIn("migration ledger differs", result.stderr)
            self.assertEqual(self.fixture.rows(
                "SELECT count() AS rows FROM claude_code.schema_migrations WHERE version = 6"
            )[0]["rows"], "0")
        finally:
            self.assertRegex(row["name"], r"^[a-z0-9-]+$")
            self.assertRegex(row["checksum"], r"^[a-f0-9]{64}$")
            self.fixture.query(
                "INSERT INTO claude_code.schema_migrations(version,name,checksum) "
                f"VALUES (6,'{row['name']}','{row['checksum']}')"
            )

    def test_legacy_series_key_is_not_changed_or_materialized(self):
        self.fixture.query(
            "ALTER TABLE claude_code.otel_metrics_sum MODIFY COLUMN SeriesKey "
            "UInt64 MATERIALIZED cityHash64(toString(Attributes))"
        )
        try:
            result = self.verify_without_writes(False)
            self.assertIn("materialized expressions differ", result.stderr)
        finally:
            self.fixture.query(
                "ALTER TABLE claude_code.otel_metrics_sum MODIFY COLUMN SeriesKey UInt64 MATERIALIZED "
                "if(MetricName = 'claude_code.session.count', cityHash64(toString(Attributes)), "
                "cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix)))"
            )

    def test_retention_drift_is_not_silently_repaired(self):
        self.fixture.query(
            "ALTER TABLE claude_code.otel_metrics_sum_hourly MODIFY TTL "
            "toDateTime(hour) + INTERVAL 365 DAY DELETE", materialize_ttl_after_modify=0
        )
        try:
            result = self.verify_without_writes(False)
            self.assertIn("TTL or materialized view differ", result.stderr)
        finally:
            self.fixture.query(
                "ALTER TABLE claude_code.otel_metrics_sum_hourly MODIFY TTL "
                "toDateTime(hour) + INTERVAL 180 DAY DELETE", materialize_ttl_after_modify=0
            )

    def test_retained_rollback_objects_are_preserved(self):
        self.fixture.query(
            "CREATE TABLE claude_code.retained_rollback_fixture "
            "(Marker UInt8) ENGINE = MergeTree ORDER BY Marker"
        )
        self.verify_without_writes(True)
        self.assertEqual(self.fixture.rows(
            "SELECT count() AS rows FROM system.tables WHERE database = 'claude_code' "
            "AND name = 'retained_rollback_fixture'"
        )[0]["rows"], "1")

    def test_established_delete_only_hourly_default_storage_is_compatible(self):
        source = (ROOT / "infra/files/clickhouse-schema-replicated.sql").read_text()
        hourly = re.search(
            r"CREATE TABLE IF NOT EXISTS claude_code\.otel_metrics_sum_hourly\b[\s\S]*?;",
            source,
        )[0]
        established = hourly.replace("storage_policy = 'hot_cold'", "storage_policy = 'default'")
        self.assertNotEqual(hourly, established)
        with SchemaFixture(ROOT) as legacy:
            legacy.query(source.replace(hourly, established), mutations_sync=2)
            result = self.verify_without_writes(True, fixture=legacy)
            self.assertIn("verifying existing replicas", result.stdout)
            self.assertEqual(legacy.rows(
                "SELECT storage_policy FROM system.tables WHERE database='claude_code' "
                "AND name='otel_metrics_sum_hourly'"
            )[0]["storage_policy"], "default")

    def test_wrong_materialized_view_target_is_rejected(self):
        source = (ROOT / "infra/files/clickhouse-schema-replicated.sql").read_text()
        view = re.search(
            r"CREATE MATERIALIZED VIEW IF NOT EXISTS claude_code\.otel_metrics_sum_hourly_mv\b[\s\S]*?;",
            source,
        )[0]
        self.fixture.query(
            "CREATE TABLE claude_code.fixture_hourly_archive AS claude_code.otel_metrics_sum_hourly "
            "ENGINE = AggregatingMergeTree ORDER BY "
            "(MetricName, SessionId, SeriesKey, UserEmail, hour)"
        )
        self.fixture.query("DROP TABLE claude_code.otel_metrics_sum_hourly_mv SYNC")
        try:
            self.fixture.query(view.replace(
                "TO claude_code.otel_metrics_sum_hourly AS", "TO claude_code.fixture_hourly_archive AS"
            ))
            result = self.verify_without_writes(False)
            self.assertIn("materialized view target differs", result.stderr)
        finally:
            self.fixture.query("DROP TABLE IF EXISTS claude_code.otel_metrics_sum_hourly_mv SYNC")
            self.fixture.query(view)

    def test_partial_bootstrap_requires_explicit_repair(self):
        with SchemaFixture(ROOT) as partial:
            partial.query(
                "CREATE DATABASE claude_code; CREATE TABLE claude_code.fixture_partial "
                "(Marker UInt8) ENGINE = MergeTree ORDER BY Marker"
            )
            for _ in range(2):
                result = self.verify_without_writes(False, fixture=partial)
                self.assertIn("verifying existing replicas", result.stdout)
                self.assertNotIn("bootstrapping", result.stdout)
            self.assertEqual(partial.rows(
                "SELECT count() AS rows FROM system.tables WHERE database = 'claude_code'"
            )[0]["rows"], "1")


class MultiReplicaSchemaLifecycle(unittest.TestCase):
    """Use three real servers on an internal-only Docker network."""

    @classmethod
    def setUpClass(cls):
        cls.fixture = SchemaFixture(ROOT, replicas=3)
        cls.fixture.__enter__()
        cls.addClassCleanup(cls.fixture.__exit__, None, None, None)
        cls.bootstrap = cls.fixture.runner()
        if cls.bootstrap.returncode != 0:
            raise RuntimeError(cls.bootstrap.stdout + cls.bootstrap.stderr)

    verify_without_writes = SchemaLifecycle.verify_without_writes

    def snapshot(self, fixture=None):
        fixture = fixture or self.fixture
        results = []
        for index in range(fixture.replicas):
            fixture.query("SYSTEM FLUSH LOGS", node_index=index)
            results.append({
                "mutations": fixture.rows(
                    "SELECT table, mutation_id, command FROM system.mutations "
                    "WHERE database = 'claude_code' ORDER BY table, mutation_id", node_index=index
                ),
                "writes": fixture.rows(
                    "SELECT count() AS count FROM system.query_log "
                    "WHERE (startsWith(query_id, 'schema-bootstrap-') "
                    "OR startsWith(query_id, 'schema-verify-') OR startsWith(query_id, 'schema-inspect-')) "
                    "AND query_kind != 'Select'", node_index=index
                ),
            })
        return results

    def test_three_replicas_bootstrap_with_complete_ledger(self):
        self.assertIn("bootstrapping", self.bootstrap.stdout)
        for index in range(3):
            self.assertEqual(
                [row["version"] for row in self.fixture.rows(
                    "SELECT version FROM claude_code.schema_migrations ORDER BY version", node_index=index
                )], [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            )
        self.verify_without_writes(True)

    def test_populated_replicas_only_receive_reads(self):
        self.fixture.query(
            "INSERT INTO claude_code.otel_metrics_sum "
            "(MetricName, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic) "
            "VALUES ('claude_code.cost.usage',now64(9),now64(9),1,2,1)", node_index=1
        )
        for index in range(3):
            self.fixture.query("SYSTEM SYNC REPLICA claude_code.otel_metrics_sum", node_index=index)
        self.verify_without_writes(True)
        for index in range(3):
            self.assertEqual(self.fixture.rows(
                "SELECT count() AS rows FROM claude_code.otel_metrics_sum", node_index=index
            )[0]["rows"], "1")

    def test_missing_view_on_one_replica_fails_every_retry_without_repair(self):
        source = (ROOT / "infra/files/clickhouse-schema-replicated.sql").read_text()
        view = re.search(
            r"CREATE MATERIALIZED VIEW IF NOT EXISTS claude_code\.otel_metrics_sum_hourly_mv\b[\s\S]*?;",
            source,
        )[0].replace(" ON CLUSTER 'replicated'", "")
        self.fixture.query("DROP TABLE claude_code.otel_metrics_sum_hourly_mv SYNC", node_index=2)
        try:
            for _ in range(2):
                self.verify_without_writes(False, SCHEMA_VERIFY_ATTEMPTS="1")
            for index in range(3):
                self.assertEqual(self.fixture.rows(
                    "SELECT count() AS rows FROM system.tables WHERE database = 'claude_code' "
                    "AND name = 'otel_metrics_sum_hourly_mv'", node_index=index
                )[0]["rows"], "0" if index == 2 else "1")
        finally:
            self.fixture.query(view, node_index=2)

    def test_unavailable_replica_blocks_without_any_writes(self):
        before = self.snapshot()
        self.fixture.docker("pause", self.fixture.members[2])
        started = time.monotonic()
        try:
            result = self.fixture.runner(SCHEMA_VERIFY_ATTEMPTS="1", SCHEMA_QUERY_TIMEOUT_SECONDS="3")
        finally:
            self.fixture.docker("unpause", self.fixture.members[2])
        self.assertLess(time.monotonic() - started, 15, "Unavailable metadata request exceeded its wall timeout")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("could not connect to expected endpoint", result.stderr)
        self.assertNotIn("bootstrapping", result.stdout)
        self.assertEqual(before, self.snapshot())

    def test_delayed_replica_is_retried_before_readonly_verification(self):
        before = self.snapshot()
        peer = self.fixture.members[2]
        self.fixture.docker("pause", peer)
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(
                self.fixture.runner, SCHEMA_QUERY_TIMEOUT_SECONDS="2",
                SCHEMA_CONNECT_ATTEMPTS="4", SCHEMA_CONNECT_WAIT_SECONDS="25",
            )
            try:
                time.sleep(4)
            finally:
                self.fixture.docker("unpause", peer)
            result = pending.result(timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("waiting for ClickHouse endpoint", result.stderr)
        self.assertIn("verifying existing replicas", result.stdout)
        self.assertNotIn("bootstrapping", result.stdout)
        self.assertEqual(before, self.snapshot())

    def test_different_replica_topology_blocks_without_any_writes(self):
        path = Path(self.fixture.directory.name) / "fixture-2.xml"
        original = path.read_bytes()
        tree = ET.fromstring(original)
        shard = tree.find("./remote_servers/replicated/shard")
        shard.remove(shard.findall("replica")[-1])
        try:
            path.write_bytes(ET.tostring(tree))
            self.fixture.query("SYSTEM RELOAD CONFIG", node_index=2)
            for _ in range(50):
                if self.fixture.rows(
                    "SELECT count() AS rows FROM system.clusters WHERE cluster = 'replicated'", node_index=2
                )[0]["rows"] == "2":
                    break
                time.sleep(0.1)
            else:
                self.fail("The isolated topology fixture did not reload.")
            result = self.verify_without_writes(False, SCHEMA_VERIFY_ATTEMPTS="1")
            self.assertIn("topology differs", result.stderr)
        finally:
            path.write_bytes(original)
            self.fixture.query("SYSTEM RELOAD CONFIG", node_index=2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
