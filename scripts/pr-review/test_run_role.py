"""Behavioral tests for the subprocess boundary; no provider calls."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


MODULE = Path(__file__).with_name("run_role.py")


class RoleExecutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not MODULE.exists():
            return
        spec = importlib.util.spec_from_file_location("run_role", MODULE)
        cls.runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.runner)

    def setUp(self):
        self.assertTrue(MODULE.exists(), "The single-role executor is not implemented")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.final_file = self.root / "final.txt"
        self.final_file.write_text("{}\n")

    def executable(self, text):
        path = self.root / "fake-cli"
        path.write_text("#!/usr/bin/env python3\n" + text)
        path.chmod(0o755)
        return str(path)

    def test_process_status_is_not_inferred_from_nonempty_stdout(self):
        cli = self.executable("print('a plausible review'); raise SystemExit(7)\n")
        code, output, error = self.runner.execute([cli], self.root, os.environ.copy(), "", 2)
        self.assertEqual(code, 7)
        self.assertEqual(output.strip(), "a plausible review")

    def test_timeout_kills_a_child_that_ignores_termination(self):
        cli = self.executable(
            "import signal,time\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "print('partial output', flush=True)\ntime.sleep(30)\n"
        )
        code, output, error = self.runner.execute([cli], self.root, os.environ.copy(), "", 0.1)
        self.assertEqual(code, 124)
        self.assertIn("partial output", output)

    def test_kiro_environment_contains_no_cloud_or_repository_credentials(self):
        source = {
            "PATH": "/usr/bin", "KIRO_API_KEY": "test-key",
            "AWS_SECRET_ACCESS_KEY": "private", "GH_TOKEN": "private",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI": "private",
        }
        result = self.runner.kiro_environment(self.root, source)
        self.assertEqual(result["KIRO_API_KEY"], "test-key")
        self.assertEqual(result["HOME"], str(self.root))
        self.assertFalse(any(k.startswith("AWS_") or k == "GH_TOKEN" for k in result))

    def test_preflight_rejects_quota_or_model_fallback_despite_no_tools_reply(self):
        for message in (
            "Monthly request limit reached",
            "[warn] failed to set model: Method not found",
            "Falling back to user specified default",
            "using \x1b[1mtool:\x1b[0m fs_read",
            "quota exceeded",
        ):
            with self.subTest(message=message):
                cli = self.executable(
                    "import sys\nprint('NO_TOOLS')\n"
                    f"print({message!r}, file=sys.stderr)\n"
                )
                ok, code, error = self.runner.preflight(
                    cli, "claude-opus-5", self.root, os.environ.copy(), 2
                )
                self.assertFalse(ok)

    def test_wrapper_withholds_all_kiro_input_when_one_preflight_fails(self):
        self.wrapper_case(True)

    def test_wrapper_releases_input_only_after_both_preflights_succeed(self):
        self.wrapper_case(False)

    def wrapper_case(self, preflight_error):
        scripts = self.root / "scripts"
        scripts.mkdir()
        for name in ("run-specialists.sh", "run_role.py", "role_review.py",
                     "lib.sh", "role-controls.sh"):
            shutil.copyfile(MODULE.parent / name, scripts / name)
        (scripts / "prepare_roles.py").write_text(
            "import pathlib,subprocess,sys\n"
            "work=pathlib.Path(sys.argv[sys.argv.index('--work')+1]);work.mkdir(exist_ok=True)\n"
            "context=work/'context';context.write_text('Trusted base context')\n"
            "subprocess.run([sys.executable,str(pathlib.Path(__file__).with_name('role_review.py')),"
            "'prepare','--diff',sys.argv[sys.argv.index('--prepared-diff')+1],"
            "'--context',str(context),'--head','a'*40,'--base','b'*40,'--work',str(work)],check=True)\n"
        )
        diff = self.root / "raw.diff"
        diff.write_text("diff --git a/infra/main.tf b/infra/main.tf\n"
                        "--- a/infra/main.tf\n+++ b/infra/main.tf\n"
                        "@@ -1 +1 @@\n-old\n+new\n")
        binary = self.root / "bin"
        binary.mkdir()
        for name in ("kiro-cli", "codex", "claude"):
            file = binary / name
            file.write_text("#!/usr/bin/env python3\nimport pathlib,sys,time\n"
                f"root=pathlib.Path({str(self.root)!r})\n"
                "if sys.argv[1]!='chat': raise SystemExit(1)\n"
                "model=sys.argv[sys.argv.index('--model')+1]\n"
                "if 'preflight-canary.txt' not in sys.argv[2]:\n"
                " (root/'pr-input-received').write_text(model);raise SystemExit(1)\n"
                "(root/model).write_text('preflight called')\n"
                f"if model=='gpt-5.6-sol' and {preflight_error!r}:\n"
                " time.sleep(0.3);print('using tool: fs_read',file=sys.stderr)\n"
                "print('NO_TOOLS')\n")
            file.chmod(0o755)
        result = subprocess.run(["bash", str(scripts / "run-specialists.sh"),
            str(diff), str(self.root), str(self.root / "work")],
            env={**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                 "PANEL_RETRIES": "1", "PANEL_TIMEOUT": "2", "KIRO_PREFLIGHT_TIMEOUT": "2"},
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.root / "claude-opus-5").exists())
        self.assertTrue((self.root / "gpt-5.6-sol").exists())
        self.assertEqual((self.root / "pr-input-received").exists(), not preflight_error)
        summary = json.loads((self.root / "work/role-summary.json").read_text())
        self.assertEqual(summary["mode"], "blocked")

    def test_preflight_uses_empty_catalog_and_never_receives_pr_input(self):
        cli = self.executable(
            "import json,pathlib,sys\n"
            "agent=json.loads(pathlib.Path('.kiro/agents/inline-review.json').read_text())\n"
            "assert agent['tools']==[] and agent['allowedTools']==[]\n"
            "assert sys.stdin.read()==''\n"
            "assert '--agent' in sys.argv and '--v3' not in sys.argv\n"
            "assert 'preflight-canary.txt' in sys.argv[2]\n"
            "print('> NO_TOOLS')\n"
        )
        ok, code, error = self.runner.preflight(
            cli, "claude-opus-5", self.root, os.environ.copy(), 2
        )
        self.assertTrue(ok, error)
        self.assertEqual(code, 0)

    def test_codex_transport_requires_a_complete_unambiguous_event_stream(self):
        message = {"type": "item.completed", "item": {
            "id": "reply", "type": "agent_message", "text": '{"review":"exact"}',
        }}
        start = {"type": "turn.started"}
        done = {"type": "turn.completed", "usage": {
            "input_tokens": 1, "cached_input_tokens": 0, "output_tokens": 1,
        }}
        self.assertTrue(hasattr(self.runner, "codex_response"))
        for events in ([start, message], [start, done],
                       [start, message, {"type": "turn.failed", "error": {"message": "failed"}}],
                       [start, message, done, message],
                       [start, message, start, done], [start, message, done, "invalid"]):
            with self.subTest(events=events):
                raw = "\n".join(json.dumps(event) for event in events)
                output, error, valid = self.runner.codex_response(raw, self.final_file)
                self.assertFalse(valid)
                self.assertEqual(output, "")

    def test_codex_transport_uses_cli_final_file_without_concatenating_progress(self):
        self.assertTrue(hasattr(self.runner, "codex_response"))
        raw = "\n".join(json.dumps(event) for event in [
            {"type": "turn.started"},
            {"type": "item.completed", "item": {
                "id": "first", "type": "agent_message", "text": '{"first":true}\n'}},
            {"type": "item.completed", "item": {
                "id": "second", "type": "agent_message", "text": '{"second":true}\n'}},
            {"type": "turn.completed", "usage": {
                "input_tokens": 1, "cached_input_tokens": 0, "output_tokens": 1}},
        ])
        self.final_file.write_text('{"second":true}\n')
        output, error, valid = self.runner.codex_response(raw, self.final_file)
        self.assertTrue(valid, error)
        self.assertEqual(output, '{"second":true}\n')
        self.assertEqual(error, "")

    def test_codex_recovered_error_is_forwarded_without_invalidating_completed_turn(self):
        raw = "\n".join(json.dumps(event) for event in [
            {"type": "turn.started"},
            {"type": "error", "message": "Reconnecting... stream disconnected before completion"},
            {"type": "item.completed", "item": {
                "id": "reply", "type": "agent_message", "text": '{"review":"complete"}'}},
            {"type": "turn.completed", "usage": {
                "input_tokens": 1, "cached_input_tokens": 0, "output_tokens": 1}},
        ])
        self.final_file.write_text('{"review":"complete"}\n')
        output, error, valid = self.runner.codex_response(raw, self.final_file)
        self.assertTrue(valid, error)
        self.assertEqual(output, '{"review":"complete"}\n')
        self.assertIn("Reconnecting", error)


if __name__ == "__main__":
    unittest.main()
