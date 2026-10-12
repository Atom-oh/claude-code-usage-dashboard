import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("preflight", ROOT / "scripts/install-preflight.py")
PREFLIGHT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREFLIGHT)


class FakeCLI:
    def __init__(self):
        self.calls = []
        self.values = {
            "get-caller-identity": {"Account": "000000000000"},
            "describe-cluster": {"cluster": {
                "arn": "arn:aws:eks:eu-west-1:000000000000:cluster/fixture",
                "status": "ACTIVE", "endpoint": "https://eks.example.invalid",
                "identity": {"oidc": {"issuer": "https://oidc.example.invalid/id/fixture"}},
                "resourcesVpcConfig": {"vpcId": "vpc-00000000000000001"},
            }},
            "config": "https://eks.example.invalid",
            "nodes": {"items": []},
            "crds": {"items": [
                {"metadata": {"name": name}, "spec": {"versions": [{"name": version, "served": True}]}}
                for name, version in PREFLIGHT.CRDS.items()
            ]},
            "storageclass": {"provisioner": "ebs.csi.aws.com"},
            "csidriver": {"metadata": {"name": "ebs.csi.aws.com"}},
            "deployments": {"items": [
                {"metadata": {"generation": 1}, "status": {"observedGeneration": 1,
                 "replicas": 1, "updatedReplicas": 1, "readyReplicas": 1, "availableReplicas": 1},
                 "spec": {"template": {"spec": {
                    "containers": [{"image": image}]}}}}
                for image in ["public.ecr.aws/karpenter/controller:v1",
                              "registry.example.invalid/aws-load-balancer-controller:v2",
                              "registry.example.invalid/clickhouse-operator:v1",
                              "registry.example.invalid/clickhouse-keeper-operator:v1"]
            ]},
            "get-open-id-connect-provider": {
                "Url": "oidc.example.invalid/id/fixture", "ClientIDList": ["sts.amazonaws.com"]},
            "describe-subnets": {"Subnets": [
                {"SubnetId": "subnet-00000000000000001", "State": "available",
                 "AvailableIpAddressCount": 10, "MapPublicIpOnLaunch": False}]},
            "get-role": {"Role": {"RoleName": "customer-role"}},
            "list-roles": {"Roles": [{"RoleName": "eksctl-fixture-nodegroup-NodeInstanceRole-one"}]},
            "list-hosted-zones-by-name": {"HostedZones": [
                {"Name": "example.invalid.", "Config": {"PrivateZone": False}}]},
            "list-certificates": {"CertificateSummaryList": [{"DomainName": "*.example.invalid"}]},
        }

    def __call__(self, command):
        self.calls.append(command)
        if command[0] == "aws":
            key = command[4]
        elif "config" in command:
            key = "config"
        else:
            key = command[command.index("get") + 1]
        value = self.values[key]
        if isinstance(value, Exception):
            raise value
        return value if isinstance(value, str) else json.dumps(value)


