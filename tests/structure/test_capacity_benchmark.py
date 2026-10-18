import datetime
import importlib.util
import io
import contextlib
import copy
import threading
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("capacity_benchmark", ROOT / "scripts/benchmark-capacity.py")
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class CapacityBenchmark(unittest.TestCase):
    def parse(self, *args):
        with tempfile.TemporaryDirectory() as directory:
            return benchmark.arguments(["--report", str(Path(directory) / "report.json"),
                                        "--dashboard-image", "fixture@sha256:" + "a"*64, *args])

    def test_defaults_match_bounded_declared_envelope(self):
        args = self.parse()
        self.assertEqual(args.users, 140)
        self.assertEqual(args.requests_per_user, 720)
        self.assertEqual(args.resource_bytes, 2048)
        self.assertIn("@sha256:", args.dashboard_image)
        self.assertIsNone(args.fixture_day)
        self.assertEqual(args.time_format, "compact")

    def test_fixture_day_can_be_frozen_for_paired_runs_and_must_be_closed(self):
        class FixedUtcDateTime(datetime.datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 16, tzinfo=tz)

        with patch.object(benchmark.datetime, "datetime", FixedUtcDateTime):
            for value in ["2026-10-15", "2026-10-14", "2026-09-16"]:
                self.assertEqual(self.parse("--fixture-day", value).fixture_day,
                                 datetime.date.fromisoformat(value))
            for value in ["not-a-date", "2020-02-31", "2026-10-16", "2999-01-01",
                          "2026-09-15", "2020-01-02"]:
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    self.parse("--fixture-day", value)

    def test_rejects_invalid_inputs_and_floating_images(self):
        for args in [("--users", "0"), ("--users", "141"),
                     ("--requests-per-user", "1441"), ("--resource-bytes", "32769"),
                     ("--time-format", "other"),
                     ("--dashboard-image", "fixture:latest"), ("--dashboard-image", "x@sha256:" + "z"*64)]:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.parse(*args)

    def test_time_format_is_recordable_and_requests_match_the_ui(self):
        day = datetime.datetime(2026, 10, 17, tzinfo=datetime.timezone.utc)
        compact = benchmark.overview_path(day, self.parse().time_format)
        expanded = benchmark.overview_path(day, self.parse("--time-format", "expanded").time_format)
        params = benchmark.urllib.parse.parse_qs(compact.split("?", 1)[1])
        self.assertEqual(params["timeFormat"], ["compact"])
        self.assertEqual(params["modelTime"], ["1"])
        self.assertEqual(params["view"], ["cost"])
        self.assertEqual(float(params["intervalHours"][0]), 1/6)
        self.assertNotIn("timeFormat", benchmark.urllib.parse.parse_qs(expanded.split("?", 1)[1]))
        path = benchmark.overview_path(day, "compact", "user-0@fixture.invalid")
        self.assertEqual(benchmark.urllib.parse.parse_qs(path.split("?", 1)[1])["userExact"],
                         ["user-0@fixture.invalid"])

    def compact_fixture(self):
        def table(dimension):
            return {"columns": ["client", "t", dimension, "cost_usd", "observed_tokens",
                                "unpriced_reasons", "cost_basis"],
                    "dictionaries": {"client": ["claude", "codex"], "t": ["2026-10-17T00:00:00Z"],
                                     dimension: ["first", "second"],
                                     "unpriced_reasons": [{"missing_usage": 1}],
                                     "cost_basis": ["reported", "aws_list_estimate"]},
                    "rows": [[0, 0, 0, 0.1, 30, 0, 0], [1, 0, 1, None, 0, None, 1]]}
        return {"time_format": "compact-v1", "by_model_time": table("model"),
                "by_user_time": table("user"), "totals": {"cost_usd": 0.1}}

    def test_compact_semantics_preserve_null_zero_fields_and_dictionary_values(self):
        compact = self.compact_fixture()
        expanded = benchmark.overview_semantics(compact, "compact")
        self.assertEqual(expanded["by_user_time"][0]["cost_usd"], 0.1)
        self.assertEqual(expanded["by_user_time"][1]["cost_usd"], None)
        self.assertEqual(expanded["by_user_time"][1]["observed_tokens"], 0)
        self.assertEqual(expanded["by_user_time"][0]["unpriced_reasons"], {"missing_usage": 1})
        self.assertNotIn("time_format", expanded)
        self.assertTrue(benchmark.matches_overview(compact, expanded, "compact"))
        self.assertTrue(benchmark.matches_overview(expanded, expanded, "expanded"))

    def test_compact_dictionary_and_column_reordering_keeps_semantics(self):
        compact = self.compact_fixture()
        expected = benchmark.overview_semantics(compact, "compact")
        for key in ["by_model_time", "by_user_time"]:
            table = compact[key]
            table["dictionaries"]["client"].reverse()
            for row in table["rows"]:
                row[0] = 1-row[0]
            table["columns"].reverse()
            table["rows"] = [row[::-1] for row in reversed(table["rows"])]
        self.assertTrue(benchmark.matches_overview(compact, expected, "compact"))

    def test_compact_cell_order_is_not_ignored(self):
        compact = self.compact_fixture()
        expected = benchmark.overview_semantics(compact, "compact")
        compact["by_user_time"]["rows"][0][3:5] = [30, 0.1]
        self.assertFalse(benchmark.matches_overview(compact, expected, "compact"))

    def test_compact_numeric_and_population_changes_are_rejected(self):
        original = self.compact_fixture()
        expected = benchmark.overview_semantics(original, "compact")
        for row, column, value in [(1, 3, 0), (1, 4, 1e-15), (0, 3, 0.2), (0, 2, 1)]:
            changed = copy.deepcopy(original)
            changed["by_user_time"]["rows"][row][column] = value
            self.assertFalse(benchmark.matches_overview(changed, expected, "compact"))
        changed = copy.deepcopy(original)
        changed["by_user_time"]["rows"].pop()
        self.assertFalse(benchmark.matches_overview(changed, expected, "compact"))

    def test_compact_malformed_and_wrong_format_payloads_are_rejected(self):
        original = self.compact_fixture()
        expected = benchmark.overview_semantics(original, "compact")
        mutations = [
            lambda table: table["columns"].append("client"),
            lambda table: table["dictionaries"].pop("client"),
            lambda table: table["dictionaries"].update(extra=[]),
            lambda table: table["dictionaries"].update(client=[None]),
            lambda table: table["dictionaries"].update(unpriced_reasons=["bad"]),
            lambda table: table["rows"][0].pop(),
            lambda table: table["rows"][0].__setitem__(0, True),
            lambda table: table["rows"][0].__setitem__(0, -1),
            lambda table: table["rows"][0].__setitem__(0, 0.0),
            lambda table: table["rows"][0].__setitem__(0, 2),
        ]
        for mutate in mutations:
            changed = copy.deepcopy(original)
            mutate(changed["by_user_time"])
            self.assertFalse(benchmark.matches_overview(changed, expected, "compact"))
        for changed in [None, [], {}, {**original, "time_format": "compact-v2"}]:
            self.assertFalse(benchmark.matches_overview(changed, expected, "compact"))
        self.assertFalse(benchmark.matches_overview(original, expected, "expanded"))
        self.assertFalse(benchmark.matches_overview(expected, expected, "compact"))
        self.assertFalse(benchmark.matches_overview({**expected, "by_user_time": {}}, expected, "expanded"))

    def test_empty_compact_tables_preserve_empty_population(self):
        table = {"columns": [], "dictionaries": {}, "rows": []}
        self.assertEqual(benchmark.decode_time_table(table, "user"), [])
        for changed in [[], {**table, "rows": [[]]}]:
            with self.assertRaises(ValueError):
                benchmark.decode_time_table(changed, "user")

    def test_shared_and_every_user_are_checked_across_both_formats(self):
        source = (ROOT / "scripts/benchmark-capacity.py").read_text()
        self.assertIn('"timeFormat": args.time_format', source)
        self.assertIn('"sharedResponseBytes"', source)
        self.assertIn('"compactExpandedSemanticParity": True', source)
        self.assertIn('overview_path(day, other_format, user)', source)
        self.assertIn('"exactUsersWithCompactExpandedSemanticParity"] = args.users', source)
        self.assertIn('matches_overview(', source)

    def test_seed_preserves_cumulative_boundaries_and_complete_usage(self):
        sql = benchmark.seed_sql(datetime.datetime(2026, 10, 14), 140, 24, 2048)
        self.assertIn("fixture.invalid", sql)
        self.assertIn("'response.completed'", sql)
        self.assertIn("'output_token_count','30'", sql)
        self.assertIn("'cache_write_token_count','0'", sql)
        self.assertIn("slot*rate", sql)
        self.assertIn("slot>=8640", sql)
        self.assertIn("'1',", sql)
        self.assertIn("INTERVAL 4 DAY", sql)
        self.assertNotIn("atomai.click", sql)

    def test_semantics_ignore_row_order_and_small_float_noise(self):
        first = [{"user": "a", "cost": 0.1}, {"user": "b", "cost": 0.2}]
        second = [{"user": "b", "cost": 0.2}, {"user": "a", "cost": 0.10000000000000002}]
        self.assertTrue(benchmark.equivalent(first, second))

    def test_semantics_preserve_zero_null_tiny_amounts_and_population(self):
        for first, second in [(None, 0), (0.0, 1e-15), (False, 0),
                              ([{"user": "a"}], [{"user": "b"}]),
                              ({"cost": 0.1}, {"cost": 0.2}), ([1, 2], [1])]:
            self.assertFalse(benchmark.equivalent(first, second))

    def test_exact_user_baseline_retains_both_clients_and_shared_amounts(self):
        rows = [{"client": "claude", "user": "a", "cost": 0.1},
                {"client": "codex", "user": "a", "cost": None},
                {"client": "codex", "user": "b", "cost": 0.2}]
        shared = {"by_user": rows}
        self.assertTrue(benchmark.exact_user_baseline({"by_user": rows[:2][::-1]}, shared, "a"))
        for actual in [{}, {"by_user": []}, {"by_user": rows[:1]},
                       {"by_user": rows},
                       {"by_user": [rows[0], {**rows[1], "cost": 0}]}]:
            self.assertFalse(benchmark.exact_user_baseline(actual, shared, "a"))

    def test_admission_rejection_is_distinct_from_success_and_failure(self):
        result = benchmark.summarize([
            {"status": 200, "elapsedMs": 10, "semanticMatch": True},
            {"status": 503, "elapsedMs": 2, "capacityRejected": True},
            {"status": 500, "elapsedMs": 40}])
        self.assertEqual(result["successfulSemanticChecks"], 1)
        self.assertEqual(result["capacityRejections"], 1)
        self.assertEqual(result["unexpectedResponses"], 1)
        self.assertEqual(result["p95Ms"], 40)

    def test_transport_only_accepts_private_fixture_backends(self):
        proxy = (ROOT / "scripts/capacity-proxy.mjs").read_text()
        self.assertIn("invalid private benchmark targets", proxy)
        self.assertIn('request.url.startsWith("//")', proxy)
        self.assertNotIn("process.env.CH_URL", proxy)

    def test_cleanup_requires_owned_resource_labels(self):
        source = (ROOT / "scripts/benchmark-capacity.py").read_text()
        self.assertIn('self.owned("container", name)', source)
        self.assertIn('self.owned("volume", volume)', source)
        self.assertIn('self.owned("network", self.network)', source)
        self.assertIn('"--internal"', source)
        self.assertNotIn("AUTH_ALLOW_INSECURE", source)

    def test_cached_database_is_frozen_and_default_account_is_loopback_only(self):
        source = (ROOT / "scripts/benchmark-capacity.py").read_text()
        self.assertIn('self.clickhouse_image = database["Id"]', source)
        self.assertIn('self.clickhouse_image)', source)
        self.assertIn('record["clickhouseImage"] = stack.clickhouse_image', source)
        self.assertIn('<default><networks replace="replace"><ip>127.0.0.1</ip><ip>::1</ip>', source)
        self.assertIn("dashboard image must identify a full Git revision", source)
        self.assertIn("readiness healthcheck", source)

    def test_product_retry_uses_actual_module_and_owned_fixture(self):
        source = (ROOT / "scripts/capacity-client.mjs").read_text()
        self.assertIn('from "/capacity-api.mjs"', source)
        self.assertIn("fetchWithCapacityRetry", source)
        self.assertIn("data.runId", source)
        self.assertIn('"/api/clients/overview?"', source)
        self.assertNotIn("CH_URL", source)

    def test_projection_is_explicit_and_only_targets_owned_synthetic_tables(self):
        self.assertFalse(self.parse().fixture_user_projection)
        self.assertTrue(self.parse("--fixture-user-projection").fixture_user_projection)
        source = (ROOT / "scripts/benchmark-capacity.py").read_text()
        self.assertIn("SELECT Timestamp, ResourceAttributes, LogAttributes, EventName, UserEmail, EndUserId", source)
        self.assertIn('"syntheticUserProjection": args.fixture_user_projection', source)

    def test_resource_observer_records_samples_and_stops_on_failure(self):
        sampled = threading.Event()
        observers = []
        class FakeStack:
            def sample(self):
                observers.append(threading.current_thread())
                sampled.set()
                return [{"CPUPerc": "10%", "MemPerc": "20%"}]
        with self.assertRaisesRegex(RuntimeError, "fixture failure"):
            with benchmark.observe_usage(FakeStack()) as samples:
                self.assertTrue(sampled.wait(timeout=1))
                raise RuntimeError("fixture failure")
        self.assertEqual(samples[0]["containers"][0]["CPUPerc"], "10%")
        self.assertTrue(observers)
        self.assertTrue(all(not observer.is_alive() for observer in observers))


if __name__ == "__main__":
    unittest.main()
