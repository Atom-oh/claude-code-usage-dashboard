"""Legacy Linux migration, exercising real files with simulated systemd, sudo and socket I/O."""
import errno
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "ccd1." + "a" * 64 + "." + "b" * 32 + "." + "C" * 43
LEGACY_PID = "5797"


class LinuxMigration(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("linux_migration_installer", ROOT / "install.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        self.home = base / "home"
        self.root = self.home / ".local/share/ccdash-collector"
        self.unit = self.home / ".config/systemd/user/ccdash-collector.service"
        self.system = base / "etc/systemd/system"
        self.legacy = self.system / "otelcol.service"
        self.dropin = self.system / "otelcol.service.d/codex-telemetry.conf"
        self.backup = self.system / "otelcol.service.ccdash-backup"
        self.config = self.home / ".otelcol/config.yaml"
        self.env = self.home / ".otelcol/env"
        self.helper = self.home / ".otelcol/enable-test-telemetry.sh"
        self.queue = self.home / ".otelcol/queue/pending"
        self.binary = self.home / ".local/bin/otelcol-contrib"
        for path, content in ((self.config, "legacy configuration"), (self.env, "PRIVATE_FIXTURE"),
                              (self.helper, "old shell identity"), (self.queue, "unexported records"),
                              (self.binary, "old binary")):
            self.module.atomic(path, content)
        self.unit_text = ("[Unit]\nDescription=OpenTelemetry Collector\n\n[Service]\nUser=fixture\n"
                          "ExecStart=" + str(self.binary) + " --config=" + str(self.config) + "\n")
        self.module.atomic(self.legacy, self.unit_text, 0o644)
        self.module.atomic(self.dropin, "[Service]\nEnvironment=CODEX_ENABLED=true\n", 0o644)
        self.original = {p: p.read_bytes() for p in (self.config, self.env, self.helper, self.queue,
                                                     self.legacy, self.dropin)}
        self.token = self.home / "supplied-token"
        self.module.atomic(self.token, TOKEN)
        claude = self.home / ".claude/settings.json"
        self.module.atomic(claude, json.dumps({"model": "original", "env": {
            "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4317",
            "OTEL_RESOURCE_ATTRIBUTES": "user.email=legacy@example.invalid,team=fixture-team"}}) + "\n")
        self.args = SimpleNamespace(endpoint="https://dashboard.example/api/ingest", token_file=self.token,
                                    user_id=None, migrate_legacy=True, default_user_id="approver@example.invalid")
        self.active = True
        self.enabled = True
        self.masked = False
        self.exec_config = str(self.config)
        self.service_user = "fixture"
        self.port_pid = LEGACY_PID
        self.running = set()
        self.start_error = False
        self.sudo = []
        self.output = io.StringIO()
        contexts = [
            patch.object(self.module.sys, "platform", "linux"),
            patch.object(self.module, "LEGACY_LINUX_UNIT", self.legacy),
            patch.object(self.module, "LEGACY_LINUX_OWNER", os.getuid()),
            patch.object(self.module, "run", self.external),
            patch.object(self.module, "download_binary", self.download),
            patch.object(self.module.socket, "socket"),
            patch.object(http.client, "HTTPConnection"),
            patch("sys.stdout", self.output),
        ]
        for context in contexts:
            mock = context.start()
            self.addCleanup(context.stop)
            if context.attribute == "socket":
                mock.return_value.__enter__.return_value.bind.side_effect = self.bind
                mock.return_value.__enter__.return_value.connect_ex.return_value = errno.ECONNREFUSED
            if context.attribute == "HTTPConnection":
                mock.return_value.getresponse.return_value.status = 200

    def download(self, stage, release):
        self.assertEqual(self.active, self.active_before, "the old service must survive preparation")
        self.module.atomic(stage / "otelcol-contrib", "new binary", 0o700)

    def bind(self, address):
        if address[1] in (4317, 4318, 13133) and (self.active or self.unit.name in self.running):
            raise OSError(errno.EADDRINUSE, "address in use")

    def show(self):
        lines = {
            "LoadState": "masked" if self.masked else "loaded",
            "ActiveState": "active" if self.active else "inactive",
            "UnitFileState": "masked" if self.masked else ("enabled" if self.enabled else "disabled"),
            "FragmentPath": "" if self.masked else str(self.legacy),
            "DropInPaths": str(self.dropin),
            "User": self.service_user,
            "MainPID": LEGACY_PID if self.active else "0",
            "ExecStart": ("{ path=" + str(self.binary) + " ; argv[]=" + str(self.binary) + " --config="
                          + self.exec_config + " ; ignore_errors=no ; start_time=[n/a] ; pid=0 ; code=(null) }"),
        }
        return "\n".join(key + "=" + value for key, value in lines.items())

    def external(self, command, required=True, output=False):
        if command[0].endswith("otelcol-contrib"):
            return True
        if command[:2] == ["systemctl", "show"] and command[2] == "otelcol.service":
            return self.show() if output else True
        if command[0] == "ss":
            if not self.active:
                return ""
            port = command[-1].split(":")[-1]
            return ("LISTEN 0 4096 127.0.0.1:" + port + " 0.0.0.0:* users:((\"otelcol-contrib\",pid="
                    + self.port_pid + ",fd=9))")
        if command[0] == "sudo":
            self.sudo.append(command[1:])
            return self.privileged(command[1:])
        user = command[:2] == ["systemctl", "--user"]
        if user and command[2] in ("show-environment", "daemon-reload"):
            return True
        if user and command[2] == "show":
            return "" if output else True
        if user and command[2] == "is-active":
            return command[-1] in self.running
        if user and command[2] == "is-enabled":
            return False
        if user and command[2:4] == ["enable", "--now"]:
            self.assertFalse(self.active, "the old service is stopped before the new one starts")
            self.running.add(command[-1])
            if self.start_error and command[-1] == self.unit.name:
                raise ValueError("simulated startup failure")
            return True
        if user and command[2:4] == ["disable", "--now"]:
            self.running.discard(command[-1])
            return True
        self.fail("unexpected OS command: " + repr(command))

    def privileged(self, command):
        if command == ["-v"]:
            pass
        elif command == ["cp", "-p", str(self.legacy), str(self.backup)]:
            shutil.copy2(self.legacy, self.backup)
        elif command == ["systemctl", "disable", "--now", "otelcol.service"]:
            self.active = self.enabled = False
        elif command == ["rm", str(self.legacy)]:
            self.legacy.unlink()
        elif command == ["systemctl", "mask", "otelcol.service"]:
            self.legacy.symlink_to("/dev/null")
            self.masked = True
        elif command == ["systemctl", "unmask", "otelcol.service"]:
            if self.legacy.is_symlink():
                self.legacy.unlink()
            self.masked = False
        elif command == ["mv", str(self.backup), str(self.legacy)]:
            self.backup.rename(self.legacy)
        elif command == ["rm", str(self.backup)]:
            self.backup.unlink()
        elif command == ["systemctl", "daemon-reload"]:
            pass
        elif command == ["systemctl", "enable", "otelcol.service"]:
            self.enabled = True
        elif command == ["systemctl", "start", "otelcol.service"]:
            self.active = True
        else:
            self.fail("unexpected sudo command: " + repr(command))
        return True

    def install(self):
        self.active_before = self.active
        self.module.install(self.args, self.home, "fixture", os.getuid(), self.root, self.unit)

    def test_confirmed_migration_masks_the_legacy_unit_and_keeps_the_existing_identity(self):
        self.install()
        self.assertTrue(self.legacy.is_symlink() and self.masked)
        self.assertEqual(self.backup.read_bytes(), self.original[self.legacy])
        self.assertIn(self.unit.name, self.running)
        self.assertEqual(self.sudo[:5], [["-v"], ["cp", "-p", str(self.legacy), str(self.backup)],
                                         ["systemctl", "disable", "--now", "otelcol.service"],
                                         ["rm", str(self.legacy)], ["systemctl", "mask", "otelcol.service"]])
        state = json.loads((self.root / "state.json").read_text())
        self.assertEqual(state["userId"], "legacy@example.invalid", "the approving account does not replace it")
        for path in (self.config, self.env, self.helper, self.queue, self.dropin):
            self.assertEqual(path.read_bytes(), self.original[path], "legacy files stay for recovery")
        backups = list(self.root.glob("legacy-backup-*"))
        self.assertEqual(len(backups), 1)
        record = json.loads((backups[0] / "migration.json").read_text())
        self.assertEqual((record["service"], record["active"], record["enabled"]), (str(self.legacy), True, True))
        self.assertEqual((backups[0] / "otelcol.service").read_bytes(), self.original[self.legacy])
        self.assertIn("sudo", self.output.getvalue())

    def test_failed_new_start_restores_the_legacy_service_and_its_unit(self):
        self.start_error = True
        with self.assertRaises(ValueError):
            self.install()
        self.assertFalse(self.legacy.is_symlink())
        self.assertEqual(self.legacy.read_bytes(), self.original[self.legacy])
        self.assertFalse(self.backup.exists())
        self.assertTrue(self.active and self.enabled and not self.masked)
        self.assertNotIn(self.unit.name, self.running)

    def test_originally_stopped_and_disabled_legacy_stays_so_on_failure(self):
        self.active = self.enabled = False
        self.start_error = True
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(self.legacy.read_bytes(), self.original[self.legacy])
        self.assertFalse(self.active or self.enabled or self.masked)
        self.assertNotIn(["systemctl", "start", "otelcol.service"], self.sudo)

    def test_declining_prompt_keeps_legacy_running_without_privileged_changes(self):
        self.args.migrate_legacy = False
        with patch.object(self.module.sys.stdin, "isatty", return_value=True), \
                patch("builtins.input", return_value="n"):
            with self.assertRaisesRegex(ValueError, "cancelled"):
                self.install()
        self.assertEqual(self.sudo, [])
        self.assertTrue(self.active)
        self.assertFalse(self.root.joinpath("state.json").exists() and
                         "userId" in self.root.joinpath("state.json").read_text())

    def test_noninteractive_migration_requires_explicit_option(self):
        self.args.migrate_legacy = False
        with patch.object(self.module.sys.stdin, "isatty", return_value=False):
            with self.assertRaisesRegex(ValueError, "--migrate-legacy"):
                self.install()
        self.assertEqual(self.sudo, [])

    def test_unit_for_another_configuration_or_user_is_not_migrated(self):
        for field, value in (("exec_config", str(self.home / "other.yaml")), ("service_user", "someone-else")):
            with self.subTest(field=field):
                setattr(self, field, value)
                with self.assertRaisesRegex(ValueError, "unverified service"):
                    self.install()
                self.assertEqual(self.sudo, [])
                setattr(self, field, str(self.config) if field == "exec_config" else "fixture")

    def test_port_owned_by_another_process_blocks_before_stopping_legacy(self):
        self.port_pid = "999"
        with self.assertRaisesRegex(ValueError, "unverified service"):
            self.install()
        self.assertEqual(self.sudo, [])
        self.assertTrue(self.active)

    def test_existing_backup_from_an_earlier_migration_blocks_before_changes(self):
        self.module.atomic(self.backup, "earlier migration", 0o644)
        with self.assertRaisesRegex(ValueError, "earlier migration"):
            self.install()
        self.assertEqual(self.sudo, [])
        self.assertEqual(self.backup.read_text(), "earlier migration")

    def test_unit_writable_by_others_is_not_trusted(self):
        self.legacy.chmod(0o666)
        with self.assertRaisesRegex(ValueError, "manual migration"):
            self.install()
        self.assertEqual(self.sudo, [])

    def test_stopped_unit_for_another_configuration_does_not_block_installation(self):
        self.exec_config = str(self.home / "workshop.yaml")
        self.active = False
        self.install()
        self.assertEqual(self.sudo, [])
        self.assertEqual(self.legacy.read_bytes(), self.original[self.legacy])
        self.assertIn(self.unit.name, self.running)

    def test_group_writable_helper_is_private_only_inside_an_owner_only_directory(self):
        self.helper.chmod(0o664)
        self.helper.parent.chmod(0o700)
        self.install()
        self.assertTrue(self.masked)

    def test_group_writable_helper_in_a_shared_directory_is_rejected(self):
        self.helper.chmod(0o664)
        self.helper.parent.chmod(0o775)
        self.addCleanup(self.helper.parent.chmod, 0o700)
        with self.assertRaisesRegex(ValueError, "chmod go-w"):
            self.install()
        self.assertEqual(self.sudo, [])

    def test_masked_legacy_is_already_migrated_and_never_touched(self):
        self.legacy.unlink()
        self.legacy.symlink_to("/dev/null")
        self.active, self.masked = False, True
        self.install()
        self.assertEqual(self.sudo, [])
        self.assertIn(self.unit.name, self.running)


if __name__ == "__main__":
    unittest.main()
