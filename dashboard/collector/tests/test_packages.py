import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "ccd1." + "a" * 64 + "." + "b" * 32 + "." + "C" * 43


class Packages(unittest.TestCase):
    def test_installer_exists(self):
        self.assertTrue((ROOT / "install.py").is_file(), "installer is missing")

    def test_archives_are_reproducible_and_contain_only_public_runtime_inputs(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            for output in (first, second):
                subprocess.run(["node", str(ROOT / "build-packages.mjs"), output], check=True)
            for platform in ("linux", "darwin"):
                name = "ccdash-collector-" + platform + ".tar.gz"
                archive = Path(first, name).read_bytes()
                self.assertEqual(archive, Path(second, name).read_bytes())
                manifest = json.loads(Path(first, "manifest.json").read_text())
                self.assertEqual(manifest["packages"][name], hashlib.sha256(archive).hexdigest())
                with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
                    names = bundle.getnames()
                    self.assertIn("ccdash-collector/install.py", names)
                    self.assertIn("ccdash-collector/generated/local.yaml", names)
                    self.assertNotIn("ccdash-collector/generated/central.yaml", names)
                    self.assertFalse(any("otelcol-contrib" in n or "setup-test" in n for n in names))
                    for entry in bundle:
                        self.assertTrue(entry.isfile())
                        self.assertEqual(entry.uid, 0)
                        self.assertEqual(entry.mtime, 0)
                        self.assertNotIn(TOKEN.encode(), bundle.extractfile(entry).read())

    def test_generated_sources_have_no_drift(self):
        subprocess.run([sys.executable, str(ROOT.parents[1] / "scripts/sync-collector-package.py"),
                        "--check"], check=True)

    def test_central_clickhouse_uses_private_plain_native_port_without_changing_canonical_tls(self):
        central = (ROOT / "generated/central.yaml").read_text()
        self.assertIn("endpoint: tcp://${env:CH_HOST}:${env:CH_PORT}?secure=false", central)
        self.assertIn("endpoint: tcp://${env:CH_HOST}:${env:CH_PORT}?secure=true",
                      (ROOT.parents[1] / "collector-config.yaml").read_text())


@unittest.skipUnless((ROOT / "install.py").exists(), "implementation is not present yet")
class Installer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("collector_installer", ROOT / "install.py")
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_only_public_https_ingestion_urls_are_accepted(self):
        self.assertEqual(self.module.endpoint("https://dashboard.example/api/ingest/"),
                         "https://dashboard.example/api/ingest")
        for url in ("http://example/api/ingest", "https://u:pw@example/api/ingest",
                    "https://example/api/ingest?token=x", "https://example/api/ingest#x",
                    "https://example/other", "https://example/api/ingest\n"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.module.endpoint(url)

    def test_token_file_requires_private_regular_file_and_never_prints_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "token")
            path.write_text(TOKEN + "\n")
            path.chmod(0o600)
            self.assertEqual(self.module.read_token(path), TOKEN)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                self.module.read_token(path)
            path.chmod(0o600)
            Path(tmp, "link").symlink_to(path)
            with self.assertRaises(ValueError):
                self.module.read_token(Path(tmp, "link"))
            path.write_text("an invalid secret")
            with self.assertRaisesRegex(ValueError, "^invalid device token$"):
                self.module.read_token(path)

    def test_checksum_failure_leaves_no_executable(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp, "download.tar.gz")
            with tarfile.open(source, "w:gz") as archive:
                data = b"fake executable"
                entry = tarfile.TarInfo("otelcol-contrib")
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
            target = Path(tmp, "binary")
            with self.assertRaises(ValueError):
                self.module.unpack_binary(source, "0" * 64, target)
            self.assertFalse(target.exists())
            checksum = hashlib.sha256(source.read_bytes()).hexdigest()
            self.module.unpack_binary(source, checksum, target)
            self.assertEqual(target.read_bytes(), b"fake executable")
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)

    def test_archive_symlink_and_duplicate_binary_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp, "input.tgz"), Path(tmp, "output")
            with tarfile.open(source, "w:gz") as archive:
                entry = tarfile.TarInfo("otelcol-contrib")
                entry.type, entry.linkname = tarfile.SYMTYPE, "/bin/sh"
                archive.addfile(entry)
            with self.assertRaises(ValueError):
                self.module.unpack_binary(source, hashlib.sha256(source.read_bytes()).hexdigest(), target)
            self.assertFalse(target.exists())

    def test_both_clients_preserve_provider_model_auth_and_report_privacy_optout(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / ".codex").mkdir()
            (home / ".claude").mkdir()
            codex = home / ".codex/config.toml"
            codex.write_text('model="custom-model"\nmodel_provider="custom"\n'
                             '[model_providers.custom]\nbase_url="https://private.example/v1"\n'
                             'env_key="MY_EXISTING_KEY"\n[analytics]\nenabled=false\n')
            claude = home / ".claude/settings.json"
            claude.write_text('{"model":"chosen","env":{"ANTHROPIC_BASE_URL":"https://private.example"}}')
            auth = home / ".codex/auth.json"
            auth.write_text('{"private":"unchanged"}')
            changes, notes = self.module.client_plan(home, "developer")
            self.module.configurator.apply(changes)
            config = self.module.configurator.toml_load(codex.read_text())
            self.assertEqual(config["model"], "custom-model")
            self.assertEqual(config["model_providers"]["custom"]["env_key"], "MY_EXISTING_KEY")
            self.assertFalse(config["analytics"]["enabled"])
            self.assertTrue(any("analytics.enabled=false" in note for note in notes))
            self.assertEqual(auth.read_text(), '{"private":"unchanged"}')
            self.assertEqual(json.loads(claude.read_text())["env"]["ANTHROPIC_BASE_URL"],
                             "https://private.example")
            self.assertEqual(config["otel"]["metrics_exporter"]["otlp-http"]["endpoint"],
                             "http://127.0.0.1:4318/v1/metrics")
            self.assertEqual(self.module.client_plan(home, "developer")[0], [])

    def test_unmanaged_client_conflict_preserves_both_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / ".codex").mkdir()
            (home / ".claude").mkdir()
            codex = home / ".codex/config.toml"
            codex.write_text('[otel]\nexporter="none"\n')
            claude = home / ".claude/settings.json"
            claude.write_text('{"model":"chosen"}')
            with self.assertRaises(ValueError):
                self.module.client_plan(home, "developer")
            self.assertEqual(claude.read_text(), '{"model":"chosen"}')

    def test_launchd_uses_literal_arguments_for_shell_sensitive_paths(self):
        path = Path("/Users/example $(touch nope)/ccdash")
        data = plistlib.loads(self.module.launchd_service(path))
        self.assertEqual(data["ProgramArguments"][0], str(path / "otelcol-contrib"))
        self.assertEqual(data["ProgramArguments"][1:], ["--config", str(path / "config.yaml")])
        self.assertNotIn("sh", data["ProgramArguments"])

    def test_systemd_escapes_specifiers_and_keeps_exec_arguments_literal(self):
        data = self.module.systemd_service(Path('/home/a %n " name/ccdash'))
        self.assertIn('%%n', data)
        self.assertIn('\\"', data)
        self.assertNotIn("/bin/sh", data)

    def test_unmanaged_install_and_symlink_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp, "install")
            root.mkdir()
            (root / "unexpected").write_text("keep")
            with self.assertRaises(ValueError):
                self.module.check_install_root(root)
            self.assertEqual((root / "unexpected").read_text(), "keep")
            link = Path(tmp, "link")
            link.symlink_to(root)
            with self.assertRaises(ValueError):
                self.module.check_install_root(link)

    def test_codex_launcher_infers_provider_backend_without_changing_model_or_provider(self):
        spec = importlib.util.spec_from_file_location("launcher", ROOT / "launch-codex.py")
        launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(launcher)
        config = {"model": "leave-this-model", "model_provider": "custom",
                  "model_providers": {"custom": {"base_url": "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1"}}}
        arguments = ["--model", "another-model", "exec", "hello"]
        command, env = launcher.launch_command(config, arguments, {})
        self.assertEqual(command[-len(arguments):], arguments)
        self.assertFalse(any(value.startswith(("model=", "model_provider=", "model_providers.")) for value in command))
        self.assertEqual(sum("x-ccdash-backend" in value and "bedrock-runtime" in value for value in command), 3)
        self.assertEqual(config["model"], "leave-this-model")

    def test_codex_custom_provider_is_not_guessed_from_a_model_name(self):
        spec = importlib.util.spec_from_file_location("launcher", ROOT / "launch-codex.py")
        launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(launcher)
        command, _ = launcher.launch_command({"model": "us.openai.any", "model_provider": "custom"},
                                            ["exec", "hello"], {})
        self.assertFalse(any("bedrock-runtime" in value or "bedrock-mantle" in value for value in command))

    def test_install_replacement_updates_private_token_and_preserves_client_settings(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            root = home / ".local/share/ccdash-collector"
            unit = home / ".config/systemd/user/ccdash-collector.service"
            token_file = home / "provided-token"
            token_file.write_text(TOKEN)
            token_file.chmod(0o600)
            args = SimpleNamespace(endpoint="https://dashboard.example/api/ingest", token_file=token_file,
                                   user_id="fixture")
            def binary(stage, release):
                self.module.atomic(stage / "otelcol-contrib", "#!/bin/sh\nexit 0\n", 0o700)
            def external(command, required=True, output=False):
                return "" if output else True
            with patch.object(self.module, "download_binary", binary), patch.object(self.module, "run", external), \
                    patch.object(self.module.socket, "socket") as sockets:
                sockets.return_value.__enter__.return_value.connect_ex.return_value = self.module.errno.ECONNREFUSED
                self.module.install(args, home, "fixture", os.getuid(), root, unit)
                token_file.write_text(TOKEN[:-1] + "D")
                self.module.install(args, home, "fixture", os.getuid(), root, unit)
            self.assertEqual((root / "token").read_text(), TOKEN[:-1] + "D\n")
            self.assertEqual((root / "token").stat().st_mode & 0o777, 0o600)
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            self.assertNotIn(TOKEN, unit.read_text())
            self.assertNotIn(TOKEN, (root / "config.yaml").read_text())
            self.assertEqual(self.module.client_plan(home, "fixture")[0], [])

    def test_existing_global_user_service_and_dropins_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            unit = Path(tmp, "ccdash-collector.service")
            def existing_unit(command, required=True, output=False):
                if output:
                    return "/etc/systemd/user/ccdash-collector.service\n" if "FragmentPath" in " ".join(command) else ""
                return True
            with patch.object(self.module, "run", existing_unit), self.assertRaisesRegex(ValueError, "service comes from"):
                self.module.check_service(unit, "fixture")

    def test_failed_service_stop_does_not_allow_install_or_uninstall_to_continue(self):
        def service(unit, action, uid):
            return action == "status"
        with patch.object(self.module, "service_command", service), self.assertRaisesRegex(ValueError, "still running"):
            self.module.stop_service(Path("/tmp/fixture.service"), os.getuid())

    def test_project_provider_configuration_disables_unverified_backend_inference(self):
        spec = importlib.util.spec_from_file_location("launcher", ROOT / "launch-codex.py")
        launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(launcher)
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp, "home")
            project = home / "project"
            (project / ".codex").mkdir(parents=True)
            (project / ".codex/config.toml").write_text('model_provider="custom"\n')
            self.assertTrue(launcher.project_provider_config(project, home / ".codex/config.toml"))
        command, _ = launcher.launch_command({"model_provider": "amazon-bedrock"}, ["exec", "hello"], {},
                                            provenance_known=False)
        self.assertFalse(any("bedrock-mantle" in value for value in command))

    def test_config_profile_override_preserves_selection_without_guessing_backend(self):
        spec = importlib.util.spec_from_file_location("launcher", ROOT / "launch-codex.py")
        launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(launcher)
        config = {"model_provider": "openai", "profiles": {"work": {"model_provider": "amazon-bedrock"}}}
        command, _ = launcher.launch_command(config, ["-c", 'profile="work"'], {})
        self.assertFalse(any("bedrock-mantle" in value for value in command))
        self.assertEqual(command[-2:], ["-c", 'profile="work"'])


if __name__ == "__main__":
    unittest.main()
