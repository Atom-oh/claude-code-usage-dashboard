"""Legacy macOS migration, exercising real files with simulated launchd/socket I/O."""
import errno
import importlib.util
import http.client
import io
import json
import os
from pathlib import Path
import plistlib
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "ccd1." + "a" * 64 + "." + "b" * 32 + "." + "C" * 43


class Migration(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("migration_installer", ROOT / "install.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.root = self.home / ".local/share/ccdash-collector"
        self.unit = self.home / "Library/LaunchAgents/org.ccdash.collector.plist"
        self.legacy = self.unit.with_name("com.ccdash.otelcol.plist")
        self.config = self.home / ".otelcol/config.yaml"
        self.env = self.home / ".otelcol/env"
        self.queue = self.home / ".otelcol/queue/pending"
        self.helper = self.home / ".otelcol/enable-test-telemetry.sh"
        self.binary = self.home / ".local/bin/otelcol-contrib"
        for path, content in ((self.config, "legacy configuration"), (self.env, "PRIVATE_FIXTURE"),
                              (self.queue, "unexported records"), (self.helper, "old shell identity"),
                              (self.binary, "old binary")):
            self.module.atomic(path, content)
        self.arguments = [str(self.binary), "--config=" + str(self.config)]
        self.module.atomic(self.legacy, plistlib.dumps({
            "Label": "com.ccdash.otelcol", "ProgramArguments": self.arguments,
            "EnvironmentVariables": {"PRIVATE": "PRIVATE_FIXTURE"}, "KeepAlive": True,
        }))
        self.original = {p: p.read_bytes() for p in (self.config, self.env, self.queue, self.helper, self.legacy)}
        self.token = self.home / "supplied-token"
        self.module.atomic(self.token, TOKEN)
        self.args = SimpleNamespace(endpoint="https://dashboard.example/api/ingest",
                                    token_file=self.token, user_id="fixture", migrate_legacy=True)
        self.loaded = True
        self.disabled = False
        self.disabled_text = None
        self.new_running = False
        self.validated = False
        self.download_hook = None
        self.start_error = False
        self.bind_errno = None
        self.extra_port = None
        self.time_wait = False
        self.reuse_address = False
        self.linger_after_new_stop = 0
        self.replacement_release_probes = 0
        self.runtime_path = str(self.legacy)
        self.runtime_arguments = self.arguments
        self.output = io.StringIO()
        contexts = [
            patch.object(self.module.sys, "platform", "darwin"),
            patch.object(self.module, "run", self.external),
            patch.object(self.module, "download_binary", self.download),
            patch.object(self.module.socket, "socket"),
            patch.object(self.module.urllib.request, "urlopen"),
            patch.object(http.client, "HTTPConnection"),
            patch("sys.stdout", self.output),
        ]
        for context in contexts:
            mock = context.start()
            self.addCleanup(context.stop)
            if context.attribute == "socket":
                mock.return_value.__enter__.return_value.bind.side_effect = self.bind
                mock.return_value.__enter__.return_value.setsockopt.side_effect = self.socket_option
                mock.return_value.__enter__.return_value.connect_ex.return_value = errno.ECONNREFUSED
            if context.attribute == "urlopen":
                mock.return_value.__enter__.return_value.status = 200
            if context.attribute == "HTTPConnection":
                self.health_connection = mock
                mock.return_value.getresponse.return_value.status = 200

    def download(self, stage, release):
        self.assertTrue(self.loaded or self.disabled, "old service must survive preparation")
        self.module.atomic(stage / "otelcol-contrib", "new binary", 0o700)
        if self.download_hook:
            self.download_hook()

    def bind(self, address):
        if self.bind_errno:
            raise OSError(self.bind_errno, "simulated bind error")
        if address[1] == 4317 and self.replacement_release_probes:
            self.replacement_release_probes -= 1
            raise OSError(errno.EADDRINUSE, "replacement listener still closing")
        if self.new_running and address[1] in (4317, 4318, 13133):
            raise OSError(errno.EADDRINUSE, "replacement listener")
        if (self.loaded and address[1] in (4317, 4318)) or address[1] == self.extra_port:
            raise OSError(errno.EADDRINUSE, "address in use")
        if self.time_wait and not self.reuse_address:
            raise OSError(errno.EADDRINUSE, "closed connection in TIME_WAIT")

    def socket_option(self, level, option, value):
        if (level, option, value) == (self.module.socket.SOL_SOCKET, self.module.socket.SO_REUSEADDR, 1):
            self.reuse_address = True

    def external(self, command, required=True, output=False):
        domain = "gui/" + str(os.getuid())
        target = domain + "/com.ccdash.otelcol"
        if command[0] == "lsof":
            port = next(int(x[6:]) for x in command if x.startswith("-iTCP:"))
            return "p999\n" if port == self.extra_port else ("p1321\n" if self.loaded else None)
        if command[0].endswith("otelcol-contrib"):
            self.validated = True
            return True
        if command == ["launchctl", "print", domain]:
            return True
        if command == ["launchctl", "print-disabled", domain]:
            return ('disabled services = {\n\t"com.ccdash.otelcol" => '
                    + (self.disabled_text or str(self.disabled).lower()) + '\n}')
        if command == ["launchctl", "print", target]:
            if not self.loaded:
                return None if output else False
            return (target + " = {\n\tpath = " + self.runtime_path +
                    "\n\tprogram = " + str(self.binary) + "\n\targuments = {\n\t\t" +
                    "\n\t\t".join(self.runtime_arguments) + "\n\t}\n\tpid = 1321\n}\n") if output else True
        if command == ["launchctl", "disable", target]:
            self.assertTrue(self.validated, "no legacy changes before validation")
            self.disabled = True
            return True
        if command == ["launchctl", "enable", target]:
            self.disabled = False
            return True
        if command == ["launchctl", "bootout", target]:
            self.loaded = False
            return True
        if command == ["launchctl", "bootstrap", domain, str(self.legacy)]:
            self.assertFalse(self.disabled)
            self.loaded = True
            return True
        if command == ["launchctl", "print", domain + "/org.ccdash.collector"]:
            return self.new_running
        if command == ["launchctl", "bootout", domain + "/org.ccdash.collector"]:
            self.new_running = False
            self.replacement_release_probes = self.linger_after_new_stop
            return True
        if command == ["launchctl", "bootstrap", domain, str(self.unit)]:
            self.assertFalse(self.loaded)
            self.new_running = True
            if self.start_error:
                raise ValueError("simulated startup failure")
            return True
        self.fail("unexpected OS command: " + repr(command))

    def install(self):
        self.module.install(self.args, self.home, "fixture", os.getuid(), self.root, self.unit)

    def conflicting_claude_settings(self):
        path = self.home / ".claude/settings.json"
        self.module.atomic(path, json.dumps({
            "model": "original",
            "permissions": {"allow": ["Read"]},
            "env": {
                "ANTHROPIC_AUTH_TOKEN": "fixture-login-token",
                "CLAUDE_CODE_USE_BEDROCK": "1",
                "OTEL_EXPORTER_OTLP_ENDPOINT": "https://previous.example",
                "OTEL_EXPORTER_OTLP_HEADERS": "authorization=fixture-old-header",
                "OTEL_EXPORTER_OTLP_LOGS_HEADERS": "authorization=fixture-old-log-header",
                "OTEL_EXPORTER_OTLP_CERTIFICATE": "/fixture/previous-ca.pem",
                "OTEL_METRIC_EXPORT_INTERVAL": "60000",
                "OTEL_RESOURCE_ATTRIBUTES": "user.email=fixture,team.name=example",
            },
        }) + "\n")
        return path, path.read_bytes()

    def test_confirmed_migration_replaces_claude_exporters_and_backs_up_original(self):
        path, original = self.conflicting_claude_settings()
        self.args.migrate_legacy = False
        with patch.object(self.module.sys.stdin, "isatty", return_value=True), \
                patch("builtins.input", return_value="y"):
            self.install()
        data = json.loads(path.read_text())
        self.assertEqual(data["model"], "original")
        self.assertEqual(data["permissions"], {"allow": ["Read"]})
        self.assertEqual(data["env"]["ANTHROPIC_AUTH_TOKEN"], "fixture-login-token")
        self.assertEqual(data["env"]["CLAUDE_CODE_USE_BEDROCK"], "1")
        self.assertEqual(data["env"]["OTEL_RESOURCE_ATTRIBUTES"], "user.email=fixture,team.name=example")
        self.assertEqual(data["env"]["OTEL_EXPORTER_OTLP_ENDPOINT"], "http://127.0.0.1:4317")
        self.assertEqual(data["env"]["OTEL_EXPORTER_OTLP_HEADERS"], "")
        for signal in ("LOGS", "METRICS", "TRACES"):
            self.assertEqual(data["env"][f"OTEL_EXPORTER_OTLP_{signal}_ENDPOINT"], "http://127.0.0.1:4317")
            self.assertEqual(data["env"][f"OTEL_EXPORTER_OTLP_{signal}_HEADERS"], "")
        self.assertNotIn("OTEL_EXPORTER_OTLP_CERTIFICATE", data["env"])
        self.assertEqual(data["env"]["OTEL_METRIC_EXPORT_INTERVAL"], "10000")
        backups = list(path.parent.glob(path.name + ".ccdash-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), original)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
        self.assertTrue(self.new_running)
        self.assertNotIn("fixture-old-header", self.output.getvalue())
        self.assertNotIn("fixture-login-token", self.output.getvalue())

    def test_failed_migration_restores_conflicting_claude_settings(self):
        path, original = self.conflicting_claude_settings()
        self.start_error = True
        with self.assertRaisesRegex(ValueError, "startup failure"):
            self.install()
        self.assertEqual(path.read_bytes(), original)
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)
        self.assertFalse(self.new_running)

    def test_declining_migration_preserves_conflicting_claude_settings(self):
        path, original = self.conflicting_claude_settings()
        self.args.migrate_legacy = False
        with patch.object(self.module.sys.stdin, "isatty", return_value=True), \
                patch("builtins.input", return_value="n"), self.assertRaisesRegex(ValueError, "cancelled"):
            self.install()
        self.assertEqual(path.read_bytes(), original)
        self.assertTrue(self.loaded)
        self.assertFalse(self.root.exists())
        self.assertEqual(list(path.parent.glob("*.ccdash-backup-*")), [])

    def test_claude_edit_during_migration_preparation_is_preserved(self):
        path, _ = self.conflicting_claude_settings()
        edited = '{"model":"concurrent-edit"}\n'
        self.download_hook = lambda: path.write_text(edited)
        with self.assertRaisesRegex(ValueError, "changed"):
            self.install()
        self.assertEqual(path.read_text(), edited)
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)
        self.assertFalse(self.new_running)

    def test_known_legacy_is_migrated_after_validation_and_privately_backed_up(self):
        self.install()
        self.assertTrue(self.new_running)
        self.assertFalse(self.loaded)
        self.assertTrue(self.disabled)
        for path, original in self.original.items():
            self.assertEqual(path.read_bytes(), original)
        backups = list(self.root.glob("legacy-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o700)
        self.assertEqual((backups[0] / self.legacy.name).read_bytes(), self.original[self.legacy])
        self.assertNotIn("PRIVATE_FIXTURE", self.output.getvalue())

    def test_failed_new_start_restores_legacy_and_client_files(self):
        self.start_error = True
        with self.assertRaisesRegex(ValueError, "startup failure"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)
        self.assertFalse(self.new_running)
        self.assertFalse(self.unit.exists())
        self.assertFalse((self.root / "token").exists())
        self.assertFalse((self.home / ".claude/settings.json").exists())
        self.assertFalse((self.home / ".codex/config.toml").exists())
        for path, original in self.original.items():
            self.assertEqual(path.read_bytes(), original)

    def test_declining_prompt_keeps_legacy_running_without_installing(self):
        self.args.migrate_legacy = False
        with patch.object(self.module.sys.stdin, "isatty", return_value=True), \
                patch("builtins.input", return_value="n"), self.assertRaisesRegex(ValueError, "cancelled"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)
        self.assertFalse(self.root.exists())

    def test_noninteractive_migration_requires_explicit_option(self):
        self.args.migrate_legacy = False
        with patch.object(self.module.sys.stdin, "isatty", return_value=False), \
                self.assertRaisesRegex(ValueError, "--migrate-legacy"):
            self.install()
        self.assertTrue(self.loaded)

    def test_unrelated_port_owner_blocks_before_stopping_legacy(self):
        self.extra_port = 13133
        with self.assertRaisesRegex(ValueError, "13133"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)

    def test_loaded_service_from_another_path_is_not_migrated(self):
        self.runtime_path = "/elsewhere/other.plist"
        with self.assertRaisesRegex(ValueError, "loaded|location"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)

    def test_configuration_edit_during_download_keeps_legacy_running(self):
        self.download_hook = lambda: self.config.write_text("concurrent edit")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)
        self.assertEqual(self.config.read_text(), "concurrent edit")

    def test_permission_error_is_not_reported_as_a_port_conflict(self):
        self.bind_errno = errno.EACCES
        with self.assertRaisesRegex(ValueError, "EACCES"):
            self.install()
        self.assertTrue(self.loaded)

    def test_legacy_symlink_is_not_followed(self):
        other = self.legacy.with_suffix(".saved")
        self.legacy.rename(other)
        self.legacy.symlink_to(other)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.install()
        self.assertTrue(self.loaded)

    def test_confirmed_interactive_migration_is_supported(self):
        self.args.migrate_legacy = False
        with patch.object(self.module.sys.stdin, "isatty", return_value=True), \
                patch("builtins.input", return_value="yes"):
            self.install()
        self.assertTrue(self.new_running)
        self.assertTrue(self.disabled)

    def test_download_failure_keeps_old_service_running(self):
        def fail():
            raise ValueError("simulated download failure")
        self.download_hook = fail
        with self.assertRaisesRegex(ValueError, "download failure"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)
        self.assertFalse(self.unit.exists())

    def test_failed_new_health_restores_old_service(self):
        self.health_connection.return_value.getresponse.side_effect = OSError("unhealthy")
        with patch.object(self.module.urllib.request, "urlopen", side_effect=OSError("unhealthy")), \
                patch.object(self.module.time, "sleep"), self.assertRaisesRegex(ValueError, "locally healthy"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertFalse(self.new_running)

    def test_originally_disabled_and_unloaded_service_stays_so_on_failure(self):
        self.loaded = False
        self.disabled = True
        self.start_error = True
        with self.assertRaisesRegex(ValueError, "startup failure"):
            self.install()
        self.assertFalse(self.loaded)
        self.assertTrue(self.disabled)

    def test_loaded_service_with_different_arguments_is_not_migrated(self):
        self.runtime_arguments = [str(self.binary), "--config=/etc/otelcol/config.yaml"]
        with self.assertRaisesRegex(ValueError, "arguments"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)

    def test_malformed_plist_reports_a_safe_actionable_error(self):
        self.legacy.write_bytes(b"<plist><dict>PRIVATE_FIXTURE</plist>")
        with self.assertRaisesRegex(ValueError, "invalid"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertNotIn("PRIVATE_FIXTURE", self.output.getvalue())

    def test_valid_non_dictionary_plist_is_rejected(self):
        self.legacy.write_bytes(plistlib.dumps(["PRIVATE_FIXTURE"]))
        with self.assertRaisesRegex(ValueError, "invalid"):
            self.install()
        self.assertTrue(self.loaded)

    def test_socket_is_still_owned_by_legacy_after_failed_stop(self):
        previous = self.external
        def external(command, required=True, output=False):
            if command[:2] == ["launchctl", "bootout"] and command[-1].endswith("/com.ccdash.otelcol"):
                raise ValueError("simulated bootout failure")
            return previous(command, required, output)
        with patch.object(self.module, "run", external), \
                self.assertRaisesRegex(ValueError, "bootout failure"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)
        self.assertFalse(self.unit.exists())

    def test_disabled_word_preserves_original_persistence_on_failure(self):
        self.disabled = True
        self.disabled_text = "disabled"
        self.start_error = True
        with self.assertRaisesRegex(ValueError, "startup failure"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertTrue(self.disabled)

    def test_unknown_enablement_text_blocks_without_stopping(self):
        self.disabled_text = "unknown-state"
        with self.assertRaisesRegex(ValueError, "enablement"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)

    def test_migration_without_user_id_keeps_claude_identity(self):
        self.args.user_id = None
        settings = self.home / ".claude/settings.json"
        self.module.atomic(settings, json.dumps({
            "model": "preserved-model",
            "env": {"OTEL_RESOURCE_ATTRIBUTES": "user.email=existing@example.test,team.name=example"},
        }))
        self.install()
        data = json.loads(settings.read_text())
        self.assertEqual(data["env"]["OTEL_RESOURCE_ATTRIBUTES"],
                         "user.email=existing@example.test,team.name=example")
        self.assertEqual(data["model"], "preserved-model")
        self.assertEqual(json.loads((self.root / "state.json").read_text())["userId"], "existing@example.test")

    def test_migration_without_user_id_reuses_shell_identity(self):
        self.args.user_id = None
        with patch.dict(os.environ, {"OTEL_RESOURCE_ATTRIBUTES": "user.email=from-shell@example.test"}):
            self.install()
        self.assertEqual(json.loads((self.root / "state.json").read_text())["userId"], "from-shell@example.test")

    def test_missing_attribution_requires_explicit_id_when_unattended(self):
        self.args.user_id = None
        with patch.dict(os.environ, {"OTEL_RESOURCE_ATTRIBUTES": ""}), \
                patch.object(self.module.sys.stdin, "isatty", return_value=False), \
                self.assertRaisesRegex(ValueError, "--user-id"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)

    def test_closed_connections_do_not_block_migration_or_rollback(self):
        previous = self.external
        def external(command, required=True, output=False):
            result = previous(command, required, output)
            if command[:2] == ["launchctl", "bootout"]:
                self.time_wait = True
            return result
        self.start_error = True
        with patch.object(self.module, "run", external), patch.object(self.module.time, "sleep"), \
                self.assertRaisesRegex(ValueError, "startup failure"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)

    def test_reusable_address_must_also_allow_listening(self):
        # Some systems permit a specific-address bind alongside a reusable
        # wildcard bind, but the second socket still cannot become a listener.
        self.extra_port = 4317
        sock = self.module.socket.socket.return_value.__enter__.return_value
        sock.bind.side_effect = None
        sock.listen.side_effect = OSError(errno.EADDRINUSE, "another listener")
        with self.assertRaisesRegex(ValueError, "4317"):
            self.install()
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)

    def test_rollback_waits_for_replacement_listener_release(self):
        self.start_error = True
        self.linger_after_new_stop = 2
        with patch.object(self.module.time, "sleep") as sleep, \
                self.assertRaisesRegex(ValueError, "startup failure"):
            self.install()
        self.assertEqual(sleep.call_count, 2)
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)
        self.assertFalse(self.new_running)
        self.assertFalse(self.unit.exists())

    def test_rollback_preserves_recovery_when_listener_does_not_release(self):
        self.start_error = True
        self.linger_after_new_stop = 60
        with patch.object(self.module.time, "sleep") as sleep, \
                self.assertRaisesRegex(ValueError, "rollback could not finish"):
            self.install()
        self.assertEqual(sleep.call_count, 50)
        self.assertFalse(self.loaded)
        self.assertTrue(self.disabled)
        self.assertTrue(list(self.root.glob(".prepare-*")))
        self.assertTrue(list(self.root.glob("legacy-backup-*")))

    def test_local_health_does_not_use_environment_proxy(self):
        with patch.dict(os.environ, {"http_proxy": "http://proxy.invalid:3128", "no_proxy": ""}), \
                patch.object(self.module.urllib.request, "urlopen", side_effect=OSError("proxy denied")), \
                patch.object(self.module.time, "sleep"):
            self.install()
        self.health_connection.assert_called_once_with("127.0.0.1", 13133, timeout=1)
        self.health_connection.return_value.request.assert_called_once_with("GET", "/")
        self.health_connection.return_value.close.assert_called_once()
        self.assertTrue(self.new_running)

    def test_connection_detects_listener_even_when_bind_and_listen_are_permitted(self):
        self.extra_port = 4317
        sock = self.module.socket.socket.return_value.__enter__.return_value
        sock.bind.side_effect = None
        sock.connect_ex.side_effect = lambda address: 0 if address[1] == 4317 else errno.ECONNREFUSED
        for platform in ("darwin", "linux"):
            with self.subTest(platform=platform), patch.object(self.module.sys, "platform", platform), \
                    self.assertRaisesRegex(ValueError, "4317"):
                self.module.check_ports()
        self.assertTrue(self.loaded)
        self.assertFalse(self.disabled)

    def test_connection_errors_are_not_mistaken_for_a_free_port(self):
        sock = self.module.socket.socket.return_value.__enter__.return_value
        sock.bind.side_effect = None
        sock.connect_ex.return_value = errno.EACCES
        with self.assertRaisesRegex(ValueError, "cannot check local port 4317: EACCES"):
            self.module.check_ports()

    def test_local_health_does_not_follow_redirects(self):
        self.health_connection.return_value.getresponse.return_value.status = 302
        with patch.object(self.module.time, "sleep"), \
                self.assertRaisesRegex(ValueError, "locally healthy"):
            self.install()
        self.assertEqual(self.health_connection.return_value.close.call_count, 30)
        self.assertTrue(self.loaded)
        self.assertFalse(self.new_running)

    def test_status_and_check_use_direct_health_with_proxy_environment(self):
        self.install()
        account = SimpleNamespace(pw_dir=str(self.home), pw_name="fixture",
                                  pw_uid=os.getuid(), pw_gid=os.getgid())
        for action in ("status", "check"):
            with self.subTest(action=action), \
                    patch.object(self.module.sys, "argv", ["install.py", action]), \
                    patch.object(self.module.os, "geteuid", return_value=1000), \
                    patch.object(self.module.pwd, "getpwuid", return_value=account), \
                    patch.dict(os.environ, {"CODEX_HOME": "", "CLAUDE_CONFIG_DIR": "",
                                            "http_proxy": "http://proxy.invalid:3128", "no_proxy": ""}), \
                    patch.object(self.module.urllib.request, "urlopen", side_effect=OSError("proxy denied")):
                self.assertEqual(self.module.main(), 0)
        self.health_connection.assert_called_with("127.0.0.1", 13133, timeout=3)
