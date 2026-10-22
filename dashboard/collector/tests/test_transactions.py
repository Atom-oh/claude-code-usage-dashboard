"""Installer transaction regressions; service/download boundaries are simulated."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "ccd1." + "a" * 64 + "." + "b" * 32 + "." + "C" * 43


class Transactions(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("installer_transaction", ROOT / "install.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.root = self.home / ".local/share/ccdash-collector"
        self.unit = self.home / ".config/systemd/user/ccdash-collector.service"
        self.codex = self.home / ".codex/config.toml"
        self.claude = self.home / ".claude/settings.json"
        self.codex.parent.mkdir()
        self.claude.parent.mkdir()
        self.codex.write_text('model="original"\n')
        self.claude.write_text('{"model":"original","env":{"OTEL_RESOURCE_ATTRIBUTES":"user.email=old"}}')
        self.token = self.home / "supplied-token"
        self.token.write_text(TOKEN)
        self.token.chmod(0o600)
        self.args = SimpleNamespace(endpoint="https://dashboard.example/api/ingest",
                                    user_id="old", token_file=self.token)
        self.running = False
        self.start_failure = None
        self.download_hook = None
        self.stop_count = 0
        self.patches = [
            patch.object(self.module, "run", self.external),
            patch.object(self.module, "download_binary", self.download),
            patch.object(self.module.socket, "socket"),
        ]
        for context in self.patches:
            mock = context.start()
            if context.attribute == "socket":
                mock.return_value.__enter__.return_value.connect_ex.return_value = self.module.errno.ECONNREFUSED
            self.addCleanup(context.stop)

    def download(self, stage, release):
        self.module.atomic(stage / "otelcol-contrib", "#!/bin/sh\nexit 0\n", 0o700)
        if self.download_hook:
            self.download_hook()

    def external(self, command, required=True, output=False):
        if output:
            return ""
        if "is-active" in command:
            return self.running
        if "disable" in command:
            self.running = False
            self.stop_count += 1
        if "enable" in command:
            self.running = True
            if self.start_failure:
                failure, self.start_failure = self.start_failure, None
                failure()
                raise ValueError("simulated startup failure")
        return True

    def install(self):
        self.module.install(self.args, self.home, "fixture", os.getuid(), self.root, self.unit)

    def snapshot(self):
        paths = [path for path in self.root.rglob("*") if path.is_file() and path.name != ".install.lock"]
        return {str(path): (path.read_bytes(), path.stat().st_mode & 0o777) for path in [*paths, self.unit]}

    def test_client_edit_during_download_keeps_old_service_and_installed_files(self):
        self.install()
        original = self.snapshot()
        edited = self.codex.read_text().replace('model="original"', 'model="externally-changed"')
        self.download_hook = lambda: self.codex.write_text(edited)
        self.token.write_text(TOKEN[:-1] + "D")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.install()
        self.assertTrue(self.running)
        self.assertEqual(self.stop_count, 0)
        self.assertEqual(self.codex.read_text(), edited)
        self.assertEqual(self.snapshot(), original)

    def test_start_failure_restores_old_service_files_and_client_config(self):
        self.install()
        original = self.snapshot()
        old_claude = self.claude.read_bytes()
        self.token.write_text(TOKEN[:-1] + "D")
        self.args.user_id = "replacement"
        self.start_failure = lambda: None
        with self.assertRaisesRegex(ValueError, "startup failure"):
            self.install()
        self.assertTrue(self.running)
        self.assertEqual(self.snapshot(), original)
        self.assertEqual(self.claude.read_bytes(), old_claude)

    def test_rollback_preserves_client_edit_after_installer_wrote_configuration(self):
        self.install()
        original = self.snapshot()
        self.args.user_id = "replacement"
        edited = {}
        def edit():
            data = json.loads(self.claude.read_text())
            data["model"] = "externally-changed"
            edited["text"] = json.dumps(data)
            self.claude.write_text(edited["text"])
        self.start_failure = edit
        with self.assertRaisesRegex(ValueError, "startup failure"):
            self.install()
        self.assertTrue(self.running)
        self.assertEqual(self.snapshot(), original)
        self.assertEqual(self.claude.read_text(), edited["text"])

    def test_new_install_failure_restores_existing_client_config(self):
        original_claude, original_codex = self.claude.read_bytes(), self.codex.read_bytes()
        self.start_failure = lambda: None
        with self.assertRaisesRegex(ValueError, "startup failure"):
            self.install()
        self.assertFalse(self.running)
        self.assertFalse(self.unit.exists())
        self.assertFalse((self.root / "token").exists())
        self.assertEqual(self.claude.read_bytes(), original_claude)
        self.assertEqual(self.codex.read_bytes(), original_codex)

    def test_failed_recovery_retains_private_backups_for_manual_restore(self):
        self.install()
        old_token = (self.root / "token").read_bytes()
        self.token.write_text(TOKEN[:-1] + "D")
        def fail_recovery_too():
            self.start_failure = lambda: None
        self.start_failure = fail_recovery_too
        with self.assertRaisesRegex(ValueError, "private recovery files remain"):
            self.install()
        backups = list(self.root.glob(".prepare-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.root / "token").read_bytes(), old_token)
        self.assertEqual((backups[0] / "before-managed/0").read_bytes(), old_token)
        self.assertEqual((backups[0] / "before-managed/0").stat().st_mode & 0o777, 0o600)

    def test_systemd_exec_disables_environment_expansion_for_literal_paths(self):
        unit = self.module.systemd_service(Path("/home/${HOME} $SHELL/collector"))
        self.assertIn('ExecStart=:"/home/${HOME} $SHELL/collector/otelcol-contrib"', unit)
        self.assertIn('" --config "/home/${HOME} $SHELL/collector/config.yaml"', unit)

    def test_codex_directory_and_worktree_switches_do_not_infer_backend(self):
        spec = importlib.util.spec_from_file_location("launcher_cd", ROOT / "launch-codex.py")
        launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(launcher)
        for arguments in (["-C", "/project"], ["-C/project"], ["--cd", "/project"],
                          ["--cd=/project"], ["--worktree", "/project"], ["-p", "work"],
                          ["--profile=work"], ["--profile", "work"], ["-pwork"],
                          ["-c", 'profile="work"']):
            with self.subTest(arguments=arguments):
                command, _ = launcher.launch_command({"model_provider": "amazon-bedrock"}, list(arguments), {})
                self.assertFalse(any("bedrock-mantle" in argument for argument in command))
                self.assertEqual(command[-len(arguments):], arguments)


if __name__ == "__main__":
    unittest.main()
