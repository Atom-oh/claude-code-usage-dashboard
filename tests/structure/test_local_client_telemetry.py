"""Local setup preserves routing while enabling Claude and Codex exporters."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("configure_telemetry", ROOT / "scripts/configure-client-telemetry.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class ClientSettingsTests(unittest.TestCase):
    def test_codex_preserves_provider_permissions_and_is_idempotent(self):
        original = '''model = "gateway-model"
model_provider = "inferplane"
sandbox_mode = "read-only"
[model_providers.inferplane]
base_url = "http://127.0.0.1:8081/v1"
env_key = "INFERPLANE_API_KEY"
[tui]
theme = "dark"
'''
        rendered = setup.codex_config(original, True)
        parsed = setup.toml_load(rendered)
        self.assertEqual({k: v for k, v in parsed.items() if k != "otel"}, setup.toml_load(original))
        self.assertEqual(setup.codex_config(rendered, True), rendered)
        self.assertEqual(setup.toml_load(setup.codex_config(rendered, False)), setup.toml_load(original))
        self.assertFalse(parsed["otel"]["log_user_prompt"])
        for key, signal in [("exporter", "logs"), ("metrics_exporter", "metrics"), ("trace_exporter", "traces")]:
            self.assertEqual(parsed["otel"][key], {"otlp-http": {"endpoint": "http://127.0.0.1:4318/v1/" + signal, "protocol": "json"}})

    def test_manual_disabled_or_partial_otel_is_not_silently_skipped(self):
        for original in ['[otel]\nexporter="none"\n', 'otel.exporter="none"\n', '["otel"]\nexporter="none"\n',
                         '[otel.exporter.otlp-http]\nendpoint="http://localhost:9999/v1/logs"\n']:
            with self.subTest(original=original), self.assertRaisesRegex(ValueError, "unmanaged"):
                setup.codex_config(original, True)
        self.assertEqual(setup.codex_config(setup.CODEX_OTEL, True), setup.CODEX_OTEL)
        self.assertEqual(setup.codex_config("unused invalid config=[", False), "unused invalid config=[")

    def test_malformed_markers_and_toml_fail_before_any_client_write(self):
        for original in [setup.BEGIN + '\nmodel="m"\n', 'model=[', setup.END + '\n' + setup.BEGIN + '\n']:
            with tempfile.TemporaryDirectory() as directory:
                codex, claude = Path(directory) / "config.toml", Path(directory) / "settings.json"
                codex.write_text(original)
                with self.assertRaises(ValueError):
                    setup.plan(codex, claude, True, True, "fixture@example.invalid")
                self.assertEqual(codex.read_text(), original)
                self.assertFalse(claude.exists())

    def test_claude_preserves_routing_and_other_settings(self):
        original = {"model": "opusplan", "permissions": {"defaultMode": "plan"},
                    "env": {"ANTHROPIC_BEDROCK_BASE_URL": "http://127.0.0.1:8081", "CUSTOM_ENV": "keep",
                            "OTEL_RESOURCE_ATTRIBUTES": "project.name=demo,team=existing,user.email=old@example.invalid"}}
        after = json.loads(setup.claude_config(json.dumps(original), True, "fixture@example.invalid"))
        self.assertEqual(after["model"], original["model"])
        self.assertEqual(after["permissions"], original["permissions"])
        self.assertEqual(after["env"]["CUSTOM_ENV"], "keep")
        self.assertEqual(after["env"]["ANTHROPIC_BEDROCK_BASE_URL"], "http://127.0.0.1:8081")
        self.assertEqual(after["env"]["CLAUDE_CODE_ENABLE_TELEMETRY"], "1")
        self.assertEqual(after["env"]["OTEL_RESOURCE_ATTRIBUTES"], "project.name=demo,team=existing,user.email=fixture@example.invalid")
        disabled = json.loads(setup.claude_config(json.dumps(after), False, "fixture@example.invalid"))
        self.assertEqual(disabled["env"]["CLAUDE_CODE_ENABLE_TELEMETRY"], "0")
        self.assertEqual(disabled["env"]["OTEL_LOGS_EXPORTER"], "none")

    def test_new_claude_settings_do_not_shadow_dynamic_shell_resource_attributes(self):
        original = {"env": {"CUSTOM_ENV": "keep"}}
        after = json.loads(setup.claude_config(json.dumps(original), True, "fixture@example.invalid"))
        self.assertNotIn("OTEL_RESOURCE_ATTRIBUTES", after["env"])
        self.assertEqual(after["env"]["CUSTOM_ENV"], "keep")
        self.assertEqual(after["env"]["CLAUDE_CODE_ENABLE_TELEMETRY"], "1")

    def test_settings_owned_attributes_do_not_invent_a_team(self):
        after = json.loads(setup.claude_config(
            '{"env":{"OTEL_RESOURCE_ATTRIBUTES":"project.name=demo"}}',
            True, "fixture@example.invalid"))
        self.assertEqual(after["env"]["OTEL_RESOURCE_ATTRIBUTES"],
                         "project.name=demo,user.email=fixture@example.invalid")

    def test_conflicting_claude_exporters_fail_before_either_client_is_changed(self):
        conflicts = {"OTEL_EXPORTER_OTLP_ENDPOINT": "https://fixture.invalid",
                     "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
                     "OTEL_METRIC_EXPORT_INTERVAL": "99999",
                     "OTEL_LOGS_EXPORTER": "console",
                     "OTEL_EXPORTER_OTLP_HEADERS": "x-fixture=do-not-print"}
        for signal in ("METRICS", "LOGS", "TRACES"):
            conflicts["OTEL_EXPORTER_OTLP_" + signal + "_ENDPOINT"] = "https://fixture.invalid"
            conflicts["OTEL_EXPORTER_OTLP_" + signal + "_PROTOCOL"] = "http/json"
            conflicts["OTEL_EXPORTER_OTLP_" + signal + "_HEADERS"] = "x-fixture=do-not-print"
            conflicts["OTEL_EXPORTER_OTLP_" + signal + "_CLIENT_KEY"] = "/fixture/key.pem"
        for key, value in conflicts.items():
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                codex, claude = Path(directory) / "config.toml", Path(directory) / "settings.json"
                codex.write_text('model_provider="inferplane"\n', encoding="utf-8")
                original = json.dumps({"env": {key: value}})
                claude.write_text(original, encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "unmanaged Claude telemetry"):
                    setup.plan(codex, claude, True, True, "fixture@example.invalid")
                self.assertEqual(codex.read_text(), 'model_provider="inferplane"\n')
                self.assertEqual(claude.read_text(), original)

    def test_explicit_claude_replacement_pins_signals_and_clears_exporter_credentials(self):
        original = {"model": "opusplan", "permissions": {"defaultMode": "plan"}, "env": {
            "ANTHROPIC_BEDROCK_BASE_URL": "https://routing.fixture.invalid", "CUSTOM_ENV": "keep",
            "OTEL_EXPORTER_OTLP_ENDPOINT": "https://collector.fixture.invalid",
            "OTEL_EXPORTER_OTLP_HEADERS": "x-fixture=do-not-print",
            "OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY": "/fixture/key.pem",
            "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL": "http/protobuf",
        }}
        after = json.loads(setup.claude_config(json.dumps(original), True, "fixture@example.invalid", True))
        self.assertEqual(after["model"], original["model"])
        self.assertEqual(after["permissions"], original["permissions"])
        self.assertEqual(after["env"]["ANTHROPIC_BEDROCK_BASE_URL"], original["env"]["ANTHROPIC_BEDROCK_BASE_URL"])
        self.assertEqual(after["env"]["CUSTOM_ENV"], "keep")
        self.assertNotIn("OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY", after["env"])
        self.assertNotIn("OTEL_RESOURCE_ATTRIBUTES", after["env"])
        for signal in ("METRICS", "LOGS", "TRACES"):
            self.assertEqual(after["env"]["OTEL_EXPORTER_OTLP_" + signal + "_ENDPOINT"], "http://127.0.0.1:4317")
            self.assertEqual(after["env"]["OTEL_EXPORTER_OTLP_" + signal + "_PROTOCOL"], "grpc")
            self.assertEqual(after["env"]["OTEL_EXPORTER_OTLP_" + signal + "_HEADERS"], "")
        self.assertEqual(after["env"]["OTEL_EXPORTER_OTLP_HEADERS"], "")
        self.assertEqual(json.loads(setup.claude_config(json.dumps(after), True, "fixture@example.invalid")), after)
        disabled = setup.claude_config(json.dumps(after), False, "fixture@example.invalid")
        self.assertEqual(json.loads(setup.claude_config(disabled, True, "fixture@example.invalid", True)), after)

    def test_changed_plan_and_replaced_symlinks_do_not_overwrite_client_edits(self):
        with tempfile.TemporaryDirectory() as directory:
            codex, claude = Path(directory) / "config.toml", Path(directory) / "settings.json"
            codex.write_text('model="fixture"\n')
            claude.write_text('{}')
            changes = setup.plan(codex, claude, True, True, "fixture@example.invalid")
            claude.write_text('{"model":"new-choice"}')
            with self.assertRaisesRegex(ValueError, "changed after validation"):
                setup.apply(changes)
            self.assertEqual(codex.read_text(), 'model="fixture"\n')
            self.assertEqual(claude.read_text(), '{"model":"new-choice"}')
            changes = setup.plan(codex, claude, True, True, "fixture@example.invalid")
            target = Path(directory) / "other.json"
            target.write_text(claude.read_text())
            claude.unlink()
            claude.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "changed after validation"):
                setup.apply(changes)
            self.assertTrue(claude.is_symlink())
            self.assertEqual(codex.read_text(), 'model="fixture"\n')

    def test_identical_client_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config"
            with self.assertRaisesRegex(ValueError, "paths must differ"):
                setup.plan(path, path, True, True, "fixture@example.invalid")

    def test_atomic_private_backups_and_no_rewrite_on_repeat(self):
        with tempfile.TemporaryDirectory() as directory:
            codex, claude = Path(directory) / "config.toml", Path(directory) / "settings.json"
            codex.write_text('model_provider="inferplane"\n')
            claude.write_text('{"model":"opusplan"}\n')
            changes = setup.plan(codex, claude, True, True, "fixture@example.invalid")
            setup.apply(changes)
            self.assertEqual(setup.plan(codex, claude, True, True, "fixture@example.invalid"), [])
            backups = list(Path(directory).glob("*.ccdash-backup-*"))
            self.assertEqual(len(backups), 2)
            for path in [codex, claude, *backups]:
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_invalid_claude_settings_do_not_partially_enable_codex(self):
        with tempfile.TemporaryDirectory() as directory:
            codex, claude = Path(directory) / "config.toml", Path(directory) / "settings.json"
            codex.write_text('model_provider="inferplane"\n')
            for text in ['{"env":[]}', '[1]', '{broken']:
                claude.write_text(text)
                with self.assertRaises(ValueError):
                    setup.plan(codex, claude, True, True, "fixture@example.invalid")
                self.assertEqual(codex.read_text(), 'model_provider="inferplane"\n')
                self.assertEqual(claude.read_text(), text)

    def test_check_mode_does_not_write(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            result = subprocess.run(["python3", str(ROOT / "scripts/configure-client-telemetry.py"),
                "--check", "--user-id", "fixture@example.invalid", "--codex-config", str(temp / "config.toml"),
                "--claude-config", str(temp / "settings.json")], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)["valid"])
            self.assertEqual(list(temp.iterdir()), [])

    def test_check_mode_previews_changed_keys_without_exporter_values(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            original = '{"env":{"OTEL_EXPORTER_OTLP_HEADERS":"x-fixture=private-value","OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY":"/fixture/private-key.pem"}}'
            claude = temp / "settings.json"
            claude.write_text(original)
            result = subprocess.run(["python3", str(ROOT / "scripts/configure-client-telemetry.py"),
                "--check", "--replace-claude-telemetry", "--user-id", "fixture@example.invalid",
                "--codex-config", str(temp / "config.toml"), "--claude-config", str(claude)],
                capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            keys = json.loads(result.stdout)["claude_env_keys_to_update"]
            self.assertIn("OTEL_EXPORTER_OTLP_HEADERS", keys)
            self.assertIn("OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY", keys)
            self.assertNotIn("private-value", result.stdout + result.stderr)
            self.assertNotIn("/fixture/private-key.pem", result.stdout + result.stderr)
            self.assertEqual(claude.read_text(), original)
            self.assertFalse((temp / "config.toml").exists())

    def test_non_utf8_configuration_fails_without_echoing_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            codex = temp / "config.toml"
            codex.write_bytes(b"\xffprivate-fixture")
            result = subprocess.run(["python3", str(ROOT / "scripts/configure-client-telemetry.py"),
                "--check", "--user-id", "fixture@example.invalid", "--codex-config", str(codex),
                "--claude-config", str(temp / "settings.json")], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("must be UTF-8", result.stderr)
            self.assertNotIn("private-fixture", result.stderr)
            self.assertFalse((temp / "settings.json").exists())


@unittest.skipUnless((ROOT / "scripts/setup-test-telemetry-all.sh").exists(), "private self-service installer is not distributed in git")
class SelfServiceTests(unittest.TestCase):
    def test_full_install_keeps_collector_setup_and_configures_both_clients(self):
        with tempfile.TemporaryDirectory(prefix="full-self-service-") as directory:
            temp = Path(directory)
            binary = temp / "bin"
            binary.mkdir()
            for name, body in {
                "otelcol-contrib": 'echo "$*" >> "$CASE_DIR/collector-calls"\nexit 0',
                "sudo": 'echo "$*" >> "$CASE_DIR/sudo-calls"\nif [ "$1" = tee ]; then cat >/dev/null; fi\nexit 0',
                "systemctl": 'echo active\nexit 0',
                "curl": 'echo fixture-pong\nexit 0',
                "sleep": 'exit 0',
                "lsof": 'exit 0',
            }.items():
                path = binary / name
                path.write_text("#!/bin/sh\n" + body + "\n")
                path.chmod(0o700)
            env = {**os.environ, "HOME": str(temp), "CODEX_HOME": str(temp / "codex"),
                   "CLAUDE_CONFIG_DIR": str(temp / "claude"), "SHELL": "/bin/bash", "CASE_DIR": str(temp),
                   "PATH": str(binary) + ":" + os.environ["PATH"], "CH_PASSWORD": "unused-fixture",
                   "CLAUDE_ENABLED": "true", "CODEX_ENABLED": "true"}
            result = subprocess.run(["bash", str(ROOT / "scripts/setup-test-telemetry-all.sh"), "fixture@example.invalid"],
                                    env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("validate --config=", (temp / "collector-calls").read_text())
            self.assertIn("systemctl restart otelcol.service", (temp / "sudo-calls").read_text())
            self.assertIn("CODEX_DEFAULT_USER_EMAIL=fixture@example.invalid", (temp / ".otelcol/env").read_text())
            self.assertEqual((temp / ".otelcol/env").stat().st_mode & 0o777, 0o600)
            self.assertIn("traces/codex:", (temp / ".otelcol/config.yaml").read_text())
            self.assertIn("otel", setup.toml_load((temp / "codex/config.toml").read_text()))
            self.assertEqual(json.loads((temp / "claude/settings.json").read_text())["env"]["CLAUDE_CODE_ENABLE_TELEMETRY"], "1")

    def test_clients_only_does_not_touch_collector_or_call_network_or_sudo(self):
        with tempfile.TemporaryDirectory(prefix="self-service-telemetry-") as directory:
            temp = Path(directory)
            binary = temp / "bin"
            binary.mkdir()
            for name in ("sudo", "curl", "launchctl", "otelcol-contrib"):
                path = binary / name
                path.write_text('#!/bin/sh\necho forbidden >> "$CASE_DIR/forbidden"\nexit 99\n')
                path.chmod(0o700)
            manager = binary / "systemctl"
            manager.write_text('#!/bin/sh\nexit 1\n')
            manager.chmod(0o700)
            env = {**os.environ, "HOME": str(temp), "CODEX_HOME": str(temp / "codex"),
                   "CLAUDE_CONFIG_DIR": str(temp / "claude"), "SHELL": "/bin/bash", "CASE_DIR": str(temp),
                   "PATH": str(binary) + ":" + os.environ["PATH"], "CH_PASSWORD": "unused-fixture",
                   "CLAUDE_ENABLED": "true", "CODEX_ENABLED": "true"}
            (temp / ".zshrc").write_text("# Existing zsh configuration\n")
            command = ["bash", str(ROOT / "scripts/setup-test-telemetry-all.sh"), "--clients-only", "fixture@example.invalid"]
            for _ in range(2):
                result = subprocess.run(command, env=env, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((temp / "forbidden").exists())
            self.assertFalse((temp / ".otelcol/env").exists())
            self.assertFalse((temp / ".otelcol/config.yaml").exists())
            self.assertIn("otel", setup.toml_load((temp / "codex/config.toml").read_text()))
            self.assertEqual(json.loads((temp / "claude/settings.json").read_text())["env"]["CLAUDE_CODE_ENABLE_TELEMETRY"], "1")
            for rc in (".bashrc", ".zshrc"):
                self.assertEqual((temp / rc).read_text().count('&& . "$HOME/.otelcol/enable-test-telemetry.sh"'), 1)
            # The three wrappers retain telemetry, routing remains their own,
            # and a caller's positional arguments do not become user identity.
            result = subprocess.run(["bash", "--noprofile", "--norc", "-c", '''
set -- unrelated-command-argument
export OTEL_RESOURCE_ATTRIBUTES='project.name=fixture,team=existing'
source "$HOME/.otelcol/enable-test-telemetry.sh"
_trust_reset() { unset ANTHROPIC_BASE_URL CLAUDE_CODE_USE_BEDROCK; }
itrust() { _trust_reset; export CLAUDE_CODE_USE_BEDROCK=1; printf '%s|%s\n' "$CLAUDE_CODE_ENABLE_TELEMETRY" "$OTEL_RESOURCE_ATTRIBUTES"; }
etrust() { _trust_reset; printf '%s|%s\n' "$CLAUDE_CODE_ENABLE_TELEMETRY" "$OTEL_RESOURCE_ATTRIBUTES"; }
icodex() { printf '%s\n' "$OTEL_RESOURCE_ATTRIBUTES"; }
itrust; etrust; icodex
'''], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("unrelated-command-argument", result.stdout)
            self.assertEqual(result.stdout.count("user.email=fixture@example.invalid"), 3)
            self.assertEqual(result.stdout.count("team=existing"), 3)
            self.assertNotIn("backend=", result.stdout)


if __name__ == "__main__":
    unittest.main()
