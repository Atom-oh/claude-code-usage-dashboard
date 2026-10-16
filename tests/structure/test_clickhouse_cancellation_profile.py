import re
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ReaderCancellationProfile(unittest.TestCase):
    def setUp(self):
        self.source = (ROOT / "infra/clickhouse.tf").read_text()
        entries = re.findall(r'"(readonly/[^"]+)"\s*=\s*"([^"]+)"', self.source)
        self.assertEqual(len(entries), len(dict(entries)), "duplicate profile keys")
        self.profile = dict(entries)

    def test_disconnect_cancellation_is_enabled_on_the_reader_profile(self):
        self.assertEqual(self.profile["readonly/cancel_http_readonly_queries_on_client_close"], "1")
        self.assertRegex(self.source, r'"otel_reader/profile"\s*=\s*"readonly"')

    def test_readonly_and_execution_backstop_are_retained(self):
        self.assertEqual(self.profile["readonly/readonly"], "1")
        self.assertEqual(self.profile["readonly/max_execution_time"], "60")
        self.assertRegex(self.source, r'"otel_reader/grants/query"\s*=\s*"GRANT SELECT ON claude_code\.\*"')

    def test_dashboard_declares_the_same_reader_user(self):
        deployment = (ROOT / "infra/dashboard.tf").read_text()
        self.assertRegex(deployment, r'env\s*\{\s*name\s*=\s*"CH_USER"\s*value\s*=\s*"otel_reader"\s*\}')
        adapter = (ROOT / "dashboard/server/clickhouse.js").read_text()
        self.assertIn('username: process.env.CH_USER || "default"', adapter)

    def test_memory_result_and_scan_ceilings_are_retained(self):
        self.assertEqual(self.profile["readonly/max_memory_usage"], "4000000000")
        self.assertEqual(self.profile["readonly/max_result_bytes"], "104857600")
        self.assertEqual(self.profile["readonly/max_rows_to_read"], "2000000000")

    def test_documented_cancellation_is_not_claimed_as_deployed_or_hard_bounded(self):
        reference = (ROOT / "docs/reference/api.md").read_text()
        for caveat in [
            "Older installations may still disable",
            "actual dashboard session",
            "HTTP cancellation alone does not establish server-side",
            "neither setting certifies fleet capacity or a hard deadline",
        ]:
            self.assertIn(caveat, reference)


if __name__ == "__main__":
    unittest.main()
