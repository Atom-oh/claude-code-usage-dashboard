"""A body-only Collector adjustment must preserve authentication and measurements."""
import copy
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "collector_bodies", ROOT / "scripts/scrub-collector-log-bodies.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BodyConfigTests(unittest.TestCase):
    def test_changes_only_log_processing_and_is_idempotent(self):
        original = {
            "extensions": {"bearertokenauth": {"token": "${env:PRIVATE_TOKEN}"}},
            "receivers": {"otlp": {"protocols": {"http": {"auth": {
                "authenticator": "bearertokenauth"}}}}},
            "processors": {"filter/logs": {}, "batch": {}},
            "exporters": {"clickhouse": {"password": "${env:PRIVATE_PASSWORD}"}},
            "service": {"extensions": ["bearertokenauth"], "pipelines": {
                "logs": {"receivers": ["otlp"], "processors": ["filter/logs", "batch"],
                         "exporters": ["clickhouse"]},
                "logs/other": {"receivers": ["otlp"], "processors": [],
                               "exporters": ["clickhouse"]},
                "metrics": {"receivers": ["otlp"], "processors": ["batch"],
                            "exporters": ["clickhouse"]},
            }},
        }
        snapshot = copy.deepcopy(original)
        adjusted = module.scrub_log_bodies(original)
        self.assertEqual(original, snapshot)
        self.assertEqual(module.scrub_log_bodies(adjusted), adjusted)
        for key in ["extensions", "receivers", "exporters"]:
            self.assertEqual(adjusted[key], original[key])
        self.assertEqual(adjusted["service"]["pipelines"]["metrics"],
                         original["service"]["pipelines"]["metrics"])
        self.assertEqual(adjusted["service"]["pipelines"]["logs"]["processors"],
                         ["filter/logs", module.PROCESSOR, "batch"])
        self.assertEqual(adjusted["service"]["pipelines"]["logs/other"]["processors"],
                         [module.PROCESSOR])

    def test_conflicting_processor_and_missing_pipelines_fail(self):
        with self.assertRaises(ValueError):
            module.scrub_log_bodies({"service": {"pipelines": {}}})
        with self.assertRaises(ValueError):
            module.scrub_log_bodies({
                "processors": {module.PROCESSOR: {"error_mode": "ignore"}},
                "service": {"pipelines": {"logs": {}}},
            })


if __name__ == "__main__":
    unittest.main()
