"""Bounded chair summaries are evidence, never coverage waivers."""

import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import role_review
import aws_summary
import test_aws_scope_roles as scope
import test_role_review as protocol


class AwsSummaryTests(unittest.TestCase):
    setUp = scope.AwsScopeTests.setUp
    cli = scope.AwsScopeTests.cli
    prepare = scope.AwsScopeTests.prepare
    read = protocol.RoleReviewTests.read
    response = protocol.RoleReviewTests.response
    record = protocol.RoleReviewTests.record

    def large_plan(self):
        return self.prepare(scope.patch("infra/main.tf", after="x" * 100000))

    def packet(self, plan):
        units = aws_summary.units((self.work / "roles/kiro-fable.diff").read_text(),
                                  plan["provenance"].get("path_only", []))
        entries = []
        for unit in units:
            lines = unit["source"].splitlines()
            number = next((i for i, line in enumerate(lines, 1)
                           if line.startswith(("+", "-"))), 1)
            entries.append({
                "id": unit["id"], "sha256": unit["sha256"],
                "summary": "Review the changed resource value and deployment consequences.",
                "evidence": [{"line": number, "excerpt": lines[number - 1][:80]}],
            })
        return {
            "head_sha": plan["head_sha"],
            "source_sha256": plan["roles"]["kiro-fable"]["diff_sha256"],
            "complete": True, "entries": entries, "uncertainties": [],
        }

    def store(self, plan, packet=None):
        packet = packet or self.packet(plan)
        aws_summary.store(self.work, plan, packet, "configured-chair")
        return packet

    def test_large_aws_input_requires_summary_but_keeps_full_raw_evidence(self):
        plan = self.large_plan()
        self.assertTrue(plan["input_complete"])
        self.assertEqual(plan["roles"]["kiro-fable"]["input_basis"], "chair_summary")
        self.assertEqual(plan["roles"]["codex"]["input_basis"], "raw_diff")
        self.assertEqual((self.work / "roles/codex.diff").read_bytes(),
                         (self.work / "roles/kiro-fable.diff").read_bytes())
        with self.assertRaises(role_review.Invalid):
            role_review.issue_request(self.work, "kiro-fable")
        role_review.issue_request(self.work, "codex")

    def test_one_summary_is_bound_to_both_kiro_requests(self):
        plan = self.large_plan()
        packet = self.store(plan)
        for tag in ("kiro-fable", "kiro-sol"):
            nonce, instruction, delivered = role_review.issue_request(self.work, tag)
            receipt = role_review.issued_request(self.work, plan, tag)
            self.assertEqual(receipt["summary_sha256"], role_review.digest(packet))
            self.assertIn("chair summary", instruction.lower())
            self.assertNotIn("x" * 1000, delivered)
            self.assertIn("Review the changed resource value", delivered)
            self.assertLess(len((instruction + "\n" + delivered).encode()), 120000)

    def test_summary_is_created_when_only_deployment_framing_exceeds_budget(self):
        self.context.write_text("x" * 24000)
        raw = scope.patch("infra/main.tf", after="x")
        self.prepare(raw)
        body = (self.work / "roles/kiro-fable.txt").read_text()
        instruction, payload = role_review.frame_request(body, raw, "0" * 32)
        padding = 119999 - len((instruction + "\n" + payload).encode())
        plan = self.prepare(scope.patch("infra/main.tf", after="x" * (padding + 1)))
        self.assertEqual(plan["roles"]["kiro-fable"]["input_basis"], "raw_diff")
        self.assertEqual(plan["roles"]["kiro-sol"]["input_basis"], "chair_summary")
        with patch.object(aws_summary, "execute",
                          return_value=(0, json.dumps(self.packet(plan)), "")) as execute:
            self.assertTrue(aws_summary.summarize(self.work))
            self.assertEqual(execute.call_count, 1)
        for tag in ("kiro-fable", "kiro-sol"):
            role_review.issue_request(self.work, tag)
        self.assertNotIn("summary_sha256",
                         role_review.issued_request(self.work, plan, "kiro-fable"))
        self.assertIn("summary_sha256",
                      role_review.issued_request(self.work, plan, "kiro-sol"))

    def test_missing_or_invented_unit_blocks(self):
        plan = self.large_plan()
        packet = self.packet(plan)
        for entries in (packet["entries"][1:],
                        packet["entries"] + [copy.deepcopy(packet["entries"][0])]):
            changed = dict(packet, entries=entries)
            with self.assertRaises(role_review.Invalid):
                aws_summary.validate(plan, (self.work / "roles/kiro-fable.diff").read_text(), changed)

    def test_fabricated_evidence_and_incomplete_summary_block(self):
        plan = self.large_plan()
        packet = self.packet(plan)
        for change in ("evidence", "incomplete", "hash", "head"):
            changed = copy.deepcopy(packet)
            if change == "evidence":
                changed["entries"][0]["evidence"][0]["excerpt"] = "invented AWS resource"
            elif change == "incomplete":
                changed["complete"] = False
            elif change == "hash":
                changed["entries"][0]["sha256"] = "0" * 64
            else:
                changed["head_sha"] = "c" * 40
            with self.subTest(change=change), self.assertRaises(role_review.Invalid):
                aws_summary.validate(plan, (self.work / "roles/kiro-fable.diff").read_text(), changed)

    def test_utf8_packet_budget_and_mutated_summary_receipt_block(self):
        plan = self.large_plan()
        packet = self.packet(plan)
        packet["entries"][0]["summary"] = "é" * 33000
        with self.assertRaises(role_review.Invalid):
            self.store(plan, packet)
        self.store(plan)
        role_review.issue_request(self.work, "kiro-fable")
        artifact = json.loads((self.work / "aws-summary.json").read_text())
        artifact["packet"]["entries"][0]["summary"] = "A different summary."
        artifact["packet_sha256"] = role_review.digest(artifact["packet"])
        (self.work / "aws-summary.json").write_text(json.dumps(artifact))
        with self.assertRaises(role_review.Invalid):
            role_review.issued_request(self.work, plan, "kiro-fable")

    def test_repreparation_invalidates_summary_even_for_same_diff(self):
        plan = self.large_plan()
        self.store(plan)
        self.large_plan()
        self.assertFalse((self.work / "aws-summary.json").exists())

    def test_summary_failure_withholds_kiro_but_full_review_can_run(self):
        plan = self.large_plan()
        with patch.object(aws_summary, "execute", return_value=(9, "", "provider failed")):
            self.assertFalse(aws_summary.summarize(self.work))
        self.assertFalse((self.work / "aws-summary.json").exists())
        role_review.issue_request(self.work, "claude-self")
        self.cli("aggregate", "--work", self.work, expected=2)
        self.assertEqual((self.work / "chair-mode.txt").read_text().strip(), "blocked")

    def test_small_aws_scope_skips_chair(self):
        self.prepare(scope.patch("infra/main.tf"))
        with patch.object(aws_summary, "execute") as execute:
            self.assertTrue(aws_summary.summarize(self.work))
            execute.assert_not_called()

    def test_chair_receives_full_scope_stdin_and_isolated_environment(self):
        plan = self.large_plan()
        calls = []

        def execute(command, cwd, env, stdin, timeout):
            calls.append((command, cwd, env, stdin, timeout))
            self.assertNotIn("GH_TOKEN", env)
            self.assertNotIn("KIRO_API_KEY", env)
            self.assertNotIn("AWS_ACCESS_KEY_ID", env)
            self.assertNotEqual(env["HOME"], str(Path.home()))
            self.assertNotEqual(cwd, Path.cwd())
            self.assertIn("x" * 100000, stdin)
            self.assertEqual(command[command.index("--tools") + 1], "")
            self.assertIn("--strict-mcp-config", command)
            return 0, json.dumps(self.packet(plan)), ""

        with patch.object(aws_summary, "execute", side_effect=execute):
            self.assertTrue(aws_summary.summarize(self.work))
        self.assertEqual(len(calls), 1)

    def test_diagnostic_words_inside_packet_are_review_evidence(self):
        plan = self.large_plan()
        packet = self.packet(plan)
        packet["entries"][0]["summary"] = "Changed recovery behavior for AccessDeniedException."
        with patch.object(aws_summary, "execute", return_value=(0, json.dumps(packet), "")) as execute:
            self.assertTrue(aws_summary.summarize(self.work))
            self.assertEqual(execute.call_count, 1)

    def test_summary_uncertainty_requires_chair_even_when_all_roles_are_clean(self):
        plan = self.large_plan()
        packet = self.packet(plan)
        packet["uncertainties"] = ["The lifecycle consequence needs further adjudication."]
        self.store(plan, packet)
        for tag, role in plan["roles"].items():
            if role["required"]:
                self.record(tag)
        self.cli("aggregate", "--work", self.work)
        summary = self.read("role-summary.json")
        self.assertEqual(summary["mode"], "review")
        self.assertEqual(summary["uncertainties"], [{
            "tag": "aws-chair-summary", "text": packet["uncertainties"][0],
        }])

    def test_changed_trusted_context_blocks_before_summary_provider(self):
        self.large_plan()
        (self.work / "project-context.md").write_text("A substituted contract.")
        with patch.object(aws_summary, "execute") as execute:
            with self.assertRaises(role_review.Invalid):
                aws_summary.summarize(self.work)
            execute.assert_not_called()

    def test_verified_metadata_only_deletion_is_accounted_for(self):
        raw = scope.patch("infra/main.tf", after="x" * 100000) + (
            "diff --git a/infra/old.tf b/infra/old.tf\n"
            "deleted file mode 100644\nindex 1234567..0000000\n")
        source = self.root / "source.diff"
        source.write_text(raw)
        provenance = self.root / "provenance.json"
        provenance.write_text(json.dumps({
            "head_sha": scope.HEAD, "base_sha": scope.BASE,
            "diff_sha256": role_review.digest(raw.encode()),
            "path_only": ["infra/old.tf"],
        }))
        self.cli("prepare", "--diff", source, "--context", self.context,
                 "--head", scope.HEAD, "--base", scope.BASE, "--work", self.work,
                 "--provenance", provenance)
        plan = self.read("role-plan.json")
        packet = self.store(plan)
        self.assertEqual(len(packet["entries"]), 3)
        role_review.issue_request(self.work, "kiro-sol")


if __name__ == "__main__":
    unittest.main()