class InstallationPreflightTests(unittest.TestCase):
    def setUp(self):
        self.args = argparse.Namespace(
            account_id="000000000000", region="eu-west-1", cluster="fixture",
            context="fixture-context", domain="example.invalid", node_role="customer-role",
            subnet_ids=["subnet-00000000000000001"])
        self.cli = FakeCLI()

    def report(self):
        return PREFLIGHT.check_prerequisites(self.args, self.cli)

    def statuses(self):
        return {item["check"]: item["status"] for item in self.report()["checks"]}

    def test_complete_read_only_fixture_retains_manual_limits(self):
        report = self.report()
        self.assertEqual(len(report["checks"]), 13)
        self.assertTrue(all(item["status"] == "pass" for item in report["checks"]))
        self.assertEqual(report["manual_verification"], PREFLIGHT.MANUAL_CHECKS)
        self.assertFalse(any("secret" in str(command).lower() for command in self.cli.calls))
        self.assertTrue(all(command[0] in ("aws", "kubectl") for command in self.cli.calls))

    def test_wrong_aws_account_stops_before_all_other_lookups(self):
        self.cli.values["get-caller-identity"]["Account"] = "111111111111"
        self.assertEqual(self.statuses(), {"aws_account_matches_expected": "fail"})
        self.assertEqual(len(self.cli.calls), 1)

    def test_wrong_context_skips_kubernetes_api_queries(self):
        self.cli.values["config"] = "https://wrong.example.invalid"
        self.assertEqual(self.statuses()["kubectl_context_matches_eks_endpoint"], "fail")
        self.assertFalse(any("get" in command for command in self.cli.calls if command[0] == "kubectl"))

    def test_inactive_cluster_skips_cluster_dependent_probes(self):
        self.cli.values["describe-cluster"]["cluster"]["status"] = "CREATING"
        self.assertEqual(self.statuses()["eks_cluster_active_in_expected_account"], "fail")
        self.assertFalse(any(command[0] == "kubectl" for command in self.cli.calls))
        self.assertFalse(any("describe-subnets" in command for command in self.cli.calls))

    def test_unavailable_and_malformed_responses_do_not_expose_stderr(self):
        for response in (PREFLIGHT.ProbeError("PRIVATE_STDERR"), "PRIVATE_NON_JSON", []):
            with self.subTest(response=type(response)):
                self.cli.values["describe-subnets"] = response
                report = self.report()
                self.assertIn({"check": "subnet_lookup_available_addresses_and_no_automatic_public_ip",
                               "status": "unavailable"}, report["checks"])
                self.assertNotIn("PRIVATE", json.dumps(report))

    def test_crd_must_serve_required_version(self):
        self.cli.values["crds"]["items"][0]["spec"]["versions"][0]["served"] = False
        self.assertEqual(self.statuses()["required_crd_versions_served"], "fail")

    def test_empty_and_automatic_public_ip_subnets_fail(self):
        self.cli.values["describe-subnets"]["Subnets"] = []
        self.assertEqual(self.statuses()["subnet_lookup_available_addresses_and_no_automatic_public_ip"], "fail")
        self.cli.values["describe-subnets"]["Subnets"] = [{
            "SubnetId": "subnet-00000000000000001", "State": "available",
            "AvailableIpAddressCount": 10, "MapPublicIpOnLaunch": True,
        }]
        self.assertEqual(self.statuses()["subnet_lookup_available_addresses_and_no_automatic_public_ip"], "fail")

    def test_ambiguous_legacy_role_fails(self):
        self.args.node_role = None
        self.cli.values["list-roles"]["Roles"].append({
            "RoleName": "eksctl-fixture-nodegroup-NodeInstanceRole-two"})
        self.assertEqual(self.statuses()["existing_node_role_unambiguous"], "fail")

    def test_unready_controller_hint_fails(self):
        self.cli.values["deployments"]["items"][0]["status"]["availableReplicas"] = 0
        self.assertEqual(self.statuses()["ready_controller_image_hints"], "fail")

    def test_known_combined_altinity_operator_is_a_keeper_hint(self):
        deployments = self.cli.values["deployments"]["items"]
        deployments.pop()
        deployments[2]["spec"]["template"]["spec"]["containers"][0]["image"] = "altinity/clickhouse-operator:0.26.2"
        self.assertEqual(self.statuses()["ready_controller_image_hints"], "pass")
        deployments[2]["spec"]["template"]["spec"]["containers"][0]["image"] = "altinity/clickhouse-operator:0.23.9"
        self.assertEqual(self.statuses()["ready_controller_image_hints"], "fail")

    def test_certificate_uses_us_east_1_and_mirrors_terraform_default_key_filter(self):
        self.report()
        command = next(command for command in self.cli.calls if "list-certificates" in command)
        self.assertEqual(command[2], "us-east-1")
        self.assertNotIn("--includes", command)

    def test_controller_rollout_not_observed_yet_is_not_a_ready_image_hint(self):
        self.cli.values["deployments"]["items"][0]["status"]["observedGeneration"] = 0
        self.assertEqual(self.statuses()["ready_controller_image_hints"], "fail")

    def test_old_available_replica_does_not_establish_updated_template_readiness(self):
        self.cli.values["deployments"]["items"][0]["status"]["replicas"] = 2
        self.assertEqual(self.statuses()["ready_controller_image_hints"], "fail")

    def test_invalid_certificate_shape_is_unavailable_not_a_traceback(self):
        self.cli.values["list-certificates"]["CertificateSummaryList"] = [{"DomainName": None}]
        self.assertEqual(self.statuses()["issued_wildcard_acm_in_us_east_1"], "unavailable")

    def test_invalid_cli_inputs_make_no_calls_or_report(self):
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / "report.json"
            result = subprocess.run([
                "python3", str(ROOT / "scripts/install-preflight.py"),
                "--account-id", "invalid", "--region", "eu-west-1", "--cluster", "fixture",
                "--context", "fixture", "--domain", "example.invalid", "--record", str(record),
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(record.exists())

    def test_invalid_dns_labels_fail_before_lookup(self):
        for domain in ("-bad.example", "example.-bad", "a" * 64 + ".example", "example..invalid"):
            with self.subTest(domain=domain), mock.patch.object(PREFLIGHT.sys, "argv", [
                "preflight", "--account-id", "000000000000", "--region", "eu-west-1",
                "--cluster", "fixture", "--context", "fixture", "--domain", domain,
            ]), mock.patch.object(PREFLIGHT, "check_prerequisites") as probe:
                with self.assertRaises(SystemExit) as error:
                    PREFLIGHT.main()
                self.assertEqual(error.exception.code, 2)
                probe.assert_not_called()

    def test_report_is_private_and_an_existing_report_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / "report.json"
            command = ["preflight", "--account-id", "000000000000", "--region", "eu-west-1",
                       "--cluster", "fixture", "--context", "fixture", "--domain", "example.invalid",
                       "--record", str(record)]
            with mock.patch.object(PREFLIGHT.sys, "argv", command), \
                    mock.patch.object(PREFLIGHT, "check_prerequisites", side_effect=lambda args: {
                        "checks": [{"check": "fixture", "status": "pass"}],
                        "manual_verification": PREFLIGHT.MANUAL_CHECKS,
                    }), redirect_stdout(io.StringIO()):
                self.assertEqual(PREFLIGHT.main(), 0)
                self.assertEqual(record.stat().st_mode & 0o777, 0o600)
                contents = record.read_bytes()
                report = json.loads(contents)
                self.assertEqual(report["requested_target"]["account_id"], "000000000000")
                self.assertEqual(len(report["source_sha256"]), 64)
                self.assertIn("checked_at", report)
                self.assertEqual(PREFLIGHT.main(), 2)
                self.assertEqual(record.read_bytes(), contents)

    def test_failed_report_write_leaves_no_partial_destination_or_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / "report.json"
            with mock.patch.object(PREFLIGHT.json, "dump", side_effect=OSError("synthetic write failure")):
                with self.assertRaises(OSError):
                    PREFLIGHT.write_report(record, {"fixture": True})
            self.assertFalse(record.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_failed_checks_return_nonzero_and_command_errors_are_redacted(self):
        command = ["preflight", "--account-id", "000000000000", "--region", "eu-west-1",
                   "--cluster", "fixture", "--context", "fixture", "--domain", "example.invalid"]
        with mock.patch.object(PREFLIGHT.sys, "argv", command), \
                mock.patch.object(PREFLIGHT, "check_prerequisites", return_value={
                    "checks": [{"check": "fixture", "status": "unavailable"}],
                    "manual_verification": PREFLIGHT.MANUAL_CHECKS,
                }), redirect_stdout(io.StringIO()):
            self.assertEqual(PREFLIGHT.main(), 1)
        with mock.patch.object(PREFLIGHT.subprocess, "run", return_value=argparse.Namespace(
                returncode=1, stdout="", stderr="PRIVATE_CLI_ERROR")):
            with self.assertRaises(PREFLIGHT.ProbeError) as error:
                PREFLIGHT.execute(["fixture"])
            self.assertNotIn("PRIVATE", str(error.exception))


if __name__ == "__main__":
    unittest.main()
