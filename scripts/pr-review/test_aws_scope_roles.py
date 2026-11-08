"""Verify complete AWS projections, independent coverage and transport budgets."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ENGINE = Path(__file__).with_name("role_review.py")
HEAD = "a" * 40
BASE = "b" * 40


def patch(path, before="old", after="new"):
    return (f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n"
            f"@@ -1 +1 @@\n-{before}\n+{after}\n")


class AwsScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / "work"
        self.context = self.root / "context"
        self.context.write_text("Trusted base requirements.\n")

    def cli(self, *args, expected=0):
        result = subprocess.run([sys.executable, str(ENGINE), *map(str, args)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def prepare(self, raw, expected=0):
        source = self.root / "source.diff"
        source.write_bytes(raw.encode())
        self.cli("prepare", "--diff", source, "--context", self.context,
                 "--head", HEAD, "--base", BASE, "--work", self.work, expected=expected)
        return json.loads((self.work / "role-plan.json").read_text())

    def test_mixed_change_delivers_only_complete_infra_patch_to_kiro(self):
        app = patch("dashboard/server/chat.js", after='const retry = "bedrock";')
        infra = patch("infra/bedrock.tf", after='resource "aws_iam_role" "chat" {}')
        plan = self.prepare(app + infra)
        for tag in ("codex", "claude-self"):
            self.assertEqual((self.work / "roles" / f"{tag}.diff").read_text(), app + infra)
            self.assertEqual(plan["roles"][tag]["paths"],
                             ["dashboard/server/chat.js", "infra/bedrock.tf"])
        for tag in ("kiro-fable", "kiro-sol"):
            role = plan["roles"][tag]
            self.assertTrue(role["required"])
            self.assertEqual(role["paths"], ["infra/bedrock.tf"])
            self.assertEqual((self.work / "roles" / f"{tag}.diff").read_text(), infra)
            self.assertEqual(role["diff_sha256"], hashlib.sha256(infra.encode()).hexdigest())
            self.assertNotIn("dashboard/server/chat.js",
                             (self.work / "roles" / f"{tag}.txt").read_text())

    def test_application_sdk_and_unknown_files_do_not_activate_kiro(self):
        for path, after in (
            ("dashboard/server/chat.js", 'import { ConverseCommand } from "@aws-sdk/client-bedrock";'),
            ("dashboard/web/src/Analytics.jsx", 'const label = "AWS us-west-2 retry schema";'),
            ("misc/unknown.xyz", "new application data"),
            ("app/src/app/page.tsx", "new page"),
            ("dashboard/server/client.py", 'aws_region = "us-east-1"; aws_client = client'),
            ("dashboard/server/model.js", 'const model = "arn:aws:bedrock:us-east-1::foundation-model/example";'),
            ("dashboard/web/src/charts/Usage.jsx", "export const Usage = () => null;"),
            ("dashboard/web/src/manifests/app.webmanifest", '{"name": "Usage"}'),
        ):
            with self.subTest(path=path):
                plan = self.prepare(patch(path, after=after))
                self.assertEqual({tag for tag, role in plan["roles"].items() if role["required"]},
                                 {"codex", "claude-self"})

    def test_architecture_resource_and_aws_operation_paths_activate_kiro(self):
        for path, content in (
            ("docs/architecture.md", "service boundaries"),
            ("docs/decisions/ADR-999.md", "ECS IAM topology"),
            ("docs/runbooks/deploy-production.md", "aws ecs update-service"),
            ("deployment/stack.yaml", "Type: AWS::S3::Bucket"),
            ("lib/stack.ts", 'import { Stack } from "aws-cdk-lib";'),
            ("infra/main.tf", "removed resource"),
            ("env/terragrunt.hcl", "inputs = {}"),
            ("service/serverless.yml", "memorySize: 256"),
            ("service/serverless.ts", "memorySize: 256"),
            ("service/samconfig.toml", "region = \"us-east-1\""),
            ("charts/app/values.yaml", "replicaCount: 2"),
            ("charts/app/templates/deployment.yaml", "replicaCount: 2"),
            ("manifests/deployment.yaml", "replicas: 2"),
            ("appspec.yml", "version: 0.0"),
            ("buildspec.yml", "version: 0.2"),
            (".aws/task-definition.json", '{"memory": "512"}'),
        ):
            with self.subTest(path=path):
                plan = self.prepare(patch(path, after=content))
                self.assertTrue(plan["roles"]["kiro-fable"]["required"])
                self.assertTrue(plan["roles"]["kiro-sol"]["required"])

    def test_removed_resources_and_renamed_infra_cannot_escape_scope(self):
        removed = patch("lib/stack.ts", before='import { Stack } from "aws-cdk-lib";',
                        after="export const disabled = true;")
        renamed = ("diff --git a/infra/main.tf b/archive/main.txt\n"
                   "similarity index 100%\nrename from infra/main.tf\n"
                   "rename to archive/main.txt\n")
        plan = self.prepare(removed + renamed)
        self.assertEqual(plan["roles"]["kiro-fable"]["paths"],
                         ["archive/main.txt", "lib/stack.ts"])

    def test_deleted_resource_file_remains_required_aws_scope(self):
        raw = ("diff --git a/infra/obsolete.tf b/infra/obsolete.tf\n"
               "deleted file mode 100644\n--- a/infra/obsolete.tf\n+++ /dev/null\n"
               "@@ -1 +0,0 @@\n-resource \"aws_vpc\" \"old\" {}\n")
        plan = self.prepare(raw)
        self.assertEqual(plan["roles"]["kiro-fable"]["paths"], ["infra/obsolete.tf"])
        self.assertEqual((self.work / "roles/kiro-fable.diff").read_text(), raw)

    def test_large_application_diff_is_not_limited_by_kiro_transport(self):
        raw = patch("dashboard/server/large.js", after="x" * 150000)
        plan = self.prepare(raw)
        self.assertTrue(plan["input_complete"])
        self.assertFalse(plan["roles"]["kiro-fable"]["required"])
        self.assertEqual((self.work / "roles/codex.diff").read_text(), raw)

    def test_small_infra_projection_can_accompany_large_application_diff(self):
        app = patch("dashboard/server/large.js", after="x" * 150000)
        infra = patch("infra/main.tf")
        self.assertTrue(self.prepare(app + infra)["input_complete"])
        self.assertEqual((self.work / "roles/kiro-fable.diff").read_text(), infra)

    def test_oversized_infra_requires_summary_and_keeps_the_raw_scope(self):
        infra = patch("infra/main.tf", after="x" * 100000)
        plan = self.prepare(infra)
        self.assertEqual(plan["roles"]["kiro-fable"]["input_basis"], "chair_summary")
        self.assertEqual((self.work / "roles/kiro-fable.diff").read_text(), infra)

    def test_application_line_budget_is_independent_of_kiro_budget(self):
        lines = "".join("+item\n" for _ in range(3500))
        app = ("diff --git a/src/many.js b/src/many.js\n"
               "--- a/src/many.js\n+++ b/src/many.js\n"
               "@@ -0,0 +1,3500 @@\n" + lines)
        self.assertTrue(self.prepare(app)["input_complete"])
        infra = app.replace("src/many.js", "infra/many.tf")
        plan = self.prepare(infra)
        self.assertEqual(plan["roles"]["kiro-fable"]["input_basis"], "chair_summary")
        self.assertEqual((self.work / "roles/kiro-fable.diff").read_text(), infra)

    def test_utf8_aws_budget_counts_bytes(self):
        infra = patch("infra/main.tf", after="é" * 48000)
        plan = self.prepare(infra)
        self.assertEqual(plan["roles"]["kiro-fable"]["input_basis"], "chair_summary")
        self.assertEqual((self.work / "roles/kiro-fable.diff").read_bytes(), infra.encode())

    def test_full_diff_store_cannot_be_modified_after_preparation(self):
        self.prepare(patch("infra/main.tf"))
        (self.work / "complete.diff").write_text(patch("infra/main.tf", after="changed"))
        self.cli("issue", "--work", self.work, "--tag", "codex", expected=2)

    def test_resource_and_operation_identity_does_not_require_hunk_keywords(self):
        for path in ("docs/runbooks/deploy-production.md", "task-definition.json",
                     "template.yaml", "lib/app_stack.py"):
            with self.subTest(path=path):
                plan = self.prepare(patch(path, after="memory: 1024"))
                self.assertTrue(plan["roles"]["kiro-fable"]["required"])
        plan = self.prepare(patch("lib/arbitrary.py", after="from aws_cdk import Stack"))
        self.assertTrue(plan["roles"]["kiro-fable"]["required"])

    def test_full_change_path_list_cannot_omit_application_files(self):
        sys.path.insert(0, str(ENGINE.parent))
        import role_review

        plan = self.prepare(patch("dashboard/server/chat.js") + patch("infra/main.tf"))
        plan["paths"] = ["infra/main.tf"]
        for tag in ("codex", "claude-self"):
            role = plan["roles"][tag]
            role["paths"] = ["infra/main.tf"]
            role["request_digest"] = role_review.request_digest(
                plan, tag, role, (self.work / "roles" / f"{tag}.txt").read_bytes(),
                (self.work / "roles" / f"{tag}.diff").read_bytes())
        plan["plan_digest"] = role_review.digest(
            {key: value for key, value in plan.items() if key != "plan_digest"})
        (self.work / "role-plan.json").write_text(json.dumps(plan))
        self.cli("issue", "--work", self.work, "--tag", "codex", expected=2)

    def test_cloud_pricing_document_alone_is_not_an_architecture_change(self):
        plan = self.prepare(patch("docs/reference/pricing.md", after="Bedrock AWS list pricing"))
        self.assertFalse(plan["roles"]["kiro-fable"]["required"])

    def test_changed_scope_cannot_be_validated_with_recomputed_request_digest(self):
        sys.path.insert(0, str(ENGINE.parent))
        import role_review

        app = patch("dashboard/server/chat.js")
        infra = patch("infra/main.tf")
        plan = self.prepare(app + infra)
        role = plan["roles"]["kiro-fable"]
        role["paths"] = ["dashboard/server/chat.js", "infra/main.tf"]
        (self.work / "roles/kiro-fable.diff").write_text(app + infra)
        role["request_digest"] = role_review.request_digest(
            plan, "kiro-fable", role, (self.work / "roles/kiro-fable.txt").read_bytes(),
            (app + infra).encode())
        plan["plan_digest"] = role_review.digest(
            {key: value for key, value in plan.items() if key != "plan_digest"})
        (self.work / "role-plan.json").write_text(json.dumps(plan))
        self.cli("issue", "--work", self.work, "--tag", "kiro-fable", expected=2)

    def test_required_aws_review_cannot_be_deactivated_by_plan_rewrite(self):
        sys.path.insert(0, str(ENGINE.parent))
        import role_review

        plan = self.prepare(patch("infra/main.tf"))
        plan["roles"]["kiro-fable"]["required"] = False
        plan["roles"]["kiro-fable"]["paths"] = []
        plan["plan_digest"] = role_review.digest(
            {key: value for key, value in plan.items() if key != "plan_digest"})
        (self.work / "role-plan.json").write_text(json.dumps(plan))
        self.cli("aggregate", "--work", self.work, expected=2)
        summary = json.loads((self.work / "role-summary.json").read_text())
        self.assertIn("invalid_plan_scope", summary["failure_codes"])


if __name__ == "__main__":
    unittest.main()
