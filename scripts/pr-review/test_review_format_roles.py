"""The approved presentation contract gates publication, not metadata."""

import json
import unittest
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

import role_review
import synthesize_roles
import test_role_review
import test_synthesize_roles
from review_format import FORMAT_INSTRUCTIONS


class ReviewFormatTests(unittest.TestCase):
    def ambiguous_value_examples(self):
        return (
            "password: SYNTHETIC_FIRST SYNTHETIC_SECOND",
            "`password`: SYNTHETIC_FIRST SYNTHETIC_SECOND",
            "`password`: SYNTHETIC_VALUE # comment",
        )

    def test_ambiguous_colon_values_cannot_supply_role_coverage(self):
        for text in self.ambiguous_value_examples():
            for field in ("check", "condition", "evidence", "uncertainty"):
                with self.subTest(text=text, field=field):
                    helper = test_role_review.RoleReviewTests()
                    helper.setUp()
                    self.addCleanup(helper.tearDown)
                    helper.prepare()
                    response = helper.response("codex")
                    if field == "check":
                        response["checks"][0]["evidence"] = text
                    elif field == "uncertainty":
                        response["uncertainties"] = [text]
                    else:
                        finding = {
                            "severity": "MAJOR", "path": test_role_review.FRONTEND,
                            "condition": "The changed branch fails.",
                            "evidence": "Checked the caller.",
                        }
                        finding[field] = text
                        response["findings"] = [finding]
                    result = helper.record("codex", response, expected=2)
                    self.assertFalse(result["valid"])
                    self.assertEqual(result["failure_codes"], ["unsupported_review_format"])
                    self.assertIsNone(result["response"])
                    helper.record("claude-self")
                    helper.cli("aggregate", "--work", helper.work, expected=2)
                    published = (helper.work / "deterministic-review.md").read_text()
                    self.assertTrue(published.endswith("VERDICT: FAIL\n"))
                    for canary in ("SYNTHETIC_FIRST", "SYNTHETIC_SECOND", "SYNTHETIC_VALUE"):
                        self.assertNotIn(canary, json.dumps(result) + published)

    def test_ambiguous_colon_values_block_chair_pass_and_preserve_primary_fail(self):
        for text in self.ambiguous_value_examples():
            for verdict in ("PASS", "FAIL"):
                with self.subTest(text=text, verdict=verdict):
                    primary = (0, text + "\nPUBLIC_AFTER\nVERDICT: " + verdict + "\n", "")
                    fallback = (primary if verdict == "PASS" else
                                (0, "Fallback must not clear the failure.\nVERDICT: PASS\n", ""))
                    calls, published = self.chair([primary, fallback])
                    self.assertEqual(calls, 2 if verdict == "PASS" else 1)
                    self.assertTrue(published.endswith("VERDICT: FAIL\n"))
                    self.assertIn("format", published.lower())
                    for canary in ("SYNTHETIC_FIRST", "SYNTHETIC_SECOND", "SYNTHETIC_VALUE"):
                        self.assertNotIn(canary, published)

    def qualified_assignment_examples(self):
        return (
            "`db.password`: 'SYNTHETIC_REVIEW_VALUE'",
            "`aws.secret_access_key`: SYNTHETIC_REVIEW_VALUE",
            "`db.password`: 13579",
            '`infra/aws_secret_access_key`="SYNTHETIC_REVIEW_VALUE"',
            "password: !!str SYNTHETIC_REVIEW_VALUE",
            "password: &credential SYNTHETIC_REVIEW_VALUE",
            "env/password='SYNTHETIC_REVIEW_VALUE'",
            "db.password: 'SYNTHETIC_REVIEW_VALUE'",
            # Option 1 intentionally restricts these former prose-positive forms.
            "Authorization: The caller is checked.",
            "**Secrets/credentials:** none introduced.",
            "Checked `web/lib/token.ts`: the guard is preserved.",
            "The secret: user's identity is validated.",
            "password: customer's default is documented.",
            "secret: we're using the documented identity.",
            "secret: customer's default",
        )

    def test_qualified_and_tagged_assignments_cannot_supply_specialist_coverage(self):
        for evidence in self.qualified_assignment_examples():
            with self.subTest(evidence=evidence):
                helper = test_role_review.RoleReviewTests()
                helper.setUp()
                self.addCleanup(helper.tearDown)
                helper.prepare()
                result = helper.record("codex", helper.response("codex", checks=[{
                    "path": test_role_review.FRONTEND, "evidence": evidence,
                }]), expected=2)
                self.assertFalse(result["valid"])
                self.assertEqual(result["failure_codes"], ["unsupported_review_format"])
                self.assertIsNone(result["response"])
                self.assertNotIn("SYNTHETIC_REVIEW_VALUE", json.dumps(result))
                helper.record("claude-self")
                helper.cli("aggregate", "--work", helper.work, expected=2)
                self.assertTrue((helper.work / "deterministic-review.md").read_text()
                                .endswith("VERDICT: FAIL\n"))

    def test_qualified_and_tagged_assignments_cannot_publish_chair_pass(self):
        for evidence in self.qualified_assignment_examples():
            with self.subTest(evidence=evidence):
                reply = (0, evidence + "\nPUBLIC_AFTER\nVERDICT: PASS\n", "")
                calls, published = self.chair([reply, reply])
                self.assertEqual(calls, 2)
                self.assertIn("format", published.lower())
                self.assertNotIn("SYNTHETIC_REVIEW_VALUE", published)
                self.assertTrue(published.endswith("VERDICT: FAIL\n"))

    def citation_and_prose_examples(self):
        return (
            "## Authorization\nThe caller is checked.",
            "**Secrets/credentials:**\nNone introduced.",
            "Token handling: preserved.",
            "See [auth.ts](web/lib/auth.ts:42) for the caller check.",
            "The guard at auth.ts:42 was checked.",
            "The guard at token.ts:42 was checked.",
            "The guard at web/lib/token.ts:42 was checked.",
            "token.ts:42",
            "web/lib/token.ts:42",
            "Checked `web/lib/token.ts`; the guard is preserved.",
            "Per `docs/decisions/002-auth-and-login.md`: signup is closed.",
            "Authorization: [implementation](web/lib/auth.ts)",
        )

    def test_citations_and_prose_labels_can_complete_specialist_review(self):
        for evidence in self.citation_and_prose_examples():
            with self.subTest(evidence=evidence):
                helper = test_role_review.RoleReviewTests()
                helper.setUp()
                self.addCleanup(helper.tearDown)
                helper.prepare()
                response = helper.response("codex", checks=[{
                    "path": test_role_review.FRONTEND,
                    "evidence": evidence + "\nPUBLIC_AFTER",
                }])
                result = helper.record("codex", response)
                self.assertTrue(result["valid"], result["failure_codes"])
                self.assertIn("PUBLIC_AFTER", result["response"]["checks"][0]["evidence"])
                helper.record("claude-self")
                helper.cli("aggregate", "--work", helper.work)
                self.assertTrue((helper.work / "deterministic-review.md").read_text()
                                .endswith("VERDICT: PASS\n"))

    def test_citations_and_prose_labels_can_complete_chair_review(self):
        for evidence in self.citation_and_prose_examples():
            with self.subTest(evidence=evidence):
                reply = (0, evidence + "\nPUBLIC_AFTER\nVERDICT: PASS\n", "")
                calls, published = self.chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertIn("PUBLIC_AFTER", published)
                self.assertTrue(published.endswith("VERDICT: PASS\n"))

    def test_later_assignments_still_block_after_citations_and_prose(self):
        for evidence in (
            "See auth.ts:42; password='synthetic-private'",
            "Authorization: caller checked; password='synthetic-private'",
            "Checked `src/token.ts`: note; token='synthetic-private'",
        ):
            with self.subTest(evidence=evidence):
                helper = test_role_review.RoleReviewTests()
                helper.setUp()
                self.addCleanup(helper.tearDown)
                helper.prepare()
                result = helper.record("codex", helper.response("codex", checks=[{
                    "path": test_role_review.FRONTEND, "evidence": evidence,
                }]), expected=2)
                self.assertFalse(result["valid"])
                self.assertEqual(result["failure_codes"], ["unsupported_review_format"])
                self.assertIsNone(result["response"])
                helper.record("claude-self")
                helper.cli("aggregate", "--work", helper.work, expected=2)
                self.assertTrue((helper.work / "deterministic-review.md").read_text()
                                .endswith("VERDICT: FAIL\n"))
                reply = (0, evidence + "\nVERDICT: PASS\n", "")
                calls, published = self.chair([reply, reply])
                self.assertEqual(calls, 2)
                self.assertIn("format", published.lower())
                self.assertNotIn("synthetic-private", published)
                self.assertTrue(published.endswith("VERDICT: FAIL\n"))

    def heading_examples(self):
        return (
            "Authorization:\nThe handler checks the caller.",
            "**Authorization:**\nThe handler checks the caller.",
            "origin-verify:\nThe origin gate remains enforced.",
            "Checked `token`\n===\nThe caller verifies its scope.",
            "Token\n=\nThe caller verifies its scope.",
            "See `Authorization`:\nThe caller is checked.",
        )

    def test_section_labels_and_setext_are_valid_specialist_prose(self):
        for evidence in self.heading_examples():
            with self.subTest(evidence=evidence):
                helper = test_role_review.RoleReviewTests()
                helper.setUp()
                self.addCleanup(helper.tearDown)
                helper.prepare()
                result = helper.record("codex", helper.response("codex", checks=[{
                    "path": test_role_review.FRONTEND, "evidence": evidence,
                }]))
                self.assertTrue(result["valid"], result["failure_codes"])
                helper.record("claude-self")
                helper.cli("aggregate", "--work", helper.work)
                self.assertTrue((helper.work / "deterministic-review.md").read_text()
                                .endswith("VERDICT: PASS\n"))

    def test_section_labels_and_setext_are_valid_chair_prose(self):
        for evidence in self.heading_examples():
            with self.subTest(evidence=evidence):
                reply = (0, evidence + "\nReview complete.\nVERDICT: PASS\n", "")
                calls, published = self.chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertIn("Review complete.", published)
                self.assertTrue(published.endswith("VERDICT: PASS\n"))

    def named_value_examples(self):
        for name, value, label in (
            ("name", "value", "password:admin"),
            ("headerName", "headerValue", "token=abc"),
        ):
            item = {name: label, value: "FENCED_SYNTHETIC_PRIVATE", "public": "PUBLIC_KEEP"}
            for payload in (item, [item]):
                yield name, value, payload

    def test_complete_fenced_json_masks_named_values_before_specialist_publication(self):
        for name, value, payload in self.named_value_examples():
            with self.subTest(name=name, array=isinstance(payload, list)):
                helper = test_role_review.RoleReviewTests()
                helper.setUp()
                self.addCleanup(helper.tearDown)
                helper.prepare()
                evidence = "Example:\n```json\n" + json.dumps(payload) + "\n```\nPUBLIC_AFTER"
                result = helper.record("codex", helper.response("codex", checks=[{
                    "path": test_role_review.FRONTEND, "evidence": evidence,
                }]))
                self.assertTrue(result["valid"], result["failure_codes"])
                self.assertNotIn("FENCED_SYNTHETIC_PRIVATE", json.dumps(result))
                self.assertIn("PUBLIC_KEEP", json.dumps(result))
                helper.record("claude-self")
                helper.cli("aggregate", "--work", helper.work)
                self.assertNotIn("FENCED_SYNTHETIC_PRIVATE",
                                 (helper.work / "role-summary.json").read_text())

    def test_complete_fenced_json_masks_named_values_before_chair_publication(self):
        for name, value, payload in self.named_value_examples():
            with self.subTest(name=name, array=isinstance(payload, list)):
                report = ("Before `service`.\n~~~~json\n" + json.dumps(payload)
                          + "\n~~~~\nPUBLIC_AFTER\nVERDICT: PASS\n")
                calls, published = self.chair([(0, report, "")])
                self.assertEqual(calls, 1)
                self.assertNotIn("FENCED_SYNTHETIC_PRIVATE", published)
                self.assertIn("PUBLIC_KEEP", published)
                self.assertTrue(published.startswith("Before `service`.\n~~~~json\n"))
                self.assertTrue(published.endswith("\n~~~~\nPUBLIC_AFTER\nVERDICT: PASS\n"))

    def test_example_json_never_inherits_metadata_path_exemptions(self):
        helper = test_role_review.RoleReviewTests()
        helper.setUp()
        self.addCleanup(helper.tearDown)
        path = "src/password=SYNTHETIC_EXAMPLE_PATH.py"
        helper.prepare(test_role_review.patch(path))
        evidence = "```json\n" + json.dumps({"path": path}) + "\n```"
        result = helper.record("codex", helper.response("codex", checks=[{
            "path": path, "evidence": evidence,
        }]))
        self.assertTrue(result["valid"], result["failure_codes"])
        self.assertEqual(result["response"]["reviewed_paths"], [path])
        self.assertEqual(result["response"]["checks"][0]["path"], path)
        self.assertNotIn("SYNTHETIC_EXAMPLE_PATH", result["response"]["checks"][0]["evidence"])

    def test_fenced_json_masking_preserves_exact_boundaries_and_other_blocks(self):
        payload = '{"name":"password:admin","value":"FENCED_SYNTHETIC_PRIVATE","public":"PUBLIC_KEEP"}'
        for opening, closing, newline in (
            ("```json", "```", "\n"),
            ("~~~~text", "~~~~~ \t", "\r\n"),
            ("````", "`````", "\n"),
        ):
            prefix = "BEFORE" + newline + opening + newline + " \t"
            suffix = newline + newline + closing + newline + "AFTER"
            with self.subTest(opening=opening):
                masked = role_review.mask_fenced_json(prefix + payload + suffix)
                self.assertTrue(masked.startswith(prefix))
                self.assertTrue(masked.endswith(suffix))
                self.assertNotIn("FENCED_SYNTHETIC_PRIVATE", masked)
                self.assertIn("PUBLIC_KEEP", masked)
        for block in (
            "```sh\npassword='unchanged-by-json-pass'\n```",
            '```json\n"scalar JSON remains prose-owned"\n```',
            "```json\nnull\n```",
            "```json\n" + payload,
            "````json\n" + payload + "\n```\n",
            "> ```json\n> " + payload + "\n> ```",
            "  ```json\n" + payload + "\n  ```",
            '```json\n{"name":"TOKEN","name":"duplicate","value":"unchanged"}\n```',
            "```json\n" + payload + "\ntrailing prose\n```",
        ):
            with self.subTest(block=block):
                self.assertEqual(role_review.mask_fenced_json(block), block)

    def test_issued_specialist_and_chair_prompts_share_the_contract(self):
        helper = test_role_review.RoleReviewTests()
        helper.setUp()
        self.addCleanup(helper.tearDown)
        helper.prepare()
        helper.cli("issue", "--work", helper.work, "--tag", "codex")
        issued = (helper.work / "requests/codex.prompt").read_text()
        self.assertIn(FORMAT_INSTRUCTIONS, issued)

        def inspect_chair(command, *unused):
            self.assertIn(FORMAT_INSTRUCTIONS, command[2])
            return 0, "Checked `validate()`.\nVERDICT: PASS\n", ""

        calls, text = self.chair(inspect_chair)
        self.assertEqual(calls, 1)
        self.assertTrue(text.endswith("VERDICT: PASS\n"))

    def test_shell_adapter_gets_instructions_and_fixed_failure(self):
        script = Path(__file__).with_name("review_format.py")
        result = subprocess.run([sys.executable, str(script), "instructions"],
                                capture_output=True, text=True, check=True)
        self.assertIn("fenced code blocks", result.stdout)
        with tempfile.TemporaryDirectory() as root:
            text = Path(root) / "reply.md"
            for value, expected in (("Checked `validate()`.", 0),
                                    ("password='synthetic-private'", 2)):
                text.write_text(value)
                result = subprocess.run([sys.executable, str(script), "check", str(text)],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, expected)
                self.assertEqual(result.stdout, "" if expected == 0 else
                                 "unsupported_review_format\n")
                self.assertNotIn("synthetic-private", result.stdout + result.stderr)

    def test_stream_adapter_emits_nothing_before_rejecting_invalid_output(self):
        script = Path(__file__).with_name("review_format.py")
        for value, accepted in (("Checked `validate()`.\n", True),
                                ("Public prefix.\npassword='synthetic-private'\n", False)):
            result = subprocess.run([sys.executable, str(script), "filter"], input=value,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0 if accepted else 2)
            self.assertEqual(result.stdout, value if accepted else "")
            self.assertEqual(result.stderr, "" if accepted else "unsupported_review_format\n")

    def response(self, evidence):
        path = "src/password=example.py"
        plan = {"head_sha": "a" * 40, "roles": {
            "codex": {"role": "implementation", "paths": [path]}}}
        response = {
            "head_sha": plan["head_sha"], "role": "implementation",
            "scope_complete": True, "reviewed_paths": [path],
            "checks": [{"path": path, "evidence": evidence}],
            "findings": [], "uncertainties": [],
        }
        return response, plan

    def test_supported_prose_references_and_fenced_examples(self):
        for text in (
            "Checked `validate()` and `src/service.py:12` against the caller.",
            "See `AWS::IAM::Role`, `--context`, `$NAME`, and `[REDACTED]`.",
            "Example:\n```sh\npassword='synthetic'\n```\nThe caller rejects it.",
            "Example:\n~~~~js\nconst text = `template`;\n~~~~\nChecked the caller.",
            "Example:\n````md\n```sh\npassword='synthetic'\n```\n````\nChecked.",
        ):
            with self.subTest(text=text):
                response, plan = self.response(text)
                role_review.validate_response(response, plan, "codex")

    def test_unsupported_examples_in_each_prose_field(self):
        for text in (
            "Example: `password='synthetic'`.",
            "Run `echo hello`.",
            "Run `first\nsecond`.",
            "Checked `unclosed.",
            "Example:\n```sh\npassword='synthetic'\n",
            "Example:\n```sh\npassword='synthetic'\n~~~",
            "Example:\n> ```sh\n> password='synthetic'\n> ```",
            "Example:\n    ```sh\n    password='synthetic'\n    ```",
            "Example:\npassword = 'synthetic'",
            'Example:\n"api_key": "synthetic"',
            "Example:\npassword\n= 'synthetic'",
            "Example: `` password='synthetic' ``.",
            "Set `password` = 'synthetic-private'.",
            "Set `api_key`: 'synthetic-private'.",
            "Set `password`\n= 'synthetic-private'.",
            "Authorization: Bearer synthetic-private",
            "origin-verify: synthetic-private",
            "password\n= synthetic-private",
            "password=",
            "Set `password`=",
        ):
            for field in ("check", "condition", "evidence", "uncertainty"):
                with self.subTest(text=text, field=field):
                    response, plan = self.response("Checked the changed caller.")
                    if field == "check":
                        response["checks"][0]["evidence"] = text
                    elif field == "uncertainty":
                        response["uncertainties"] = [text]
                    else:
                        finding = {"severity": "MAJOR", "path": response["reviewed_paths"][0],
                                   "condition": "The caller fails.", "evidence": "Checked the caller."}
                        finding[field] = text
                        response["findings"] = [finding]
                    with self.assertRaisesRegex(role_review.Invalid, "^unsupported_review_format$"):
                        role_review.validate_response(response, plan, "codex")

    def chair(self, replies):
        helper = test_synthesize_roles.SynthesisTests()
        helper.setUp()
        self.addCleanup(helper.doCleanups)
        return helper.run_chair(replies)

    def test_chair_does_not_publish_unsupported_examples(self):
        reply = (0, "Example: `password='synthetic-private'`.\nVERDICT: PASS\n", "")
        calls, text = self.chair([reply, reply])
        self.assertEqual(calls, 2)
        self.assertTrue(text.endswith("VERDICT: FAIL\n"))
        self.assertIn("format", text.lower())
        self.assertNotIn("synthetic-private", text)

    def test_chair_checks_sanitized_format_too(self):
        reply = (0, "Checked `validate()`.\nVERDICT: PASS\n", "")
        helper = test_synthesize_roles.SynthesisTests()
        helper.setUp()
        self.addCleanup(helper.doCleanups)
        with patch.object(helper.module, "scrub_decoded",
                          return_value="Checked `unclosed.\nVERDICT: PASS\n"):
            _, text = helper.run_chair([reply, reply])
        self.assertTrue(text.endswith("VERDICT: FAIL\n"))

    def test_format_failure_does_not_hide_account_limit(self):
        calls, text = self.chair([
            (0, "Run `bad\nexample`.\nVERDICT: PASS\n", "quota exceeded"),
            (0, "Must not run.\nVERDICT: PASS\n", ""),
        ])
        self.assertEqual(calls, 1)
        self.assertTrue(text.endswith("VERDICT: FAIL\n"))
        self.assertNotIn("bad", text)

    def test_invalid_specialist_output_blocks_coverage_without_public_payload(self):
        helper = test_role_review.RoleReviewTests()
        helper.setUp()
        self.addCleanup(helper.tearDown)
        helper.prepare()
        response = helper.response("codex", checks=[{
            "path": test_role_review.FRONTEND,
            "evidence": "Run `password='synthetic-private'`.",
        }])
        result = helper.record("codex", response, expected=2)
        self.assertFalse(result["valid"])
        self.assertEqual(result["failure_codes"], ["unsupported_review_format"])
        self.assertIsNone(result["response"])
        helper.record("claude-self")
        helper.cli("aggregate", "--work", helper.work, expected=2)
        published = (helper.work / "deterministic-review.md").read_text()
        self.assertTrue(published.endswith("VERDICT: FAIL\n"))
        self.assertNotIn("synthetic-private", published)
        self.assertIn("unsupported_review_format", published)

    def test_deterministic_findings_keep_embedded_fences_and_verdicts_literal(self):
        helper = test_role_review.RoleReviewTests()
        helper.setUp()
        self.addCleanup(helper.tearDown)
        helper.prepare()
        response = helper.response("codex", findings=[{
            "severity": "MINOR", "path": test_role_review.FRONTEND,
            "condition": "The rendering fixture contains a verdict marker.",
            "evidence": "Fixture:\n````text\n```\nVERDICT: FAIL\n```\n````",
        }])
        helper.finish({"codex": response})
        published = (helper.work / "deterministic-review.md").read_text()
        self.assertIn("```json\n", published)
        self.assertEqual([line for line in published.splitlines() if line.startswith("VERDICT:")],
                         ["VERDICT: PASS"])
        self.assertIn("\\nVERDICT: FAIL\\n", published)


if __name__ == "__main__":
    unittest.main()
