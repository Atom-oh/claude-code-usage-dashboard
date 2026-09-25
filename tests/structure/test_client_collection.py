"""Exercise the launcher boundary without invoking a model or AWS."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = ROOT / "scripts/codex-launch.py"
TEST_TMPDIR = os.environ.get("TMPDIR") or "/var/tmp"


class ClientConfigurationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = None
        if LAUNCHER.exists():
            spec = importlib.util.spec_from_file_location("codex_launch", LAUNCHER)
            cls.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.module)

    def settings(self, **env):
        self.assertIsNotNone(self.module, "process-scoped Codex launcher is missing")
        return self.module.settings(env)

    def test_collector_check_ignores_launcher_file_and_provider_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            for codex in ("false", "true"):
                env = {"PATH": os.environ["PATH"], "CLAUDE_ENABLED": "true", "CODEX_ENABLED": codex,
                       "CCDASH_CLIENT_ENV": directory, "CODEX_BEDROCK_ENDPOINT": "invalid",
                       "CODEX_BEDROCK_REGION": "invalid", "CODEX_MODEL": "invalid", "CODEX_VERSION": "invalid"}
                result = subprocess.run(
                    [str(LAUNCHER), "--check-collector"], env=env, capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)["enabledClients"],
                                 ["claude", "codex"] if codex == "true" else ["claude"])
            for flags in [("false", "false"), ("bad", "true")]:
                result = subprocess.run(
                    [str(LAUNCHER), "--check-collector"],
                    env={**env, "CLAUDE_ENABLED": flags[0], "CODEX_ENABLED": flags[1]},
                    capture_output=True, text=True,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Is a directory", result.stderr)

    def test_defaults_preserve_claude_only(self):
        settings = self.settings()
        self.assertEqual(settings["enabledClients"], ["claude"])
        self.assertEqual(settings["endpoint"], "mantle")
        self.assertEqual(settings["region"], "us-west-2")
        self.assertEqual(settings["model"], "openai.gpt-6-astra")

    def test_supported_activation_combinations(self):
        for claude, codex, expected in [
            ("true", "false", ["claude"]),
            ("false", "true", ["codex"]),
            ("true", "true", ["claude", "codex"]),
            ("FALSE", "1", ["codex"]),
            ("", "", ["claude"]),
        ]:
            with self.subTest(claude=claude, codex=codex):
                self.assertEqual(self.settings(CLAUDE_ENABLED=claude, CODEX_ENABLED=codex)["enabledClients"], expected)

    def test_invalid_flags_endpoint_model_and_region_fail(self):
        self.settings()
        for env in [
            {"CLAUDE_ENABLED": "false", "CODEX_ENABLED": "false"},
            {"CLAUDE_ENABLED": "yes"},
            {"CODEX_BEDROCK_ENDPOINT": "other"},
            {"CODEX_BEDROCK_REGION": "us-west-2/evil"},
            {"CODEX_BEDROCK_REGION": "ap-northeast-2"},
            {"CODEX_MODEL": "us.openai.gpt-6-astra"},
            {"CODEX_BEDROCK_ENDPOINT": "runtime", "CODEX_MODEL": "openai.gpt-6-astra"},
            {"CODEX_BEDROCK_ENDPOINT": "runtime", "CODEX_MODEL": "us.openai.gpt-6-astra", "CODEX_BEDROCK_REGION": "eu-west-1"},
            {"CODEX_VERSION": "latest"},
        ]:
            with self.subTest(env=env), self.assertRaises(ValueError):
                self.module.settings(env)

    def test_runtime_defaults_and_global_override(self):
        self.assertEqual(self.settings(CODEX_BEDROCK_ENDPOINT="")["endpoint"], "mantle")
        config = self.settings(CODEX_BEDROCK_ENDPOINT="runtime")
        self.assertEqual(config["model"], "us.openai.gpt-6-astra")
        self.assertEqual(config["base_url"], "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1")
        config = self.settings(CODEX_BEDROCK_ENDPOINT="runtime", CODEX_MODEL="global.openai.gpt-6-astra", CODEX_BEDROCK_REGION="ap-northeast-2")
        self.assertEqual(config["region"], "ap-northeast-2")

    def test_resource_merge_keeps_metadata_and_does_not_modify_parent(self):
        self.settings()
        env = {
            "CODEX_ENABLED": "true",
            "OTEL_RESOURCE_ATTRIBUTES": "user.email=fixture@example.invalid,team=Test Team,project.name=a%2Cb,custom=a=b,9custom+tag=valid,backend=wrong,experiment.group=bedrock",
        }
        original = env.copy()
        command, child = self.module.launch_command(env, ["exec", "read sample.txt"])
        self.assertEqual(env, original)
        attrs = child["OTEL_RESOURCE_ATTRIBUTES"]
        for value in ["user.email=fixture@example.invalid", "team=Test Team", "project.name=a%2Cb", "custom=a=b", "9custom+tag=valid", "backend=bedrock-mantle"]:
            self.assertIn(value, attrs)
        self.assertNotIn("experiment.group", attrs)
        self.assertNotIn("backend=wrong", attrs)
        self.assertEqual(command[-2:], ["exec", "read sample.txt"])

    def test_bad_resource_attributes_fail_without_echoing_values(self):
        self.settings()
        for value in ["no-equals", "a=one,,b=two", "=value", "a=secret\ninjection"]:
            with self.subTest(value=value), self.assertRaises(ValueError) as error:
                self.module.launch_command({"CODEX_ENABLED": "true", "OTEL_RESOURCE_ATTRIBUTES": value}, [])
            self.assertNotIn(value, str(error.exception))

    def test_mantle_and_runtime_export_all_signals_without_embedded_credentials(self):
        self.settings()
        for endpoint, provider in [("mantle", "amazon-bedrock"), ("runtime", "ccdash-bedrock-runtime")]:
            with self.subTest(endpoint=endpoint):
                command, child = self.module.launch_command({
                    "CODEX_ENABLED": "true", "CODEX_BEDROCK_ENDPOINT": endpoint,
                    "AWS_BEARER_TOKEN_BEDROCK": "fixture-secret-do-not-print",
                }, ["--version"])
                overrides = [command[i + 1] for i, value in enumerate(command[:-1]) if value == "-c"]
                self.assertIn('model_provider="' + provider + '"', overrides)
                self.assertIn('otel.log_user_prompt=false', overrides)
                for key, signal in [("exporter", "logs"), ("metrics_exporter", "metrics"), ("trace_exporter", "traces")]:
                    setting = next(value for value in overrides if value.startswith("otel." + key + "="))
                    self.assertIn("127.0.0.1:4318/v1/" + signal, setting)
                    self.assertIn('protocol="json"', setting)
                    self.assertIn('"x-ccdash-backend"="bedrock-' + endpoint + '"', setting)
                self.assertNotIn("fixture-secret-do-not-print", " ".join(command))
                self.assertEqual(child["AWS_BEARER_TOKEN_BEDROCK"], "fixture-secret-do-not-print")
                self.assertIn("backend=bedrock-" + endpoint, child["OTEL_RESOURCE_ATTRIBUTES"])
                if endpoint == "runtime":
                    self.assertTrue(any('env_key="AWS_BEARER_TOKEN_BEDROCK"' in value for value in overrides))
                else:
                    self.assertTrue(any('aws.region="us-west-2"' in value for value in overrides))
                    self.assertFalse(any("model_providers.amazon-bedrock.base_url=" in value for value in overrides))

    def test_disabled_codex_and_missing_runtime_token_do_not_launch(self):
        self.settings()
        for env in [{}, {"CODEX_ENABLED": "true", "CODEX_BEDROCK_ENDPOINT": "runtime"}]:
            with self.subTest(env=env), self.assertRaises(ValueError):
                self.module.launch_command(env, [])

    def test_runtime_disables_global_web_search_without_disabling_mantle(self):
        self.settings()
        command, _ = self.module.launch_command({
            "CODEX_ENABLED": "true", "CODEX_BEDROCK_ENDPOINT": "runtime",
            "AWS_BEARER_TOKEN_BEDROCK": "local-fixture-only",
        }, ["exec", "Reply OK."])
        self.assertIn('web_search="disabled"', command)
        command, _ = self.module.launch_command({"CODEX_ENABLED": "true"}, ["--search"])
        self.assertNotIn('web_search="disabled"', command)

    def test_runtime_cannot_reenable_unsupported_hosted_search(self):
        self.settings()
        env = {
            "CODEX_ENABLED": "true", "CODEX_BEDROCK_ENDPOINT": "runtime",
            "AWS_BEARER_TOKEN_BEDROCK": "local-fixture-only",
        }
        for arguments in [
            ["--search"], ["--search=true"],
            ["-c", 'web_search="live"'], ["-c", 'web_search="cached"'],
            ["--config=web_search=live"], ["-cweb_search=live"],
        ]:
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                self.module.launch_command(env, arguments)
        # After --, this is literal prompt text, not a search option.
        self.module.launch_command(env, ["--", "--search"])

    def test_otel_and_provider_overrides_cannot_silently_disable_collection(self):
        self.settings()
        for args in [
            ["-c", 'otel.exporter="none"'],
            ["--config=otel.log_user_prompt=true"],
            ["--model", "untracked-model"],
            ["-m", "untracked-model"],
            ["--profile", "untracked-profile"],
            ["-cmodel_provider=other"],
            ["--config", "'otel'.log_user_prompt=true"],
            ["--config", "otel . log_user_prompt=true"],
        ]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.module.launch_command({"CODEX_ENABLED": "true"}, args)
        self.module.launch_command({"CODEX_ENABLED": "true"}, ["exec", "-s", "read-only", "-c", "approval_policy=\"never\""])

    def test_env_file_is_data_not_executable_shell(self):
        self.settings()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clients.env"
            path.write_text("CLAUDE_ENABLED=false\nCODEX_ENABLED=true\nCODEX_BEDROCK_ENDPOINT=runtime\n")
            loaded = self.module.load_environment({"CCDASH_CLIENT_ENV": str(path), "CODEX_BEDROCK_ENDPOINT": "mantle"})
            self.assertEqual(loaded["CLAUDE_ENABLED"], "false")
            self.assertEqual(loaded["CODEX_BEDROCK_ENDPOINT"], "mantle")
            path.write_text("AWS_BEARER_TOKEN_BEDROCK=must-not-be-stored\n")
            with self.assertRaises(ValueError):
                self.module.load_environment({"CCDASH_CLIENT_ENV": str(path)})

    def test_cli_check_is_offline_and_reports_nonsecret_configuration(self):
        self.assertTrue(LAUNCHER.exists(), "process-scoped Codex launcher is missing")
        env = {"PATH": os.environ["PATH"], "TMPDIR": TEST_TMPDIR, "CODEX_ENABLED": "true",
               "CODEX_BEDROCK_ENDPOINT": "runtime", "CCDASH_CLIENT_ENV": "/nonexistent"}
        result = subprocess.run(["python3", "-B", str(LAUNCHER), "--check"], env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["enabledClients"], ["claude", "codex"])


class BootstrapTests(unittest.TestCase):
    def test_bad_flags_fail_before_package_installation_or_cloud_access(self):
        # Execute the actual preflight section, before the first package operation.
        source = (ROOT / "user-data.sh").read_text().split("# ---- 1.")[0]
        for flags in [
            {"CLAUDE_ENABLED": "false", "CODEX_ENABLED": "false"},
            {"CLAUDE_ENABLED": "yes"},
            {"CODEX_BEDROCK_ENDPOINT": "other"},
        ]:
            env = {"PATH": os.environ["PATH"], "TMPDIR": TEST_TMPDIR,
                   "BOOTSTRAP_ASSET_DIR": str(ROOT), **flags}
            result = subprocess.run(["bash"], input=source, text=True, capture_output=True, env=env)
            self.assertNotEqual(result.returncode, 0, flags)
            self.assertIn("ERROR:", result.stderr)

    def test_bootstrap_writes_matching_flags_and_installs_only_enabled_clients(self):
        stub = '''#!/usr/bin/env python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
root = pathlib.Path(os.environ["FIXTURE_ROOT"])
args = sys.argv[1:]
with (root / "commands.jsonl").open("a") as stream:
    stream.write(json.dumps([name, *args]) + "\\n")
if name == "aws":
    assert args[:2] == ["ssm", "get-parameter"], args
    print("fixture-collector-secret")
elif name == "curl":
    if any("latest/api/token" in arg for arg in args):
        print("fixture-imds-token")
    elif any("tags/instance/Email" in arg for arg in args):
        print("fixture@example.invalid")
elif name == "tar":
    target = pathlib.Path(args[args.index("-C") + 1])
    assert target.is_relative_to(root), target
    (target / "otelcol-contrib").write_text(pathlib.Path(sys.argv[0]).resolve().read_text())
elif name == "otelcol-contrib":
    assert args[0] == "validate", args
    config = pathlib.Path(args[args.index("--config") + 1])
    if os.environ.get("FIXTURE_UPGRADE"):
        assert (root / "etc/otelcol/config.yaml").read_text() == "previous configuration"
        assert (root / "usr/local/bin/otelcol-contrib").read_text() == "previous collector binary"
        assert (root / "usr/local/bin/ccdash-codex").read_text() == "previous launcher"
    assert os.environ.get("CH_PASSWORD") == "fixture-collector-secret"
    sys.exit(23 if config.read_text().startswith("INVALID") else 0)
elif name == "npm":
    (root / ("installed-codex" if "@openai/codex@" in args[-1] else "installed-claude")).touch()
elif name == "claude":
    print("2.1.226" if (root / "installed-claude").exists() else "2.1.225")
elif name == "codex":
    print("codex-cli 0.154.0" if (root / "installed-codex").exists() else "codex-cli 0.153.0")
elif name == "systemctl":
    if args[0] == "stop" and not (root / "restarted").exists() and os.environ.get("FIXTURE_UPGRADE"):
        assert (root / "usr/local/bin/otelcol-contrib").read_text() == "previous collector binary"
        assert (root / "usr/local/bin/ccdash-codex").read_text() == "previous launcher"
    if args[0] == "restart":
        (root / "restarted").touch()
        if os.environ.get("FIXTURE_UPGRADE") == "restart-failed": sys.exit(17)
    elif args[0] == "is-active":
        if os.environ.get("FIXTURE_UPGRADE") == "startup-failed" and (root / "restarted").exists():
            sys.exit(3)
    elif args[0] == "start":
        assert (root / "etc/otelcol/config.yaml").read_text() == "previous configuration"
else:
    assert name in ("dnf", "sleep"), name
'''
        for raw_claude, raw_codex, claude, codex, upgrade in [
            ("true", "false", "true", "false", ""),
            ("false", "true", "false", "true", ""),
            ("true", "true", "true", "true", ""),
            ("FALSE", "1", "false", "true", ""),
            ("", "", "true", "false", ""),
            ("true", "true", "true", "true", "valid"),
            ("true", "true", "true", "true", "invalid"),
            ("true", "true", "true", "true", "missing"),
            ("true", "true", "true", "true", "restart-failed"),
            ("true", "true", "true", "true", "startup-failed"),
        ]:
            with self.subTest(claude=claude, codex=codex, upgrade=upgrade), tempfile.TemporaryDirectory(prefix="bootstrap-clients-") as directory:
                root = Path(directory)
                binaries = root / "bin"
                binaries.mkdir()
                executable = binaries / "fixture"
                executable.write_text(stub)
                executable.chmod(0o755)
                for name in ["aws", "curl", "tar", "npm", "claude", "codex", "dnf", "systemctl", "sleep"]:
                    (binaries / name).symlink_to(executable)
                source = (ROOT / "user-data.sh").read_text()
                # Rewrite only machine filesystem roots; real shell/config writes
                # run inside the fixture. Network/package/service boundaries are stubbed.
                for path in ["/etc/", "/usr/local/bin/", "/opt/otelcol", "/var/lib/otelcol"]:
                    source = source.replace(path, str(root) + path)
                for path in ["etc/systemd/system", "usr/local/bin"]:
                    (root / path).mkdir(parents=True)
                assets = root / "assets"
                (assets / "scripts").mkdir(parents=True)
                shutil.copyfile(LAUNCHER, assets / "scripts/codex-launch.py")
                if upgrade != "missing":
                    (assets / "collector-config.yaml").write_text("INVALID config" if upgrade == "invalid" else (ROOT / "collector-config.yaml").read_text())
                previous = {}
                if upgrade:
                    for name, content in [("etc/otelcol/config.yaml", "previous configuration"),
                                          ("etc/otelcol/env", "previous collector env"),
                                          ("etc/ccdash/clients.env", "previous client defaults"),
                                          ("etc/systemd/system/otelcol.service", "previous unit"),
                                          ("usr/local/bin/otelcol-contrib", "previous collector binary"),
                                          ("usr/local/bin/ccdash-codex", "previous launcher")]:
                        path = root / name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text(content)
                        previous[path] = content
                env = {
                    "PATH": str(binaries) + ":" + os.environ["PATH"], "TMPDIR": str(root),
                    "FIXTURE_ROOT": str(root), "BOOTSTRAP_ASSET_DIR": str(assets), "FIXTURE_UPGRADE": upgrade,
                    "CLAUDE_ENABLED": raw_claude, "CODEX_ENABLED": raw_codex,
                    "CODEX_BEDROCK_ENDPOINT": "runtime",
                }
                explicit_identity = raw_claude == raw_codex == "true" and not upgrade
                if explicit_identity:
                    env["CODEX_OTEL_RESOURCE_ATTRIBUTES"] = "team=fsi, user.email=chosen@example.invalid"
                result = subprocess.run(["bash"], input=source, text=True, capture_output=True, env=env, timeout=20)
                self.assertNotIn("fixture-collector-secret", result.stdout + result.stderr)
                commands_file = root / "commands.jsonl"
                commands = [json.loads(line) for line in commands_file.read_text().splitlines()] if commands_file.exists() else []
                if upgrade in ("invalid", "missing", "restart-failed", "startup-failed"):
                    self.assertNotEqual(result.returncode, 0, result.stderr)
                    for path, expected in previous.items():
                        self.assertEqual(path.read_text(), expected, str(path))
                    if upgrade in ("restart-failed", "startup-failed"):
                        self.assertIn(["systemctl", "start", "otelcol.service"], commands)
                    else:
                        self.assertFalse(any(entry[0] == "systemctl" and entry[1] not in ("is-active", "is-enabled") for entry in commands))
                    continue
                self.assertEqual(result.returncode, 0, result.stderr)
                validated = next((i for i, entry in enumerate(commands) if entry[:2] == ["otelcol-contrib", "validate"]), None)
                self.assertIsNotNone(validated, "candidate must be validated before promotion/restart")
                self.assertLess(validated, commands.index(["systemctl", "restart", "otelcol.service"]))
                collector_file = root / "etc/otelcol/env"
                collector = dict(line.split("=", 1) for line in collector_file.read_text().splitlines())
                launcher_file = root / "etc/ccdash/clients.env"
                launcher = dict(line.split("=", 1) for line in launcher_file.read_text().splitlines())
                for key, expected in [("CLAUDE_ENABLED", claude), ("CODEX_ENABLED", codex), ("CODEX_BEDROCK_ENDPOINT", "runtime")]:
                    self.assertEqual(collector[key], expected)
                    self.assertEqual(launcher[key], expected)
                self.assertEqual(launcher["CODEX_MODEL"], "us.openai.gpt-6-astra")
                self.assertNotIn("fixture-collector-secret", launcher_file.read_text())
                # The Collector default matches the identity the launcher sends.
                self.assertEqual(collector["CODEX_DEFAULT_USER_EMAIL"],
                                 "chosen@example.invalid" if explicit_identity else "fixture@example.invalid")
                if explicit_identity:
                    self.assertIn("chosen@example.invalid", launcher_file.read_text())
                    self.assertNotIn("fixture@example.invalid", launcher_file.read_text())
                self.assertEqual(collector_file.stat().st_mode & 0o777, 0o600)
                commands = [json.loads(line) for line in (root / "commands.jsonl").read_text().splitlines()]
                packages = [entry[-1] for entry in commands if entry[0] == "npm"]
                self.assertEqual("@anthropic-ai/claude-code@2.1.226" in packages, claude == "true")
                self.assertEqual("@openai/codex@0.154.0" in packages, codex == "true")
                self.assertIn(["systemctl", "restart", "otelcol.service"], commands)
                managed = root / "etc/claude-code/managed-settings.json"
                self.assertEqual(managed.exists(), claude == "true")
                if managed.exists():
                    settings = json.loads(managed.read_text())["env"]
                    self.assertEqual(settings["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"], "cumulative")
                    self.assertNotIn("backend=", settings["OTEL_RESOURCE_ATTRIBUTES"])
                # Exercise the installed launcher against the generated nonsecret file.
                checked = subprocess.run(
                    [str(root / "usr/local/bin/ccdash-codex"), "--check"],
                    env={"PATH": os.environ["PATH"], "TMPDIR": TEST_TMPDIR, "CCDASH_CLIENT_ENV": str(launcher_file)},
                    text=True, capture_output=True,
                )
                self.assertEqual(checked.returncode, 0, checked.stderr)
                unit = (root / "etc/systemd/system/otelcol.service").read_text()
                self.assertIn("ccdash-codex --check-collector", unit)
                launcher_file.write_text("UNKNOWN=broken\nUNKNOWN=duplicate\n")
                collector_check = subprocess.run(
                    [str(root / "usr/local/bin/ccdash-codex"), "--check-collector"],
                    env={"PATH": os.environ["PATH"], "CLAUDE_ENABLED": claude, "CODEX_ENABLED": codex,
                         "CCDASH_CLIENT_ENV": str(launcher_file), "CODEX_MODEL": "invalid"},
                    text=True, capture_output=True,
                )
                self.assertEqual(collector_check.returncode, 0, collector_check.stderr)


@unittest.skipUnless(shutil.which("terraform"), "Terraform is not installed")
class TerraformClientTests(unittest.TestCase):
    def test_actual_variables_validate_offline(self):
        source = (ROOT / "infra/dashboard.tf").read_text()
        start = source.index('variable "claude_enabled"')
        end = source.index('variable "data_stale_minutes"')
        with tempfile.TemporaryDirectory(prefix="client-variables-") as directory:
            (Path(directory) / "main.tf").write_text(source[start:end] + '''
output "clients" {
  value = [var.claude_enabled, var.codex_enabled, var.codex_bedrock_endpoint]
}
''')
            env = {"PATH": os.environ["PATH"], "TMPDIR": TEST_TMPDIR, "TF_IN_AUTOMATION": "1"}
            for variables, valid in [
                ({}, True),
                ({"claude_enabled": "false", "codex_enabled": "true"}, True),
                ({"claude_enabled": "true", "codex_enabled": "true", "codex_bedrock_endpoint": "runtime"}, True),
                ({"claude_enabled": "false", "codex_enabled": "false"}, False),
                ({"codex_bedrock_endpoint": "other"}, False),
            ]:
                arguments = [value for key, val in variables.items() for value in ["-var", key + "=" + val]]
                result = subprocess.run(["terraform", "plan", "-input=false", "-no-color", *arguments],
                                        cwd=directory, env=env, text=True, capture_output=True, timeout=20)
                self.assertEqual(result.returncode == 0, valid, result.stdout + result.stderr)
                if not valid:
                    self.assertIn("Invalid value for variable", result.stderr)


if __name__ == "__main__":
    unittest.main()
