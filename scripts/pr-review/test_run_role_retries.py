"""Retry the real recorder with synthetic CLI replies; no provider calls."""

import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import run_role
import test_role_review as fixture
from test_run_role import fake_kiro_settings


TAGS = ("codex", "claude-self", "kiro-fable", "kiro-sol")
PATHS = ["src/first.py", "src/second.py"]


class RoleRetryTests(unittest.TestCase):
    def run_case(self, tag, replies, attempts=3, preflight="NO_TOOLS"):
        harness = fixture.RoleReviewTests()
        harness.setUp()
        self.addCleanup(harness.tearDown)
        plan = harness.prepare("".join(fixture.patch(path) for path in PATHS))
        replies = replies(harness)
        calls = []

        def execute(command, cwd, environment, input_text, timeout):
            settings = fake_kiro_settings(command, cwd)
            if settings is not None:
                return settings
            if "preflight-canary.txt" in command[2]:
                return 0, preflight, ""
            receipt = harness.read(f"slot/{tag}-request.json")
            prompt = (harness.work / f"requests/{tag}.prompt").read_text()
            payload = (harness.work / f"requests/{tag}.input").read_text()
            nonce = receipt["invocation_nonce"]
            self.assertEqual(payload, f"BEGIN DIFF {nonce}\n{harness.diff.read_text()}\nEND DIFF {nonce}\n")
            self.assertEqual(command[command.index("--model") + 1], plan["roles"][tag]["model"])
            if tag == "codex":
                final = Path(command[command.index("--output-last-message") + 1])
                self.assertEqual(command, [
                    "codex", "exec", "--model", plan["roles"][tag]["model"],
                    "-s", "read-only", "--skip-git-repo-check", "--json",
                    "--output-last-message", str(final), "-",
                ])
                self.assertEqual(input_text, prompt + "\n" + payload)
            elif tag.startswith("kiro-"):
                self.assertEqual(command[1:], [
                    "chat", prompt + "\n" + payload, "--model", plan["roles"][tag]["model"],
                    "--agent", "inline-review", "--no-interactive", "--wrap", "never",
                    "--legacy-ui", "--agent-engine", "v1",
                ])
                self.assertEqual(input_text, "")
            else:
                self.assertEqual(command, [
                    "claude", "-p", prompt, "--model", plan["roles"][tag]["model"],
                    "--output-format", "text", "--strict-mcp-config", "--tools", "",
                ])
                self.assertEqual(input_text, payload)
            self.assertLess(len(calls), len(replies), "Unexpected extra review invocation")
            code, output, error = replies[len(calls)]
            calls.append(receipt)
            if tag == "codex":
                final.write_text(output)
                output = "\n".join(json.dumps(event) for event in [
                    {"type": "turn.started"},
                    {"type": "item.completed", "item": {"type": "agent_message", "text": output}},
                    {"type": "turn.completed"},
                ])
            return code, output, error

        with patch.dict(os.environ, {
            "PANEL_RETRIES": str(attempts), "PANEL_TIMEOUT": "2",
            "KIRO_PREFLIGHT_TIMEOUT": "2",
        }), patch.object(run_role, "execute", side_effect=execute):
            run_role.run(harness.work, tag)
        self.assertEqual(list(harness.root.glob(f"{tag}-response-*")), [])
        return harness, calls, harness.read(f"slot/{tag}-result.json")

    def good(self, harness, tag, **changes):
        return json.dumps(harness.response(tag, **changes))

    def complete_other_roles(self, harness, tag, expected=0):
        for other in TAGS:
            if other != tag:
                harness.record(other)
        harness.cli("aggregate", "--work", harness.work, expected=expected)
        return harness.read("role-summary.json")

    def test_json_and_format_rejections_retry_full_scope_with_fresh_nonces(self):
        for tag in TAGS:
            for failure in ("malformed_json", "unsupported_review_format"):
                with self.subTest(tag=tag, failure=failure):
                    def replies(harness):
                        bad = '{"head_sha":' if failure == "malformed_json" else self.good(
                            harness, tag, checks=[{"path": PATHS[0], "evidence": "Checked `view=detail`."}])
                        return [(0, bad, ""), (0, self.good(harness, tag), "")]
                    harness, calls, result = self.run_case(tag, replies)
                    self.assertTrue(result["valid"], result["failure_codes"])
                    self.assertEqual(len(calls), 2)
                    self.assertNotEqual(calls[0]["invocation_nonce"], calls[1]["invocation_nonce"])
                    for key in ("head_sha", "base_sha", "plan_digest", "prepared_request_digest"):
                        self.assertEqual(calls[0][key], calls[1][key])
                    self.assertNotEqual(calls[0]["request_digest"], calls[1]["request_digest"])
                    self.assertEqual(result["invocation_nonce"], calls[1]["invocation_nonce"])
                    self.assertEqual(result["response"]["reviewed_paths"], PATHS)
                    history = harness.read(f"slot/{tag}-attempts.json")
                    self.assertEqual(len(history), 1)
                    self.assertEqual(history[0]["failure_codes"], [failure])
                    self.assertEqual(history[0]["invocation_nonce"], calls[0]["invocation_nonce"])
                    self.assertIsNone(history[0]["response"])
                    harness.cli("aggregate", "--work", harness.work, expected=2)
                    self.assertEqual(harness.read("role-summary.json")["responded"], [tag])
                    summary = self.complete_other_roles(harness, tag)
                    self.assertEqual(summary["mode"], "deterministic")
                    self.assertEqual(summary["attempt_history"][tag], history)

    def test_exhaustion_keeps_every_attempt_and_blocks_required_coverage(self):
        for tag in TAGS:
            with self.subTest(tag=tag):
                harness, calls, result = self.run_case(
                    tag, lambda h: [(0, '{"head_sha":', "")] * 3 + [(0, self.good(h, tag), "")])
                self.assertEqual(len(calls), 3)
                self.assertFalse(result["valid"])
                self.assertEqual(result["failure_codes"], ["malformed_json"])
                history = harness.read(f"slot/{tag}-attempts.json")
                self.assertEqual(len(history), 2)
                self.assertEqual(len({item["invocation_nonce"] for item in [*history, result]}), 3)
                summary = self.complete_other_roles(harness, tag, expected=2)
                self.assertEqual(summary["mode"], "blocked")
                self.assertNotIn(tag, summary["responded"])
                self.assertIn(f"malformed_json:{tag}", summary["failure_codes"])
                self.assertEqual(summary["attempt_history"][tag], history)

    def test_transport_failure_is_recorded_before_a_successful_retry(self):
        for tag in TAGS:
            with self.subTest(tag=tag):
                harness, calls, result = self.run_case(tag, lambda h: [
                    (7, self.good(h, tag), "Transient execution failure"),
                    (0, self.good(h, tag), ""),
                ])
                self.assertTrue(result["valid"], result["failure_codes"])
                self.assertEqual(len(calls), 2)
                self.assertTrue((harness.work / f"slot/{tag}-attempts.json").is_file(),
                                "A failed transport attempt must remain in history")
                history = harness.read(f"slot/{tag}-attempts.json")
                self.assertEqual(history[0]["failure_codes"], ["cli_nonzero_exit"])
                self.assertIsNone(history[0]["response"])

    def test_terminal_diagnostics_stop_retries_and_survive_manual_reissue(self):
        for tag in TAGS:
            for diagnostic, failure in (
                ("Error: insufficient credits", "quota_diagnostic"),
                ("Falling back to another model", "model_fallback_diagnostic"),
                ("failed to set model", "model_selection_diagnostic"),
            ):
                with self.subTest(tag=tag, failure=failure):
                    harness, calls, result = self.run_case(tag, lambda h: [
                        (0, '{"head_sha":', ""),
                        (0, self.good(h, tag), diagnostic),
                        (0, self.good(h, tag), ""),
                    ])
                    self.assertEqual(len(calls), 2)
                    self.assertFalse(result["valid"])
                    self.assertIn(failure, result["failure_codes"])
                    history = harness.read(f"slot/{tag}-attempts.json")
                    self.assertEqual(history[0]["failure_codes"], ["malformed_json"])
                    harness.cli("issue", "--work", harness.work, "--tag", tag)
                    harness.record(tag)
                    flag = harness.work / f"slot/role-{tag}-terminal.flag"
                    self.assertEqual(flag.read_text().strip(), failure)
                    summary = self.complete_other_roles(harness, tag, expected=2)
                    self.assertEqual(summary["mode"], "blocked")
                    self.assertIn(failure, summary["attempt_history"][tag][-1]["failure_codes"])

    def test_failed_kiro_preflight_records_failure_without_review_input(self):
        for tag in ("kiro-fable", "kiro-sol"):
            with self.subTest(tag=tag):
                harness, calls, result = self.run_case(tag, lambda h: [], preflight="TOOLS_AVAILABLE")
                self.assertEqual(calls, [])
                self.assertFalse(result["valid"])
                self.assertTrue((harness.work / f"slot/kiro-preflight-{tag}.flag").exists())
                self.assertEqual(self.complete_other_roles(harness, tag, expected=2)["mode"], "blocked")

    def test_valid_blocking_findings_and_uncertainty_never_trigger_a_retry(self):
        for tag in TAGS:
            with self.subTest(tag=tag):
                findings = [{
                    "severity": severity, "path": PATHS[0], "condition": "An invalid request arrives.",
                    "evidence": "The changed branch skips validation.",
                } for severity in ("CRITICAL", "MAJOR")]
                uncertainties = ["External deployment was not verified."]
                harness, calls, result = self.run_case(tag, lambda h: [
                    (0, self.good(h, tag, findings=findings, uncertainties=uncertainties), ""),
                    (0, self.good(h, tag), ""),
                ])
                self.assertEqual(len(calls), 1)
                self.assertTrue(result["valid"], result["failure_codes"])
                self.assertEqual(result["response"]["findings"], findings)
                self.assertEqual(result["response"]["uncertainties"], uncertainties)
                self.assertFalse((harness.work / f"slot/{tag}-attempts.json").exists())
                summary = self.complete_other_roles(harness, tag)
                self.assertEqual(summary["mode"], "review")
                self.assertEqual([f["severity"] for f in summary["findings"]], ["CRITICAL", "MAJOR"])

    def test_identity_and_scope_failures_are_not_accepted_as_retry_success(self):
        tag = "claude-self"
        harness, calls, result = self.run_case(tag, lambda h: [
            (0, self.good(h, tag, head_sha="c" * 40), ""),
            (0, self.good(h, tag, reviewed_paths=PATHS[:1]), ""),
            (0, self.good(h, tag), ""),
        ])
        self.assertEqual(len(calls), 3)
        self.assertTrue(result["valid"], result["failure_codes"])
        self.assertEqual(result["response"]["reviewed_paths"], PATHS)
        history = harness.read(f"slot/{tag}-attempts.json")
        self.assertEqual([item["failure_codes"] for item in history],
                         [["response_identity"], ["reviewed_paths"]])


if __name__ == "__main__":
    unittest.main()
