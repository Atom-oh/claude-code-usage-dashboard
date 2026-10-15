import datetime
import importlib.util
import io
import contextlib
import threading
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("capacity_benchmark", ROOT / "scripts/benchmark-capacity.py")
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class CapacityBenchmark(unittest.TestCase):
    def parse(self, *args):
        return benchmark.arguments(["--report", "/tmp/unused-capacity-fixture-report.json",
                                    "--dashboard-image", "fixture@sha256:" + "a"*64, *args])

    def test_defaults_match_bounded_declared_envelope(self):
        args = self.parse()
        self.assertEqual(args.users, 140)
        self.assertEqual(args.requests_per_user, 720)
        self.assertEqual(args.resource_bytes, 2048)
        self.assertIn("@sha256:", args.dashboard_image)

    def test_rejects_invalid_inputs_and_floating_images(self):
        for args in [("--users", "0"), ("--users", "141"),
                     ("--requests-per-user", "1441"), ("--resource-bytes", "32769"),
                     ("--dashboard-image", "fixture:latest"), ("--dashboard-image", "x@sha256:" + "z"*64)]:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.parse(*args)

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
