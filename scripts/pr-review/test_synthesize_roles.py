"""The deterministic path must never start a model."""

import importlib.util
import os
import re
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


MODULE = Path(__file__).with_name("synthesize_roles.py")


class SynthesisTests(unittest.TestCase):
    def test_scrubbing_cannot_accept_conflicting_original_verdicts(self):
        for failure in ("VERDICT: FAIL", "\x1b[31mVERDICT: FAIL\x1b[0m", "VERD\u200bICT: FAIL"):
            with self.subTest(failure=failure):
                reply = (0, f"Finding:\npassword = prior ||\n{failure}\nVERDICT: PASS\n", "")
                calls, output = self.run_chair([reply, reply])
                self.assertEqual(calls, 2)
                self.assertTrue(output.rstrip().endswith("VERDICT: FAIL"))

    def setUp(self):
        self.assertTrue(MODULE.exists(), "Conditional synthesis is not implemented")
        spec = importlib.util.spec_from_file_location("synthesize_roles", MODULE)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_chair(self, replies):
        (self.root / "chair-mode.txt").write_text("review\n")
        (self.root / "role-summary.json").write_text('{"findings":[]}')
        (self.root / "project-context.md").write_text("Trusted base.")
        (self.root / "roles").mkdir(exist_ok=True)
        (self.root / "roles/codex.diff").write_text("Complete supplied diff.")
        with patch.dict(os.environ, {"CHAIR_TIMEOUT": "10",
                "CHAIR_PRIMARY_MODEL": "global.anthropic.claude-fable-5-1",
                "CHAIR_FALLBACK_MODEL": "global.anthropic.claude-opus-5"}), \
                patch.object(self.module, "record_status"), \
                patch.object(self.module, "execute", side_effect=replies) as invoke:
            self.module.synthesize(self.root, self.root / "review.md")
        return invoke.call_count, (self.root / "review.md").read_text()

    def test_transient_throttle_uses_configured_fallback(self):
        for kind in ("ThrottlingException", "TooManyRequestsException"):
            with self.subTest(kind=kind):
                calls, text = self.run_chair([
                    (1, "", f"An error occurred ({kind}) invoking the primary model"),
                    (0, "Fallback reviewed the evidence.\nVERDICT: PASS\n", ""),
                ])
                self.assertEqual(calls, 2)
                self.assertTrue(text.endswith("VERDICT: PASS\n"))

    def test_format_fallback_gets_static_guidance_and_retains_a_blocking_verdict(self):
        prompts, evidence, models = [], [], []
        def execute(command, cwd, environment, input_text, timeout):
            prompts.append(command[2])
            evidence.append(input_text)
            models.append(command[command.index("--model") + 1])
            self.assertTrue(input_text.endswith(self.module.CHAIR_OUTPUT_GUIDANCE + "\n"))
            self.assertIn("END SPECIALISTS", input_text)
            if len(prompts) == 1:
                return 0, "The condition `value > 0` has a MAJOR defect.\nVERDICT: FAIL\n", ""
            self.assertIn("previous attempt failed presentation validation", command[2])
            self.assertIn("do not reduce scope, drop findings, or infer approval", command[2])
            self.assertNotIn("value > 0", command[2])
            return 0, "The MAJOR defect remains unresolved.\nVERDICT: FAIL\n", ""
        calls, text = self.run_chair(execute)
        self.assertEqual(calls, 2)
        self.assertEqual(evidence[0], evidence[1])
        self.assertEqual(models, ["global.anthropic.claude-fable-5-1", "global.anthropic.claude-opus-5"])
        self.assertEqual(text, "The MAJOR defect remains unresolved.\nVERDICT: FAIL\n")

    def test_hard_account_limits_still_make_only_one_call(self):
        for error in ("ThrottlingException: MONTHLY_REQUEST_COUNT exhausted",
                      "Error: insufficient credits", "Error: You have reached the limit for overages"):
            with self.subTest(error=error):
                calls, text = self.run_chair([
                    (0, "Otherwise valid response.\nVERDICT: PASS\n", error),
                    (0, "Must not be used.\nVERDICT: PASS\n", ""),
                ])
                self.assertEqual(calls, 1)
                self.assertTrue(text.endswith("VERDICT: FAIL\n"))

    def test_markdown_examples_keep_verdict_and_credential_masking(self):
        for example in ("credentials=[]\nsecret={private-value}",
                        "-----BEGIN PRIVATE KEY-----\nprivate-value\n-----END PRIVATE KEY-----",
                        '{"name":"DATABASE_PASSWORD","value":"private-value"}'):
            with self.subTest(example=example):
                reply = (0, self.fenced_code(example) + "\nReviewed behavior.\nVERDICT: PASS\n",
                         "")
                calls, text = self.run_chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertTrue(text.endswith("VERDICT: PASS\n"))
                self.assertNotIn("private-value", text)

    def test_multiline_and_list_inline_commands_are_format_rejected(self):
        for example in (
            "1. Summary\n\n    Run `export password=private-value` now.",
            "Run `export\npassword=private-value` now.",
            "1. Summary\n\n    Run `export\n    password=private-value` now.",
            "10. Summary\n\n     Run `export password=private-value` now.",
            "- Summary\n\n    Run `export password=private-value` now.",
            "-\n\n    Run `export password=private-value` now.",
        ):
            with self.subTest(example=example):
                self.assert_format_rejected(example + "\n\nReviewed behavior.\nVERDICT: PASS\n")

    def test_inline_boundaries_exclude_separate_blocks(self):
        import role_review
        for example in (
            "    `password=value`\n",
            "```text\n`password=value`\n```\n",
            "1. Summary\n\n   ```text\n   `password=value`\n   ```\n",
            "Example `open\n\nnew paragraph`\n",
            "Example `open\n```text\nclose`\n```\n",
            "Example `open\nclose``\n",
            "Example `open\n--\nclose`\n",
            "Example `open\n=\nclose`\n",
            "Example `open\n_ _ _\nclose`\n",
        ):
            with self.subTest(example=example):
                self.assertEqual(role_review._inline_code_spans(example), [])

    def test_multiline_quote_owners_keep_source_values_private(self):
        quoted = (
            "'longer ` quoted\n    text'",
            "'longer\n    ` quoted text'",
            "'longer\n\n    ` quoted text'",
        )
        for value in quoted:
            with self.subTest(value=value):
                example = "-\n\n    echo " + value + "\n    password=prefix`printf 'private-value'`"
                reply = (0, self.fenced_code(example) + "\nPUBLIC_AFTER\nVERDICT: PASS\n", "")
                calls, published = self.run_chair([reply, reply])
                self.assertNotIn("private-value", published)
                self.assertEqual(calls, 1)
                self.assertIn("PUBLIC_AFTER", published)
                self.assertTrue(published.endswith("VERDICT: PASS\n"))

    def test_semicolon_literal_is_not_an_empty_citation(self):
        reply = (0, "Use `password=`; printf 'private-value'`` now.\n"
                 "PUBLIC_AFTER\nVERDICT: PASS\n", "")
        calls, published = self.run_chair([reply, reply])
        self.assertNotIn("private-value", published)
        self.assertEqual(calls, 2)
        self.assertTrue(published.endswith("VERDICT: FAIL\n"))
        for example in ("Checked `password=`; empty values are rejected.",
                         "Checked `password=`; see `service`.",
                         "Checked `password=`;\n\n```text\npublic()\n```"):
            with self.subTest(example=example):
                self.assert_format_rejected(example + "\nPUBLIC_AFTER\nVERDICT: PASS\n")

    def test_raw_block_quotes_do_not_allow_later_inline_commands(self):
        for block in ("```text\nunterminated '\n```", "<pre>\nunterminated '\n</pre>"):
            with self.subTest(block=block):
                example = (block + "\n\nChecked `echo user's password='private-value'`; "
                           "MAJOR evidence. See `service`.")
                self.assert_format_rejected(example + "\nPUBLIC_AFTER\nVERDICT: FAIL\n")

    def test_citation_prefix_does_not_release_a_literal_suffix(self):
        for suffix in ("private-value", "'private-value'", "`printf private-value`"):
            with self.subTest(suffix=suffix):
                reply = (0, "Checked `password=`printf public`" + suffix
                         + "` now.\nPUBLIC_AFTER\nVERDICT: PASS\n", "")
                calls, published = self.run_chair([reply, reply])
                self.assertNotIn("private-value", published)
                self.assertEqual(calls, 2)
                self.assertTrue(published.endswith("VERDICT: FAIL\n"))
        self.assert_format_rejected(
            "Checked ``password=`printf public`private-value`` now.\n"
            "PUBLIC_AFTER\nVERDICT: PASS\n")

    def test_same_line_prose_quotes_do_not_allow_inline_assignments(self):
        for quote in ('"', "'"):
            for prefix in ("", "env "):
                with self.subTest(quote=quote, prefix=prefix):
                    example = (quote + "Checked `" + prefix + "password=" + quote
                               + "private-value" + quote + "`; MAJOR rollback evidence. "
                               + "See `service`." + quote)
                    self.assert_format_rejected(example + "\nPUBLIC_AFTER\nVERDICT: FAIL\n")

    def test_quote_owned_tick_does_not_escape_empty_list_literal(self):
        for separator in ("\n    ", "; "):
            with self.subTest(separator=separator):
                example = ("-\n\n    echo 'longer ` quoted text'" + separator
                           + "password=prefix`printf 'private-value'`")
                reply = (0, self.fenced_code(example) + "\nReviewed behavior.\nVERDICT: PASS\n", "")
                calls, published = self.run_chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertNotIn("private-value", published)
                self.assertIn("Reviewed behavior.", published)
                self.assertTrue(published.endswith("VERDICT: PASS\n"))

    def test_foreign_quote_cannot_close_an_unterminated_value(self):
        for separator in ("\n    ", "; "):
            with self.subTest(separator=separator):
                example = ("-\n\n    echo 'longer ` quoted text'" + separator
                           + "password=prefix`printf 'private-value'")
                reply = (0, example + "\n\nPUBLIC_AFTER\nVERDICT: PASS\n", "")
                calls, published = self.run_chair([reply, reply])
                self.assertNotIn("private-value", published)
                self.assertEqual(calls, 2)
                self.assertTrue(published.endswith("VERDICT: FAIL\n"))

    def test_owned_bodies_do_not_capture_following_review(self):
        examples = (
            "secret=<<EOF\npassword=prefix` private-value\nEOF",
            "secret: |\n  password=prefix` private-value",
            "secret: >\n  password=prefix` private-value",
            'name="PASSWORD", value="password=prefix` private-value"',
            "secret='password=prefix` private-value'",
        )
        for example in examples:
            with self.subTest(example=example):
                # These YAML owners conservatively consume the closing fence.
                invalid = example.startswith(("secret: |", "secret: >"))
                reply = (0, self.fenced_code(example)
                         + "\nMAJOR rollback evidence. See `service`.\nVERDICT: FAIL\n", "")
                calls, published = self.run_chair([reply, reply])
                self.assertEqual(calls, 2 if invalid else 1)
                self.assertNotIn("private-value", published)
                if invalid:
                    self.assertIn("failed the review format contract", published)
                else:
                    self.assertIn("MAJOR rollback evidence.", published)
                    self.assertIn("`service`", published)
                self.assertTrue(published.endswith("VERDICT: FAIL\n"))

    def test_quote_pairing_keeps_existing_citations_and_offsets(self):
        import role_review
        cases = (
            ("Say '`public()`'.", ["public()"]),
            ("Run `first\nsecond` now.", ["first\nsecond"]),
            ("It's `echo user's name` output.", ["echo user's name"]),
        )
        for value, expected in cases:
            with self.subTest(value=value):
                spans = role_review._inline_code_spans(value)
                self.assertEqual([value[start:end] for start, end in spans], expected)

    def test_inline_assignment_before_raw_blocks_is_format_rejected(self):
        for block in ("```text\npublic()\n```", "<pre>\necho '`'\n</pre>"):
            with self.subTest(block=block):
                self.assert_format_rejected(
                    "Checked `env password='private-value'`; "
                    "MAJOR rollback evidence.\n\n" + block + "\nVERDICT: FAIL\n")

    def test_inline_command_citations_are_format_rejected(self):
        for prefix in ("env ", "curl -d ", "USER=demo ", "export\n"):
            with self.subTest(prefix=prefix):
                self.assert_format_rejected(
                    "Checked `" + prefix + "password='private-value'`; "
                    "MAJOR rollback evidence. See `service` and `validate()`.\nVERDICT: FAIL\n")

    def test_backtick_assignment_keeps_concatenated_suffix_private(self):
        for suffix in ("private-value", "'private-value'", "`printf private-value`"):
            for prefix in ("echo '`'\n", "- > echo '`'\n  > "):
                with self.subTest(suffix=suffix, prefix=prefix):
                    example = prefix + "password=prefix`printf public`" + suffix
                    reply = (0, self.fenced_code(example)
                             + "\nReviewed behavior.\nVERDICT: PASS\n", "")
                    calls, text = self.run_chair([reply, reply])
                    self.assertNotIn("private-value", text)
                    self.assertEqual(calls, 1)
                    self.assertIn("Reviewed behavior.", text)
                    self.assertTrue(text.endswith("VERDICT: PASS\n"))

    def test_complex_backtick_values_remain_private(self):
        examples = (
            ("echo '`'\npassword=${PREFIX}`printf 'private-value'`", True),
            ("echo '`'\npassword=tags[0]`private-value`", True),
            ("Use `password=`! printf 'private-value'`` now.", False),
        )
        for example, accepted in examples:
            with self.subTest(example=example):
                rendered = self.fenced_code(example) if accepted else example
                reply = (0, rendered + "\nReviewed behavior.\nVERDICT: PASS\n", "")
                calls, text = self.run_chair([reply, reply])
                self.assertNotIn("private-value", text)
                self.assertEqual(calls, 1 if accepted else 2)
                self.assertTrue(text.endswith("VERDICT: PASS\n" if accepted else "VERDICT: FAIL\n"))
                if not accepted:
                    self.assertIn("failed the review format contract", text)

    def test_inline_assignment_citations_are_format_rejected(self):
        for value in ("private-value", "'private-value'", '"private-value"'):
            with self.subTest(value=value):
                self.assert_format_rejected(
                    "Checked `password=" + value + "`; MAJOR rollback evidence. "
                    "See `service` and `validate()`.\nVERDICT: FAIL\n")

    def test_backtick_values_are_protected_before_markdown_boundaries(self):
        examples = (
            "echo '`'\npassword=`printf 'private-value'`",
            "echo '`'\npassword=prefix`printf 'private-value'`",
            'echo \'`\'\npassword="prefix"`printf \'private-value\'`',
            "echo '`'\npassword=`printf\n'private-value'`",
            "| command |\n| --- |\n| echo '`' |\n| password=`printf 'private-value'` |",
            "| first | second |\n| --- | --- |\n| echo '`' | password=`printf 'private-value'` |",
            "<script>\n</style>\necho '`'\npassword=`printf 'private-value'`\n</script>",
        )
        for example in examples:
            with self.subTest(example=example):
                reply = (0, self.fenced_code(example)
                         + "\nReviewed behavior.\nVERDICT: PASS\n", "")
                calls, text = self.run_chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertNotIn("private-value", text)
                self.assertTrue(text.endswith("VERDICT: PASS\n"))

    def test_ambiguous_nonempty_values_are_not_accepted_as_empty(self):
        for example in (
            "echo '`'\npassword=`printf 'private-value'",
            'Use `password=`"private-value"',
        ):
            with self.subTest(example=example):
                reply = (0, example + "\nReviewed behavior.\nVERDICT: PASS\n", "")
                calls, text = self.run_chair([reply, reply])
                self.assertEqual(calls, 2)
                self.assertNotIn("private-value", text)
                self.assertTrue(text.endswith("VERDICT: FAIL\n"))

    def test_raw_html_with_multiline_command_is_format_rejected(self):
        self.assert_format_rejected(
            "<script>\n</style>\nUse `export\npassword=private-value` now.\n"
            "Reviewed behavior.\nVERDICT: PASS\n")

    def test_ordered_nested_code_containers_are_format_rejected(self):
        examples = (
            "- > ```bash\n  > echo '`'\n  > password=`printf 'private-value'`\n  > ```",
            "- > <pre>\n  > echo '`'\n  > password=`printf 'private-value'`\n  > </pre>",
            "- - ```bash\n    echo '`'\n    password=`printf 'private-value'`\n    ```",
            "- - <pre>\n    echo '`'\n    password=`printf 'private-value'`\n    </pre>",
            "> - > ```bash\n>   > echo '`'\n>   > password=`printf 'private-value'`\n>   > ```",
            "> - > <pre>\n>   > echo '`'\n>   > password=`printf 'private-value'`\n>   > </pre>",
            "- > - ```bash\n  >   echo '`'\n  >   password=`printf 'private-value'`\n  >   ```",
            "- > - <pre>\n  >   echo '`'\n  >   password=`printf 'private-value'`\n  >   </pre>",
            "1. > - ```bash\n   >   echo '`'\n   >   password=`printf 'private-value'`\n   >   ```",
            "1. > - <pre>\n   >   echo '`'\n   >   password=`printf 'private-value'`\n   >   </pre>",
        )
        for example in examples:
            with self.subTest(example=example):
                self.assert_format_rejected(example + "\n\nReviewed behavior.\nVERDICT: PASS\n")

    def test_unfenced_html_and_nested_code_examples_are_format_rejected(self):
        examples = (
            "> ```bash\n> cat <<'EOF'\n> > ```\n> EOF\n> echo '`'\n> password=`printf 'private-value'`\n> ```",
            "- Example\n\n  ```bash\n  cat <<'EOF'\n  > ```\n  EOF\n  echo '`'\n  password=`printf 'private-value'`\n  ```",
            "<pre>\necho '`'\npassword=`printf 'private-value'`\n</pre>",
            '<SCRIPT type="text/plain">\necho \'`\'\npassword=`printf \'private-value\'`\n</SCRIPT>',
            "<style>\necho '`'\npassword=`printf 'private-value'`\n</style>",
            "<textarea>\necho '`'\npassword=`printf 'private-value'`\n</textarea>",
            "<!--\necho '`'\npassword=`printf 'private-value'`\n-->",
            "<?example\necho '`'\npassword=`printf 'private-value'`\n?>",
            "<!DOCTYPE\necho '`'\npassword=`printf 'private-value'`\n>",
            "<![CDATA[\necho '`'\npassword=`printf 'private-value'`\n]]>",
            "<div>\necho '`'\npassword=`printf 'private-value'`\n</div>",
            '<x-data attr="ok">\necho \'`\'\npassword=`printf \'private-value\'`\n</x-data>',
            "> <pre>\n> echo '`'\n> password=`printf 'private-value'`\n> </pre>",
        )
        examples += ("<div>\n\xa0\necho '`'\npassword=`printf 'private-value'`\n</div>",)
        examples += tuple(
            "<script>\n" + closer + "\necho '`'\npassword=`printf 'private-value'`\n</script>"
            for closer in ("</ſcript>", "</scrİpt>", "</scrıpt>")
        )
        for example in examples:
            with self.subTest(example=example):
                self.assert_format_rejected(example + "\n\nReviewed behavior.\nVERDICT: PASS\n")

    def test_raw_container_exit_does_not_allow_inline_commands(self):
        examples = (
            "> ```text\n> echo '`'\nOutside `export\npassword=private-value` now.",
            "- Example\n\n  ```text\n  echo '`'\nOutside `export\npassword=private-value` now.",
            "> <pre>\n> echo '`'\nOutside `export\npassword=private-value` now.",
        )
        for example in examples:
            with self.subTest(example=example):
                self.assert_format_rejected(example + "\n\nReviewed behavior.\nVERDICT: PASS\n")

    def test_custom_html_inside_inline_command_is_format_rejected(self):
        self.assert_format_rejected(
            "Use `export\n<x-data attr='ok'>\npassword=private-value` now.\n"
            "Reviewed behavior.\nVERDICT: PASS\n")

    def test_unsupported_empty_sensitive_examples_are_format_rejected(self):
        for example in (
            "Checked `password=`; empty values are rejected.",
            "Checked `export password=   `; empty values are rejected.",
            "Checked ``password=``; empty values are rejected.",
            "```dotenv\npassword=\n```",
            "```dotenv\npassword=   \n```",
            "````dotenv\npassword=\n````",
            "> ```dotenv\n> password=\n> ```",
            "- Example\n\n  > ```dotenv\n  > password=\n  > ```",
        ):
            with self.subTest(example=example):
                self.assert_format_rejected(example + "\nPUBLIC_AFTER\nVERDICT: PASS\n")

    def test_sensitive_label_outside_code_fence_is_format_rejected(self):
        self.assert_format_rejected(
            "password=\n```text\nprivate-value\n```\nPUBLIC_AFTER\nVERDICT: PASS\n")

    def test_shell_quoted_json_preserves_enclosing_boundary(self):
        for payload in (
            '{"password":"private-value"}',
            '{"public":"ok","password":"private-value"}',
            '[{"password":"private-value"}]',
            '{"password":"private-value","public":"ok"}',
        ):
            with self.subTest(payload=payload):
                reply = (0, self.fenced_code(f"curl -d '{payload}' https://example.invalid")
                         + "\nReviewed behavior.\nVERDICT: PASS\n", "")
                calls, text = self.run_chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertTrue(text.endswith("VERDICT: PASS\n"))
                self.assertIn("Reviewed behavior", text)
                self.assertNotIn("private-value", text)

    def test_source_json_boundaries_survive_value_and_key_normalization(self):
        for payload in (
            '{"name":"TOKEN","value":null,"password":"private-value"}',
            '{"name":"TOKEN","value":123,"password":"private-value"}',
            '{"api key (one)":{"note":"private-value"},"api key (two)":{"note":"private-value"}}',
        ):
            with self.subTest(payload=payload):
                reply = (0, self.fenced_code(f"curl -d '{payload}' https://example.invalid")
                         + "\nReviewed behavior.\nVERDICT: PASS\n", "")
                calls, text = self.run_chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertIn("Reviewed behavior.", text)
                self.assertTrue(text.endswith("VERDICT: PASS\n"))
                self.assertNotIn("private-value", text)

    def test_invalid_source_json_cannot_gain_enclosing_boundaries(self):
        reply = (0, "curl -d '{\"name\":\"TOKEN\",\"value\":null \"password\":\"private-value\"}'\n"
                    "Reviewed behavior.\nVERDICT: PASS\n", "")
        calls, text = self.run_chair([reply, reply])
        self.assertEqual(calls, 2)
        self.assertTrue(text.endswith("VERDICT: FAIL\n"))
        self.assertNotIn("private-value", text)

    def test_shell_literal_brackets_preserve_review_after_closing_quote(self):
        for bracket in ("[", "{"):
            with self.subTest(bracket=bracket):
                reply = (0, self.fenced_code(
                    f"curl -d 'password=prefix{bracket}private-value' https://example.invalid")
                    + "\nReviewed behavior.\nVERDICT: PASS\n", "")
                calls, text = self.run_chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertIn("Reviewed behavior.", text)
                self.assertTrue(text.endswith("VERDICT: PASS\n"))
                self.assertNotIn("private-value", text)

    def test_escaped_value_quotes_preserve_review_and_hide_complete_value(self):
        for quote in ('"', "'"):
            with self.subTest(quote=quote):
                reply = (0, self.fenced_code(f"password={quote}prefix\\{quote}private-value{quote}")
                         + "\nReviewed behavior.\nVERDICT: PASS\n", "")
                calls, text = self.run_chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertIn("Reviewed behavior.", text)
                self.assertTrue(text.endswith("VERDICT: PASS\n"))
                self.assertNotIn("private-value", text)

    def test_stdout_account_errors_prevent_fallback_and_pass(self):
        for code in (0, 1):
            for message in (
                "UsageLimitReachedError",
                "Monthly request limit reached",
                "Error: insufficient credits",
                "You have reached the limit for overages",
            ):
                with self.subTest(code=code, message=message):
                    calls, text = self.run_chair([
                        (code, message + "\nVERDICT: PASS\n", ""),
                        (0, "Must not run.\nVERDICT: PASS\n", ""),
                    ])
                    self.assertEqual(calls, 1)
                    self.assertTrue(text.endswith("VERDICT: FAIL\n"))

    def test_quoted_account_diagnostics_are_review_evidence(self):
        report = (
            "Reviewed quota handling for UsageLimitReachedError.\n"
            '- The test covers "Monthly request limit reached".\n'
            "Example provider diagnostic:\n```\nUsageLimitReachedError\n```\n"
            "VERDICT: PASS\n"
        )
        calls, text = self.run_chair([(0, report, "")])
        self.assertEqual(calls, 1)
        self.assertTrue(text.endswith("VERDICT: PASS\n"))

    def test_complete_clean_review_does_not_call_chair(self):
        (self.root / "chair-mode.txt").write_text("deterministic\n")
        (self.root / "deterministic-review.md").write_text("Scope complete.\nVERDICT: PASS\n")
        with patch.object(self.module, "execute", side_effect=AssertionError("Unexpected call")):
            self.module.synthesize(self.root, self.root / "review.md")
        self.assertTrue((self.root / "review.md").read_text().endswith("VERDICT: PASS\n"))

    def test_incomplete_review_cannot_be_waived_by_chair(self):
        (self.root / "chair-mode.txt").write_text("blocked\n")
        (self.root / "deterministic-review.md").write_text("Missing required role.\nVERDICT: FAIL\n")
        with patch.object(self.module, "execute", side_effect=AssertionError("Unexpected call")):
            self.module.synthesize(self.root, self.root / "review.md")
        self.assertTrue((self.root / "review.md").read_text().endswith("VERDICT: FAIL\n"))

    def test_unique_final_verdict_and_body_are_required(self):
        self.assertTrue(self.module.valid("Evidence reviewed.\nVERDICT: PASS\n", 0))
        for output, status in [
            ("VERDICT: PASS", 0),
            ("Evidence reviewed.\nVERDICT: PASS", 2),
            ("Evidence reviewed.\nVERDICT: PASS\nVERDICT: PASS", 0),
            ("Evidence reviewed.\nVERDICT: PASS\nmore text", 0),
            ("Evidence reviewed.\n VERDICT: PASS", 0),
            ("Evidence reviewed.\nVERDICT: PASS ", 0),
            ("Evidence reviewed without a verdict.", 0),
        ]:
            self.assertFalse(self.module.valid(output, status))


    def test_generic_budget_overrides(self):
        limits = {"CHAIR_MAX_TURNS": "8", "CHAIR_FALLBACK_MAX_TURNS": "12",
                  "CHAIR_FAST_FAIL_S": "5"}
        with patch.dict(os.environ, limits):
            options = self.module.chair_options({})
        self.assertEqual(options["turns"], (8, 12))
        self.assertEqual(options["fast_fail"], 5)
        for name in limits:
            for value in ("0", "-1"):
                with self.subTest(name=name, value=value), \
                        patch.dict(os.environ, {name: value}), \
                        self.assertRaises(ValueError):
                    self.module.legacy_limit(name)


    def fenced_code(self, example):
        """Fence selected code fixtures; leave surrounding review prose outside."""
        longest = max((len(run) for run in re.findall(r"`+", example)), default=0)
        fence = "`" * max(3, longest + 1)
        return f"{fence}text\n{example}\n{fence}\n"

    def assert_format_rejected(self, report, secret="private-value"):
        reply = (0, report, "")
        calls, text = self.run_chair([reply, reply])
        self.assertEqual(calls, 2)
        self.assertIn("failed the review format contract", text)
        self.assertNotIn(secret, text)
        self.assertTrue(text.endswith("VERDICT: FAIL\n"))

    def test_fenced_commands_preserve_following_findings_and_references(self):
        for prefix in ("env ", "curl -d ", "USER=demo ", "export\n"):
            with self.subTest(prefix=prefix):
                reply = (0, self.fenced_code(prefix + "password='private-value'")
                         + "\nMAJOR rollback evidence. See `service` and `validate()`.\n"
                         "VERDICT: FAIL\n", "")
                calls, text = self.run_chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertNotIn("private-value", text)
                self.assertIn("MAJOR rollback evidence.", text)
                self.assertIn("`service`", text)
                self.assertTrue(text.endswith("VERDICT: FAIL\n"))

    def test_literal_backticks_in_top_level_fenced_code_remain_private(self):
        example = "cat <<'EOF'\n> ```\nEOF\necho '`'\npassword=`printf 'private-value'`"
        reply = (0, self.fenced_code(example)
                 + "\nReviewed behavior.\nVERDICT: PASS\n", "")
        calls, text = self.run_chair([reply, reply])
        self.assertEqual(calls, 1)
        self.assertNotIn("private-value", text)
        self.assertIn("Reviewed behavior.", text)
        self.assertTrue(text.endswith("VERDICT: PASS\n"))

    def test_scrubbing_that_removes_closing_fence_is_format_rejected(self):
        for report in (
            "```dotenv\npassword=\n```\nPUBLIC_AFTER\nVERDICT: PASS\n",
        ):
                with self.subTest(report=report):
                    self.assertIsNone(self.module.format_violation(report, self.module.SENSITIVE_KEY))
                    filtered = self.module.scrub_decoded(self.module.scrub(report))
                    self.assertEqual(
                        self.module.format_violation(filtered, self.module.SENSITIVE_KEY),
                        "unsupported_review_format")
                    self.assert_format_rejected(report)

    def test_fenced_quoted_empty_values_preserve_review(self):
        for value in ("''", '""'):
            with self.subTest(value=value):
                reply = (0, self.fenced_code("password=" + value)
                         + "\nPUBLIC_AFTER\nVERDICT: PASS\n", "")
                calls, text = self.run_chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertIn("PUBLIC_AFTER", text)
                self.assertTrue(text.endswith("VERDICT: PASS\n"))

if __name__ == "__main__":
    unittest.main()
