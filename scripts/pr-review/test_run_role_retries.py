"""Retry the real recorder with synthetic CLI replies; no provider calls."""

import contextlib
import io
import json
import os
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import patch

import role_review
import run_role
import test_role_review as fixture
from test_run_role import fake_kiro_settings


TAGS = ("codex", "claude-self", "kiro-fable", "kiro-sol")
PATHS = ["src/first.py", "src/second.py"]
TIMEOUT = (124, "", "\nReview CLI timed out.")
PASS = (0, "NO_TOOLS", "")


class RoleRetryTests(unittest.TestCase):
    COHORT = "0123456789abcdef" * 2

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

    def fresh_harness(self):
        harness = fixture.RoleReviewTests()
        harness.setUp()
        self.addCleanup(harness.tearDown)
        harness.prepare("".join(fixture.patch(path) for path in PATHS))
        return harness

    def peer_receipt(self, harness, peer, ok):
        plan = harness.read("role-plan.json")
        role_review.write_json(harness.work / "slot" / f"{peer}-preflight.json", {
            "cohort": self.COHORT, "plan_digest": plan["plan_digest"], "tag": peer,
            "model": plan["roles"][peer]["model"], "ok": ok,
        })

    def run_preflight(self, harness, tag, canaries, **env):
        """Run one Kiro role with scripted canary replies; count every CLI call.

        Each canary entry is a (code, stdout, stderr) tuple, or a callable taking the
        attempt's cwd and returning one.
        """
        calls = {"settings": 0, "budgets": [], "tokens": [], "reviews": 0}

        def execute(command, cwd, environment, input_text, timeout):
            settings = fake_kiro_settings(command, cwd)
            if settings is not None:
                calls["settings"] += 1
                return settings
            if "preflight-canary.txt" in command[2]:
                # No preflight attempt may carry PR input.
                self.assertEqual(input_text, "")
                self.assertNotIn("BEGIN DIFF", command[2])
                self.assertNotIn(harness.diff.read_text(), command[2])
                self.assertLess(len(calls["budgets"]), len(canaries),
                                "Unexpected extra preflight attempt")
                calls["tokens"].append((Path(cwd) / "preflight-canary.txt").read_text())
                reply = canaries[len(calls["budgets"])]
                calls["budgets"].append(timeout)
                return reply(Path(cwd)) if callable(reply) else reply
            calls["reviews"] += 1
            self.assertIn("BEGIN DIFF", command[2])
            return 0, json.dumps(harness.response(tag)), ""

        variables = {"PANEL_RETRIES": "2", "PANEL_TIMEOUT": "2",
                     "KIRO_PREFLIGHT_TIMEOUT": "2", **env}
        output = io.StringIO()
        with patch.dict(os.environ, variables), \
                patch.object(run_role, "execute", side_effect=execute), \
                contextlib.redirect_stdout(output):
            if "KIRO_PREFLIGHT_COHORT" not in env:
                os.environ.pop("KIRO_PREFLIGHT_COHORT", None)
            started = time.monotonic()
            run_role.run(harness.work, tag)
            calls["elapsed"] = time.monotonic() - started
        calls["stdout"] = output.getvalue().splitlines()
        return calls, harness.read(f"slot/{tag}-result.json")

    def flag_text(self, harness, tag):
        return (harness.work / f"slot/kiro-preflight-{tag}.flag").read_text()

    def test_kiro_preflight_timeout_then_success_runs_the_review(self):
        for tag in ("kiro-fable", "kiro-sol"):
            with self.subTest(tag=tag):
                harness = self.fresh_harness()
                calls, result = self.run_preflight(harness, tag, [TIMEOUT, PASS])
                self.assertTrue(result["valid"], result["failure_codes"])
                self.assertEqual(result["failure_codes"], [])
                self.assertEqual(calls["reviews"], 1)
                self.assertEqual(len(calls["budgets"]), 2)
                # Each attempt re-runs both settings steps and writes a fresh canary.
                self.assertEqual(calls["settings"], 4)
                self.assertEqual(len(set(calls["tokens"])), 2)
                # Each attempt has its own full 2 s budget (measured about 1.99 s).
                for budget in calls["budgets"]:
                    self.assertGreater(budget, 1.5)
                self.assertTrue(any(
                    line.startswith(f"{tag}: preflight attempt 1/2 timed out after ")
                    and line.endswith("s; retrying") for line in calls["stdout"]
                ), calls["stdout"])
                self.assertIn(f"{tag}: preflight attempt 2/2 passed", calls["stdout"])
                self.assertFalse((harness.work / f"slot/kiro-preflight-{tag}.flag").exists())

    def test_kiro_preflight_timeout_on_every_attempt_blocks_without_pr_input(self):
        for tag in ("kiro-fable", "kiro-sol"):
            for env, attempts in (({}, 2), ({"KIRO_PREFLIGHT_ATTEMPTS": "3"}, 3)):
                with self.subTest(tag=tag, attempts=attempts):
                    harness = self.fresh_harness()
                    calls, result = self.run_preflight(harness, tag, [TIMEOUT] * attempts, **env)
                    self.assertEqual(result["failure_codes"], ["kiro_preflight_timeout"])
                    self.assertFalse(result["valid"])
                    self.assertEqual(calls["reviews"], 0)
                    self.assertEqual(len(calls["budgets"]), attempts)
                    self.assertEqual(calls["settings"], 2 * attempts)
                    sentence = (f"Kiro startup timed out in all {attempts} preflight attempts; "
                                "PR input withheld.")
                    self.assertEqual(self.flag_text(harness, tag), sentence + "\n")
                    error = (harness.work / f"runtime/{tag}.err").read_text().strip()
                    self.assertEqual(error.splitlines()[-1], sentence)
                    last = calls["stdout"][-1]
                    self.assertTrue(last.startswith(f"{tag}: finished in "), last)
                    self.assertTrue(last.endswith("(exit 124)"), last)
                    self.assertTrue(any(
                        line.startswith(f"{tag}: preflight attempt {attempts}/{attempts} ")
                        and line.endswith("s; PR input withheld") for line in calls["stdout"]
                    ), calls["stdout"])
                    if attempts == 2:
                        summary = self.complete_other_roles(harness, tag, expected=2)
                        self.assertEqual(summary["mode"], "blocked")
                        self.assertIn(f"kiro_preflight_timeout:{tag}", summary["failure_codes"])
                        self.assertIn("upstream_preflight_flag", summary["failure_codes"])
                        self.assertNotIn(f"cli_nonzero_exit:{tag}", summary["failure_codes"])

    def test_kiro_preflight_safety_failure_is_never_retried(self):
        tag = "kiro-sol"

        def exposed(cwd):
            return 1, (cwd / "preflight-canary.txt").read_text(), ""

        for first, codes, code in (
            ((0, "NO_TOOLS", "using tool: fs_read"), ["cli_nonzero_exit"], 1),
            ((0, "TOOLS_AVAILABLE", ""), ["cli_nonzero_exit"], 0),
            ((124, "", "Monthly request limit reached"), ["cli_nonzero_exit", "quota_diagnostic"], 124),
            ((1, "", "Error: insufficient credits"), ["cli_nonzero_exit", "quota_diagnostic"], 1),
            ((0, "NO_TOOLS", "[warn] failed to set model: Method not found"),
             ["cli_nonzero_exit", "model_selection_diagnostic"], 1),
            # The canary token was exposed despite a nonzero exit.
            (exposed, ["cli_nonzero_exit"], 1),
        ):
            with self.subTest(first=first if not callable(first) else "exposed canary"):
                harness = self.fresh_harness()
                # The second entry must never be consumed.
                calls, result = self.run_preflight(harness, tag, [first, PASS])
                self.assertEqual(len(calls["budgets"]), 1)
                self.assertEqual(calls["reviews"], 0)
                self.assertEqual(result["failure_codes"], codes)
                self.assertIn(
                    f"{tag}: preflight attempt 1/2 failed a startup safety check (exit {code}); "
                    "not retrying", calls["stdout"])
                self.assertEqual(self.flag_text(harness, tag),
                                 "Kiro startup safety check failed; PR input withheld.\n")

    def test_kiro_nonzero_startup_failure_without_signal_is_retried(self):
        tag = "kiro-sol"
        harness = self.fresh_harness()
        calls, result = self.run_preflight(
            harness, tag, [(1, "", "connection reset by peer"), PASS])
        self.assertTrue(result["valid"], result["failure_codes"])
        self.assertEqual(calls["reviews"], 1)
        self.assertIn(f"{tag}: preflight attempt 1/2 failed (exit 1); retrying", calls["stdout"])

    def test_peer_timeout_gives_the_passing_role_kiro_preflight_peer(self):
        for tag, peer in (("kiro-fable", "kiro-sol"), ("kiro-sol", "kiro-fable")):
            with self.subTest(tag=tag):
                harness = self.fresh_harness()
                calls, result = self.run_preflight(
                    harness, tag, [PASS], KIRO_PREFLIGHT_COHORT=self.COHORT)
                self.assertEqual(result["failure_codes"], ["kiro_preflight_peer"])
                self.assertEqual(calls["reviews"], 0)
                # The wait lasts the overall deadline (2 attempts x 2 s), not one attempt.
                self.assertGreaterEqual(calls["elapsed"], 3.9)
                self.assertEqual(self.flag_text(harness, tag), (
                    f"Kiro preflight passed, but required Kiro peer {peer} failed or timed "
                    "out its preflight; PR input withheld.\n"))
                self.assertIn(peer, (harness.work / f"runtime/{tag}.err").read_text())
                self.assertIn(f"{tag}: preflight passed; required Kiro peer {peer} failed or timed out",
                              calls["stdout"])
                self.assertTrue(harness.read(f"slot/{tag}-preflight.json")["ok"])

    def test_failed_peer_receipt_fails_fast(self):
        harness = self.fresh_harness()
        self.peer_receipt(harness, "kiro-sol", False)
        calls, result = self.run_preflight(
            harness, "kiro-fable", [PASS], KIRO_PREFLIGHT_COHORT=self.COHORT)
        self.assertEqual(result["failure_codes"], ["kiro_preflight_peer"])
        self.assertEqual(calls["reviews"], 0)
        # A failed receipt never waits (measured 0.08 s).
        self.assertLess(calls["elapsed"], 1.0)

    def test_barrier_waits_across_a_peer_retry(self):
        harness = self.fresh_harness()
        # The peer receipt arrives after one 2 s attempt budget and before the 4 s
        # overall deadline, as when the peer passed on its retry.
        timer = threading.Timer(3.0, self.peer_receipt, (harness, "kiro-sol", True))
        timer.start()
        self.addCleanup(timer.cancel)
        calls, result = self.run_preflight(
            harness, "kiro-fable", [PASS], KIRO_PREFLIGHT_COHORT=self.COHORT)
        self.assertTrue(result["valid"], result["failure_codes"])
        self.assertEqual(calls["reviews"], 1)
        self.assertGreaterEqual(calls["elapsed"], 2.9)

    def test_incident_codes_replace_cli_nonzero_exit(self):
        harness = self.fresh_harness()
        self.run_preflight(harness, "kiro-sol", [TIMEOUT, TIMEOUT],
                           KIRO_PREFLIGHT_COHORT=self.COHORT)
        # kiro-fable sees kiro-sol's failed receipt and fails fast.
        self.run_preflight(harness, "kiro-fable", [PASS], KIRO_PREFLIGHT_COHORT=self.COHORT)
        harness.record("codex")
        harness.record("claude-self")
        harness.cli("aggregate", "--work", harness.work, expected=2)
        summary = harness.read("role-summary.json")
        self.assertEqual(summary["mode"], "blocked")
        for code in ("kiro_preflight_timeout:kiro-sol", "kiro_preflight_peer:kiro-fable",
                     "upstream_preflight_flag"):
            self.assertIn(code, summary["failure_codes"])
        for code in ("cli_nonzero_exit:kiro-sol", "cli_nonzero_exit:kiro-fable"):
            self.assertNotIn(code, summary["failure_codes"])
        self.assertEqual(summary["responded"], ["claude-self", "codex"])
        report = (harness.work / "deterministic-review.md").read_text()
        self.assertTrue(report.endswith("VERDICT: FAIL\n"))
        self.assertIn("`kiro_preflight_peer:kiro-fable`", report)

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
