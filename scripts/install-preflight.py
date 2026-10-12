#!/usr/bin/env python3
"""Read-only prerequisite checks for one customer-owned AWS/EKS installation."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


CRDS = {
    "nodepools.karpenter.sh": "v1",
    "ec2nodeclasses.karpenter.k8s.aws": "v1",
    "clickhouseinstallations.clickhouse.altinity.com": "v1",
    "clickhousekeeperinstallations.clickhouse-keeper.altinity.com": "v1",
}
MANUAL_CHECKS = [
    "Node-role cluster admission, Karpenter IAM permissions and security-group discovery tags",
    "Private subnet effective routes, available addresses and required service reachability",
    "Controller reconciliation, ARM64 capacity and actual gp3 volume provisioning",
    "Terraform state ownership, reviewed plan, service quotas and CloudFront VPC-origin eligibility",
    "Customer IdP, external secrets, collector transport, backup/restore and end-to-end acceptance",
]


class ProbeError(Exception):
    pass


def execute(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20,
                                env={**os.environ, "AWS_PAGER": ""})
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ProbeError("command_unavailable_or_timed_out") from error
    if result.returncode:
        # CLI stderr can contain sensitive context. Keep it out of reports and stdout.
        raise ProbeError("command_failed_check_local_credentials_permissions_and_context")
    return result.stdout


def write_report(path, report):
    # Publish a complete private file atomically, never replacing an existing path.
    descriptor, temporary = tempfile.mkstemp(prefix=".dashboard-preflight-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as file:
            json.dump(report, file, indent=2)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.link(temporary, path)
    finally:
        os.unlink(temporary)


def check_prerequisites(args, run=execute):
    checks = []

    def probe(name, function):
        try:
            ok = function()
            checks.append({"check": name, "status": "pass" if ok else "fail"})
            return ok
        except (ProbeError, ValueError, KeyError, TypeError, IndexError, AttributeError):
            checks.append({"check": name, "status": "unavailable"})
            return False

    def aws(service, operation, *options, region=None):
        value = json.loads(run(["aws", "--region", region or args.region, service,
                                operation, *options, "--output", "json"]))
        if not isinstance(value, dict):
            raise ProbeError("invalid_cli_response")
        return value

    def kube(*options):
        value = json.loads(run(["kubectl", "--context", args.context,
                               "--request-timeout=20s", *options, "-o", "json"]))
        if not isinstance(value, dict):
            raise ProbeError("invalid_cli_response")
        return value

    # Stop before querying a cluster when the operator's AWS account differs.
    caller = {}

    def account():
        caller.update(aws("sts", "get-caller-identity"))
        return caller["Account"] == args.account_id

    if not probe("aws_account_matches_expected", account):
        return {"checks": checks, "manual_verification": MANUAL_CHECKS}

    cluster = {}

    def cluster_active():
        cluster.update(aws("eks", "describe-cluster", "--name", args.cluster)["cluster"])
        return cluster["status"] == "ACTIVE" and cluster["arn"].split(":")[4] == args.account_id

    cluster_ok = probe("eks_cluster_active_in_expected_account", cluster_active)
    if cluster_ok:
        def context_matches():
            endpoint = run(["kubectl", "--context", args.context, "config", "view",
                            "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"]).strip()
            return endpoint.rstrip("/") == cluster["endpoint"].rstrip("/")

        context_ok = probe("kubectl_context_matches_eks_endpoint", context_matches)
        if context_ok:
            probe("kubernetes_api_access", lambda: isinstance(kube("get", "nodes")["items"], list))

            def required_crds():
                definitions = {item["metadata"]["name"]: item for item in kube("get", "crds")["items"]}
                return all(name in definitions and any(
                    version["name"] == required and version.get("served") is True
                    for version in definitions[name]["spec"]["versions"]
                ) for name, required in CRDS.items())

            probe("required_crd_versions_served", required_crds)

            def storage():
                return kube("get", "storageclass", "gp3")["provisioner"] == "ebs.csi.aws.com"

            probe("gp3_ebs_csi_storageclass", storage)

            def csi():
                return kube("get", "csidriver", "ebs.csi.aws.com")["metadata"]["name"] == "ebs.csi.aws.com"

            probe("ebs_csi_driver_registered", csi)

            def controllers():
                deployments = kube("get", "deployments", "--all-namespaces")["items"]
                def rollout_ready(item):
                    status = item.get("status", {})
                    desired = item["spec"].get("replicas", 1)
                    generation = item.get("metadata", {}).get("generation")
                    return (isinstance(generation, int) and desired >= 1 and
                            status.get("observedGeneration") == generation and
                            all(status.get(field) == desired for field in
                                ("replicas", "updatedReplicas", "readyReplicas", "availableReplicas")))
                ready_images = [container.get("image", "") for item in deployments
                                if rollout_ready(item)
                                for container in item["spec"]["template"]["spec"]["containers"]]
                # Package-neutral hints; image names/readiness are not reconciliation proof.
                basic_hints = all(any(re.search(pattern, image) for image in ready_images) for pattern in (
                    r"(^|/)karpenter(/controller|)(:|@)",
                    r"(^|/)aws-load-balancer-controller(:|@)",
                    r"(^|/)clickhouse-operator(:|@)",
                ))
                keeper_hint = any(re.search(r"(^|/)clickhouse-keeper-operator(:|@)", image)
                                  for image in ready_images) or any(re.fullmatch(
                    r"(docker\.io/)?altinity/clickhouse-operator:0\.26\.2(@sha256:[0-9a-f]{64})?",
                    image) for image in ready_images)
                return basic_hints and keeper_hint

            probe("ready_controller_image_hints", controllers)

        def oidc():
            issuer = cluster["identity"]["oidc"]["issuer"]
            partition = cluster["arn"].split(":")[1]
            provider = f"arn:{partition}:iam::{args.account_id}:oidc-provider/{issuer.removeprefix('https://')}"
            value = aws("iam", "get-open-id-connect-provider", "--open-id-connect-provider-arn", provider)
            return value["Url"].removeprefix("https://") == issuer.removeprefix("https://") and "sts.amazonaws.com" in value["ClientIDList"]

        probe("eks_irsa_oidc_provider", oidc)

        def subnets():
            filters = [f"Name=vpc-id,Values={cluster['resourcesVpcConfig']['vpcId']}"]
            filters.append(f"Name=subnet-id,Values={','.join(args.subnet_ids)}" if args.subnet_ids else
                           f"Name=tag:karpenter.sh/discovery,Values={args.cluster}")
            values = aws("ec2", "describe-subnets", "--filters", *filters)["Subnets"]
            found = {item["SubnetId"] for item in values}
            return bool(found) and (not args.subnet_ids or found == set(args.subnet_ids)) and all(
                item["State"] == "available" and item["AvailableIpAddressCount"] > 0 and
                item.get("MapPublicIpOnLaunch") is False for item in values)

        probe("subnet_lookup_available_addresses_and_no_automatic_public_ip", subnets)

    def node_role():
        if args.node_role:
            return aws("iam", "get-role", "--role-name", args.node_role)["Role"]["RoleName"] == args.node_role
        roles = aws("iam", "list-roles")["Roles"]
        pattern = re.compile(f"eksctl-{re.escape(args.cluster)}-nodegroup.*NodeInstanceRole.*")
        return sum(bool(pattern.search(role["RoleName"])) for role in roles) == 1

    probe("existing_node_role_unambiguous", node_role)

    def zone():
        zones = aws("route53", "list-hosted-zones-by-name", "--dns-name", args.domain)["HostedZones"]
        return sum(item["Name"].lower() == args.domain + "." and item["Config"]["PrivateZone"] is False
                   for item in zones) == 1

    probe("single_public_route53_zone", zone)

    def certificate():
        certificates = aws("acm", "list-certificates", "--certificate-statuses", "ISSUED",
                           region="us-east-1")["CertificateSummaryList"]
        return any(item["DomainName"].lower() == "*." + args.domain for item in certificates)

    probe("issued_wildcard_acm_in_us_east_1", certificate)
    return {"checks": checks, "manual_verification": MANUAL_CHECKS}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-id", required=True, help="Expected customer AWS account, 12 digits")
    parser.add_argument("--region", required=True)
    parser.add_argument("--cluster", required=True)
    parser.add_argument("--context", required=True, help="Explicit kubectl context; checked against EKS endpoint")
    parser.add_argument("--domain", required=True, help="Route53 public zone domain")
    parser.add_argument("--node-role")
    parser.add_argument("--subnet-id", dest="subnet_ids", action="append", default=[])
    parser.add_argument("--record", type=Path, help="New private JSON report; never overwrites a file")
    args = parser.parse_args()
    if not (re.fullmatch(r"\d{12}", args.account_id) and
            re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d+", args.region) and
            re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", args.cluster) and
            args.context.strip() and not args.context.startswith("-") and
            len(args.domain) <= 253 and all(re.fullmatch(
                r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in args.domain.split(".")) and
            (args.node_role is None or re.fullmatch(r"[A-Za-z0-9_+=,.@-]{1,64}", args.node_role)) and
            len(args.subnet_ids) == len(set(args.subnet_ids)) and all(
                re.fullmatch(r"subnet-(?:[0-9a-f]{8}|[0-9a-f]{17})", value) for value in args.subnet_ids)):
        parser.error("Invalid non-secret target inputs")
    report = check_prerequisites(args)
    report["checked_at"] = datetime.now(timezone.utc).isoformat()
    report["source_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    report["requested_target"] = {
        "account_id": args.account_id, "region": args.region, "cluster": args.cluster,
        "context": args.context, "domain": args.domain, "node_role": args.node_role,
        "subnet_ids": args.subnet_ids,
    }
    failed = any(item["status"] != "pass" for item in report["checks"])
    report["automated_checks_passed"] = not failed
    for item in report["checks"]:
        print(f"{item['status'].upper()}: {item['check']}")
    print("Manual target verification is required; passing checks do not establish installation readiness.")
    if args.record:
        try:
            write_report(args.record, report)
        except OSError:
            print("Could not create the new private report", file=sys.stderr)
            return 2
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
