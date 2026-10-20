"""Source contracts; these do not prove live EKS access or token refresh."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class EksProviderAuthentication(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (ROOT / "infra/providers.tf").read_text()
        cls.providers = {}
        for name in ("kubernetes", "kubectl"):
            matches = re.findall(
                rf'^provider "{name}" \{{\n(.*?)^\}}',
                cls.source,
                re.MULTILINE | re.DOTALL,
            )
            if len(matches) != 1:
                raise AssertionError(f"Expected one {name} provider")
            cls.providers[name] = matches[0]

    def test_both_providers_use_refreshable_cli_credentials(self):
        expected_args = [
            '"eks"', '"get-token"', '"--cluster-name"', "var.eks_cluster_name",
            '"--region"', "var.region", '"--output"', '"json"',
        ]
        for name, provider in self.providers.items():
            with self.subTest(provider=name):
                self.assertEqual(len(re.findall(r"\bexec\s*\{", provider)), 1)
                self.assertRegex(provider, r'api_version\s*=\s*"client.authentication.k8s.io/v1beta1"')
                self.assertRegex(provider, r'command\s*=\s*"aws"')
                args = re.search(r"\bargs\s*=\s*\[([^\]]*)\]", provider)
                self.assertIsNotNone(args)
                self.assertEqual([arg.strip() for arg in args[1].split(",")], expected_args)
                self.assertRegex(provider, r'AWS_PAGER\s*=\s*""')
                self.assertRegex(provider, r'AWS_CLI_AUTO_PROMPT\s*=\s*"off"')

    def test_no_static_cluster_auth_data_or_competing_credentials(self):
        for path in (ROOT / "infra").glob("*.tf"):
            with self.subTest(path=path.name):
                self.assertNotIn("aws_eks_cluster_auth", path.read_text())
        for name, provider in self.providers.items():
            with self.subTest(provider=name):
                self.assertNotRegex(
                    provider,
                    r"(?m)^\s*(token|username|password|client_certificate|client_key|config_path|config_paths)\s*=",
                )

    def test_cluster_endpoint_and_ca_remain_explicit(self):
        for name, provider in self.providers.items():
            with self.subTest(provider=name):
                self.assertRegex(provider, r"host\s*=\s*data\.aws_eks_cluster\.this\.endpoint")
                self.assertRegex(
                    provider,
                    r"cluster_ca_certificate\s*=\s*base64decode\(data\.aws_eks_cluster\.this\.certificate_authority\[0\]\.data\)",
                )
                self.assertNotRegex(provider, r"(?m)^\s*insecure\s*=")
        self.assertRegex(self.providers["kubectl"], r"load_config_file\s*=\s*false")

    def test_runtime_auth_and_partial_apply_limits_are_documented(self):
        reference = (ROOT / "docs/reference/iac.md").read_text()
        for text in (
            "both** the plan and apply runners",
            "same intended AWS",
            "expired AWS session",
            "Old saved plans retain their old configuration",
            "KUBE_TOKEN",
        ):
            self.assertIn(text, reference)
        runbook = (ROOT / "docs/runbooks/deploy-production.md").read_text()
        self.assertIn("AWS resources may have changed", runbook)
        self.assertIn("Never infer that a failed apply made", runbook)


if __name__ == "__main__":
    unittest.main()
