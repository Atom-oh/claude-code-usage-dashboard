#!/usr/bin/env python3
"""Exercise the actual schema runner against a disposable replicated ClickHouse."""

from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import re
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
            )], [2, 3, 4, 5, 6, 7],
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

    def test_cost_view_security_drift_is_rejected_without_repair(self):
        view = "claude_code.codex_cost_events_v1_mv"
        self.fixture.query(f"ALTER TABLE {view} MODIFY SQL SECURITY NONE")
        try:
            result = self.verify_without_writes(False)
            self.assertIn("Codex cost views require explicit definer security", result.stderr)
        finally:
            self.fixture.query(
                f"ALTER TABLE {view} MODIFY DEFINER = CURRENT_USER SQL SECURITY DEFINER"
            )

    def test_zero_timeout_cannot_disable_the_process_deadline(self):
        result = self.verify_without_writes(False, SCHEMA_QUERY_TIMEOUT_SECONDS="00")
        self.assertIn("must be positive integers", result.stderr)

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
                )], [2, 3, 4, 5, 6, 7],
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
