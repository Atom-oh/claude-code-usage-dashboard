"""Installer transaction regressions; service/download boundaries are simulated."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
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
        self.renewal = [self.home / ".config/systemd/user" / name for name in
                        ("ccdash-collector-renew.service", "ccdash-collector-renew.timer")]
        self.renewal_active = False
        self.renewal_failure = False
        self.commands = []
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
        self.commands.append(command)
        if output:
            return ""
        if any(str(part).startswith("ccdash-collector-renew") for part in command):
            if "is-active" in command:
                return self.renewal_active
            if "disable" in command:
                self.renewal_active = False
            if "enable" in command:
                if self.renewal_failure:
                    self.renewal_failure = False
                    raise ValueError("simulated renewal schedule failure")
                self.renewal_active = True
            return True
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

    def main(self, *argv):
        account = SimpleNamespace(pw_dir=str(self.home), pw_name="fixture", pw_uid=os.getuid(), pw_gid=os.getgid())
        output = io.StringIO()
        with patch.object(self.module.os, "geteuid", return_value=1000), \
                patch.object(self.module.pwd, "getpwuid", return_value=account), \
                patch.object(self.module.sys, "argv", ["install.py", *argv]), \
                patch.dict(os.environ, {"CODEX_HOME": "", "CLAUDE_CONFIG_DIR": ""}), \
                patch.object(self.module, "local_collector_healthy", return_value=True), \
                patch("sys.stdout", output):
            return self.module.main(), output.getvalue()

    def snapshot(self):
        paths = [path for path in self.root.rglob("*") if path.is_file() and path.name != ".install.lock"]
        renewal = [p for p in self.renewal if p.exists()]
        return {str(path): (path.read_bytes(), path.stat().st_mode & 0o777)
                for path in [*paths, self.unit, *renewal]}

    def test_renewal_schedule_failure_restores_previous_installation(self):
        self.install()
        original = self.snapshot()
        self.assertTrue(self.renewal_active)
        self.token.write_text(TOKEN[:-1] + "D")
        self.renewal_failure = True
        with self.assertRaisesRegex(ValueError, "renewal schedule failure"):
            self.install()
        self.assertTrue(self.running)
        self.assertTrue(self.renewal_active)
        self.assertEqual(self.snapshot(), original)

    def test_install_schedules_renewal_and_uninstall_removes_it(self):
        self.install()
        service, timer = (path.read_text() for path in self.renewal)
        self.assertTrue(service.startswith("# " + self.module.MARKER))
        self.assertIn("Type=oneshot", service)
        command = [sys.executable, self.root / "install.py", "renew"]
        self.assertIn("ExecStart=:" + " ".join(self.module.systemd_quote(part) for part in command), service)
        for line in ("OnCalendar=daily", "RandomizedDelaySec=2h", "Persistent=true", "WantedBy=timers.target"):
            self.assertIn(line, timer)
        self.assertTrue(self.renewal_active)
        self.module.atomic(self.root / "renew-state.json", "{}\n")
        self.assertEqual(self.main("uninstall")[0], 0)
        for path in (*self.renewal, self.unit, self.root / "token", self.root / "renew-state.json"):
            self.assertFalse(path.exists(), path)
        self.assertFalse(self.renewal_active)

    def test_reinstall_stops_the_renewal_timer_before_replacing_files(self):
        self.install()
        self.commands.clear()
        self.install()
        timer = ["systemctl", "--user", "disable", "--now", "ccdash-collector-renew.timer"]
        self.assertLess(self.commands.index(timer), self.commands.index(timer[:2] + ["enable"] + timer[3:]))

    def test_upgrade_reuses_the_installed_token_file(self):
        self.install()
        for path in self.renewal:
            path.unlink()
        self.renewal_active = False
        self.args.token_file = self.root / "token"
        self.install()
        self.assertEqual((self.root / "token").read_text(), TOKEN + "\n")
        self.assertTrue(all(path.exists() for path in self.renewal) and self.renewal_active)

    def test_status_reports_schedule_and_last_renewal_without_secrets(self):
        self.install()
        state = self.root / "renew-state.json"
        self.module.atomic(state, json.dumps({"time": "2026-10-28T00:00:00Z", "outcome": "not_due"}))
        code, out = self.main("status")
        data = json.loads(out)
        self.assertEqual((code, data["renewalScheduled"]), (0, True))
        self.assertEqual(data["lastRenewal"], {"time": "2026-10-28T00:00:00Z", "outcome": "not_due"})
        self.assertIn("unknown", data["tokenExpiry"])
        self.assertNotIn(TOKEN, out)
        self.module.atomic(state, json.dumps({"time": "x", "outcome": "renewed"}))
        self.assertIsNone(json.loads(self.main("status")[1])["lastRenewal"])
        self.renewal_active = False
        code, out = self.main("status")
        self.assertEqual((code, json.loads(out)["renewalScheduled"]), (1, False))

    def test_migration_flag_without_legacy_does_not_replace_claude_telemetry(self):
        original = '{"env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"https://previous.example"}}\n'
        self.claude.write_text(original)
        for flag in (False, True):
            with self.subTest(migrate_legacy=flag):
                self.args.migrate_legacy = flag
                with self.assertRaisesRegex(ValueError, "unmanaged Claude telemetry"):
                    self.install()
                self.assertEqual(self.claude.read_text(), original)
                self.assertFalse(self.root.exists())
                self.assertFalse(self.running)

    def test_cli_explicitly_replaces_claude_telemetry_without_legacy(self):
        original = '{"model":"original","env":{"OTEL_EXPORTER_OTLP_HEADERS":"fixture-header"}}\n'
        self.claude.write_text(original)
        account = SimpleNamespace(pw_dir=str(self.home), pw_name="fixture",
                                  pw_uid=os.getuid(), pw_gid=os.getgid())
        argv = ["install.py", "install", "--endpoint", self.args.endpoint,
                "--token-file", str(self.token), "--user-id", "old", "--replace-claude-telemetry"]
        with patch.object(self.module.os, "geteuid", return_value=1000), \
                patch.object(self.module.pwd, "getpwuid", return_value=account), \
                patch.object(self.module.sys, "argv", argv), \
                patch.dict(os.environ, {"CODEX_HOME": "", "CLAUDE_CONFIG_DIR": ""}):
            self.assertEqual(self.module.main(), 0)
        data = json.loads(self.claude.read_text())
        self.assertEqual(data["model"], "original")
        self.assertEqual(data["env"]["OTEL_EXPORTER_OTLP_HEADERS"], "")
        self.assertEqual(data["env"]["OTEL_EXPORTER_OTLP_ENDPOINT"], "http://127.0.0.1:4317")
        self.assertTrue(self.running)
        backups = list(self.claude.parent.glob("settings.json.ccdash-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), original)

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
