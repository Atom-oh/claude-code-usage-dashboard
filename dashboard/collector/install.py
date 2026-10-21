#!/usr/bin/env python3
"""Install, check, or remove the private per-device ccdash Collector."""
import argparse
import fcntl
import getpass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import pwd
import re
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "vendor"))
spec = importlib.util.spec_from_file_location("client_telemetry", HERE / "generated/configure-client-telemetry.py")
configurator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configurator)
LABEL = "org.ccdash.collector"
MARKER = "ccdash-device-collector-v1"
TOKEN_PATTERN = re.compile(r"ccd1\.[a-f0-9]{64}\.[a-f0-9]{32}\.[A-Za-z0-9_-]{43}")
MAINTENANCE_FILES = (
    "install.py", "launch-codex.py", "release.json", "README.md",
    "generated/configure-client-telemetry.py", "generated/local.yaml",
    "vendor/tomli/__init__.py", "vendor/tomli/_parser.py", "vendor/tomli/_re.py",
    "vendor/tomli/_types.py", "vendor/tomli/LICENSE",
)


def endpoint(value):
    if any(ord(char) < 33 for char in value):
        raise ValueError("endpoint must be a public HTTPS /api/ingest URL")
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path.rstrip("/") != "/api/ingest"):
        raise ValueError("endpoint must be a public HTTPS /api/ingest URL")
    return value.rstrip("/")


def read_token(path=None):
    if path:
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            raise ValueError("token file must be a private regular file owned by you (mode 0600)") from None
        with os.fdopen(fd, "r") as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                raise ValueError("token file must be a private regular file owned by you (mode 0600)")
            token = file.read(512).strip()
    else:
        if not sys.stdin.isatty():
            raise ValueError("use a terminal for the hidden token prompt or --token-file with a mode 0600 file")
        token = getpass.getpass("Device token (hidden): ").strip()
    if not TOKEN_PATTERN.fullmatch(token):
        raise ValueError("invalid device token")
    return token


def atomic(path, content, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise ValueError("refusing to replace a symlink")
    fd, temporary = tempfile.mkstemp(prefix=".ccdash-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(content.encode() if isinstance(content, str) else content)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def copy_atomic(source, destination, mode=0o600):
    """Copy large binaries/rollback files without loading them into memory."""
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.is_symlink():
        raise ValueError("refusing to replace a symlink")
    fd, temporary = tempfile.mkstemp(prefix=".ccdash-", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as output, source.open("rb") as input_file:
            shutil.copyfileobj(input_file, output, 1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def file_state(path):
    if path.is_symlink():
        raise ValueError("managed file changed to a symlink")
    if not path.exists():
        return None
    if not path.is_file():
        raise ValueError("managed file is not a regular file")
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return (stat.S_IMODE(path.stat().st_mode), digest.digest())


def snapshot_files(paths, directory):
    snapshots = {}
    for index, path in enumerate(paths):
        state, backup = file_state(path), directory / str(index)
        if state is not None:
            copy_atomic(path, backup, state[0])
            if file_state(backup) != state or file_state(path) != state:
                raise ValueError("configuration changed while preparing installation; rerun setup")
        snapshots[path] = (state, backup)
    return snapshots


def assert_unchanged(snapshots):
    if any(file_state(path) != state for path, (state, _) in snapshots.items()):
        raise ValueError("configuration changed during installation; no service update was applied")


def restore_file(path, snapshot):
    state, backup = snapshot
    if state is None:
        path.unlink(missing_ok=True)
    else:
        copy_atomic(backup, path, state[0])


def unpack_binary(archive, checksum, destination):
    digest = hashlib.sha256()
    with open(archive, "rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != checksum:
        raise ValueError("Collector download checksum mismatch; nothing was executed")
    with tarfile.open(archive, "r:gz") as bundle:
        matches = [entry for entry in bundle if entry.name in ("otelcol-contrib", "./otelcol-contrib")]
        if len(matches) != 1 or not matches[0].isfile() or matches[0].size > 800 * 1024 * 1024:
            raise ValueError("Collector archive has no unique regular executable")
        # Read one allowlisted regular file; never extract archive paths or links.
        atomic(destination, bundle.extractfile(matches[0]).read(), 0o700)


def client_plan(home, user_id):
    codex = home / ".codex/config.toml"
    claude = home / ".claude/settings.json"
    changes = configurator.plan(codex, claude, True, True, user_id)
    original = configurator.toml_load(codex.read_text() if codex.exists() else "")
    notes = []
    if original.get("analytics", {}).get("enabled") is False:
        notes.append("Codex analytics.enabled=false disables custom metrics; your privacy setting is preserved. "
                     "Enable it yourself only if you want Codex metrics.")
    return changes, notes


def check_install_root(root):
    if any(ord(char) < 32 or ord(char) == 127 for char in str(root)):
        raise ValueError("installation paths must not contain control characters")
    for path in (root, *root.parents):
        if path.is_symlink():
            raise ValueError("installation paths must not contain symlinks")
    if root.exists():
        state = root / "state.json"
        if not state.is_file() or state.is_symlink():
            raise ValueError("installation directory is unmanaged; choose or remove it yourself")
        try:
            data = json.loads(state.read_text())
        except (ValueError, OSError):
            raise ValueError("installation state is invalid") from None
        if data.get("managedBy") != MARKER:
            raise ValueError("installation directory is unmanaged")


def systemd_quote(value):
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%") + '"'


def systemd_service(root):
    return ("# " + MARKER + "\n[Unit]\nDescription=ccdash device telemetry\nAfter=network-online.target\n"
            "Wants=network-online.target\n[Service]\n"
            + "ExecStart=:" + systemd_quote(root / "otelcol-contrib")
            + " --config " + systemd_quote(root / "config.yaml") + "\n"
            "Restart=always\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\n"
            "[Install]\nWantedBy=default.target\n")


def launchd_service(root):
    return plistlib.dumps({"Label": LABEL, "Comment": MARKER,
                           "ProgramArguments": [str(root / "otelcol-contrib"), "--config", str(root / "config.yaml")],
                           "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 5,
                           "Umask": 0o077, "StandardOutPath": str(root / "collector.log"),
                           "StandardErrorPath": str(root / "collector.log")})


def run(command, required=True, output=False):
    environment = dict(os.environ)
    runtime = Path("/run/user") / str(os.getuid())
    if sys.platform == "linux" and (runtime / "bus").exists():
        environment["XDG_RUNTIME_DIR"] = str(runtime)
        environment["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=" + str(runtime / "bus")
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90, env=environment)
    if required and result.returncode:
        raise ValueError("service or Collector command failed; use status and the service journal for details")
    if output:
        return result.stdout.decode("utf-8", errors="replace").strip() if result.returncode == 0 else None
    return result.returncode == 0


def service_location(home):
    if sys.platform == "darwin":
        return home / "Library/LaunchAgents" / (LABEL + ".plist")
    if sys.platform != "linux":
        raise ValueError("only Linux and macOS are supported")
    return home / ".config/systemd/user/ccdash-collector.service"


def service_command(unit, action, uid):
    if sys.platform == "darwin":
        domain = "gui/" + str(uid)
        commands = {"start": ["launchctl", "bootstrap", domain, str(unit)],
                    "stop": ["launchctl", "bootout", domain + "/" + LABEL],
                    "status": ["launchctl", "print", domain + "/" + LABEL]}
        return run(commands[action], required=action == "start")
    command = ["systemctl", "--user"]
    if action == "start":
        run(command + ["daemon-reload"])
        return run(command + ["enable", "--now", unit.name])
    if action == "stop":
        return run(command + ["disable", "--now", unit.name], required=False)
    return run(command + ["is-active", "--quiet", unit.name], required=False)


def stop_service(unit, uid):
    if not service_command(unit, "stop", uid) and service_command(unit, "status", uid):
        raise ValueError("managed Collector is still running; resolve the service error before retrying")


def check_service(unit, user):
    if unit.is_symlink():
        raise ValueError("service file is a symlink")
    if unit.exists() and MARKER not in unit.read_text():
        raise ValueError("existing service is unmanaged; migrate it before installing")
    # Do not take ports from an unrelated Collector, including historical services.
    if sys.platform == "linux":
        command = ["systemctl", "--user"]
        if not run(command + ["show-environment"], required=False):
            raise ValueError("systemd user manager unavailable. Run `sudo loginctl enable-linger "
                             + user + "` and log in again, then rerun this installer as " + user + ".")
        fragment = run(command + ["show", "--property=FragmentPath", "--value", unit.name],
                       required=False, output=True)
        if fragment and Path(fragment) != unit:
            raise ValueError("service comes from another location; migrate it before installing")
        dropins = run(command + ["show", "--property=DropInPaths", "--value", unit.name],
                      required=False, output=True)
        if dropins:
            raise ValueError("service has unmanaged drop-ins; migrate them before installing")
    elif not unit.exists() and service_command(unit, "status", os.getuid()):
        raise ValueError("LaunchAgent label is already loaded from an unmanaged location")
    if not unit.exists():
        for port in (4317, 4318, 13133):
            with socket.socket() as sock:
                try:
                    sock.bind(("127.0.0.1", port))
                except OSError:
                    raise ValueError("local Collector port is occupied; migrate the existing service first") from None


def render_config(root, ingest_endpoint, user_id):
    text = (HERE / "generated/local.yaml").read_text()
    replacements = {"OTELCOL_QUEUE_DIR": str(root / "queue"), "CCDASH_TOKEN_FILE": str(root / "token"),
                    "CCDASH_INGEST_ENDPOINT": ingest_endpoint, "CODEX_DEFAULT_USER_EMAIL": user_id,
                    "CLAUDE_ENABLED": "true", "CODEX_ENABLED": "true", "EXPERIMENT_GROUP": "unknown"}
    def replace(match):
        value = replacements[match.group(1)]
        # OTTL strings already quote their placeholders; these values are validated identifiers.
        if match.group(1) in ("CLAUDE_ENABLED", "CODEX_ENABLED", "CODEX_DEFAULT_USER_EMAIL"):
            return value
        return json.dumps(value.replace("$", "$$"))
    return re.sub(r"\$\{env:([A-Z_]+)(?::-[^}]*)?\}", replace, text)


def download_binary(root, release):
    machine = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine())
    key = sys.platform + "-" + str(machine)
    if key not in release["assets"]:
        raise ValueError("unsupported CPU architecture")
    name = "otelcol-contrib_" + release["version"] + "_" + sys.platform + "_" + machine + ".tar.gz"
    url = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v" + release["version"] + "/" + name
    archive = root / "download.tar.gz"
    with urllib.request.urlopen(url, timeout=60) as response, archive.open("wb") as file:
        total = 0
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            total += len(block)
            if total > 200 * 1024 * 1024:
                raise ValueError("Collector download exceeds the expected size")
            file.write(block)
    unpack_binary(archive, release["assets"][key], root / "otelcol-contrib")
    archive.unlink()


def install(args, home, user, uid, root, unit):
    ingest_endpoint = endpoint(args.endpoint)
    check_install_root(root)
    check_service(unit, user)
    changes, notes = client_plan(home, args.user_id or user)
    for note in notes:
        print(note)
    token = read_token(args.token_file)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    if not (root / "state.json").exists():
        atomic(root / "state.json", json.dumps({"managedBy": MARKER, "pending": True}) + "\n")
    # The lock prevents two token replacements from crossing configuration updates.
    with (root / ".install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stage = Path(tempfile.mkdtemp(prefix=".prepare-", dir=root))
        keep_recovery = False
        try:
            managed_paths = [root / name for name in ("token", "config.yaml", "otelcol-contrib",
                                                     "state.json", *MAINTENANCE_FILES)] + [unit]
            managed_before = snapshot_files(managed_paths, stage / "before-managed")
            clients_before = snapshot_files([home / ".codex/config.toml", home / ".claude/settings.json"],
                                            stage / "before-clients")
            old_running = unit.exists() and service_command(unit, "status", uid)
            old_enabled = unit.exists() and (old_running if sys.platform == "darwin" else
                                             run(["systemctl", "--user", "is-enabled", "--quiet", unit.name],
                                                 required=False))
            release = json.loads((HERE / "release.json").read_text())
            print("Downloading and verifying OpenTelemetry Collector " + release["version"])
            download_binary(stage, release)
            atomic(stage / "token", token + "\n")
            atomic(stage / "config.yaml", render_config(stage, ingest_endpoint, args.user_id or user))
            if not run([str(stage / "otelcol-contrib"), "validate", "--config", str(stage / "config.yaml")],
                       required=False):
                raise ValueError("Collector rejected its configuration; client settings were not changed")
            # Prepare every runtime file before stopping the current service.
            atomic(stage / "config.yaml", render_config(root, ingest_endpoint, args.user_id or user))
            for relative in MAINTENANCE_FILES:
                copy_atomic(HERE / relative, stage / relative)
            atomic(stage / "state.json", json.dumps({"managedBy": MARKER, "endpoint": ingest_endpoint,
                                                     "version": release["version"], "unit": str(unit),
                                                     "userId": args.user_id or user}) + "\n")
            atomic(stage / "service", systemd_service(root) if sys.platform == "linux" else launchd_service(root))
            prepared = {path: stage / ("service" if path == unit else str(path.relative_to(root)))
                        for path in managed_paths}
            prepared_states = {path: file_state(source) for path, source in prepared.items()}
            # Include unchanged client files: rerunning token setup often has an
            # empty change plan, but an edit during download still cancels setup.
            assert_unchanged(managed_before)
            assert_unchanged(clients_before)
            if client_plan(home, args.user_id or user)[0] != changes:
                raise ValueError("client configuration changed during preparation; rerun setup")
            check_service(unit, user)
            written = []
            clients_attempted = False
            try:
                if unit.exists():
                    stop_service(unit, uid)
                assert_unchanged(clients_before)
                for path, source in prepared.items():
                    written.append(path)
                    copy_atomic(source, path, prepared_states[path][0])
                clients_attempted = True
                configurator.apply(changes)
                service_command(unit, "start", uid)
            except BaseException:
                try:
                    # A failed start may already have launched the new process.
                    # Stop it before restoring its token, binary or configuration.
                    if unit.exists():
                        stop_service(unit, uid)
                    for path in reversed(written):
                        current = file_state(path)
                        if current == managed_before[path][0]:
                            continue
                        if current != prepared_states[path]:
                            raise ValueError("managed file changed while rolling back")
                        restore_file(path, managed_before[path])
                    for path, _, new in (changes if clients_attempted else []):
                        expected = (0o600, hashlib.sha256(new.encode()).digest())
                        # Preserve edits made by another process after our write.
                        try:
                            current = file_state(path)
                        except (OSError, ValueError):
                            continue
                        if current == expected:
                            restore_file(path, clients_before[path])
                    if old_running:
                        service_command(unit, "start", uid)
                    elif old_enabled and sys.platform == "linux":
                        run(["systemctl", "--user", "daemon-reload"])
                        run(["systemctl", "--user", "enable", unit.name])
                    if old_running and not old_enabled and sys.platform == "linux":
                        run(["systemctl", "--user", "disable", unit.name])
                except BaseException:
                    keep_recovery = True
                    raise ValueError("installation rollback could not finish; private recovery files remain in "
                                     + str(stage)) from None
                raise
        finally:
            if not keep_recovery:
                shutil.rmtree(stage)
        print("Collector service started. Restart Claude Code and Codex to load telemetry settings.")
        print("For Codex backend provenance, launch with: python3 " + shlex.quote(str(root / "launch-codex.py")))
        print("Check: python3 " + shlex.quote(str(root / "install.py")) + " status")
        print("Delivery is confirmed by the dashboard device last-delivery time, not an idle local queue.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "status", "check", "uninstall"))
    parser.add_argument("--endpoint", help="dashboard HTTPS /api/ingest URL")
    parser.add_argument("--token-file", type=Path, help="private mode 0600 file; token values are never CLI arguments")
    parser.add_argument("--user-id", help="nonsecret telemetry attribution ID (defaults to local login)")
    args = parser.parse_args()
    try:
        if os.geteuid() == 0:
            raise ValueError("run this installer as your login user without sudo")
        account = pwd.getpwuid(os.getuid())
        home, user, uid, gid = Path(account.pw_dir), account.pw_name, account.pw_uid, account.pw_gid
        if not re.fullmatch(r"[a-zA-Z0-9_.@-]+", user):
            raise ValueError("unsupported login name")
        for name in ("CODEX_HOME", "CLAUDE_CONFIG_DIR"):
            if os.environ.get(name):
                raise ValueError("custom client config directories need manual setup; unset " + name
                                 + " only if the default home config is intended")
        if args.action == "install" and not args.endpoint:
            raise ValueError("install requires --endpoint from the dashboard collector page")
        root = home / ".local/share/ccdash-collector"
        unit = service_location(home)
        if args.action == "install":
            install(args, home, user, uid, root, unit)
            return 0
        check_install_root(root)
        if not root.exists():
            raise ValueError("Collector is not installed for this account")
        state = json.loads((root / "state.json").read_text())
        if state.get("pending"):
            raise ValueError("installation is incomplete; rerun install")
        if state["unit"] != str(unit):
            raise ValueError("installation service path differs; review the saved state")
        if args.action == "uninstall":
            if unit.is_symlink() or (unit.exists() and MARKER not in unit.read_text()):
                raise ValueError("service no longer belongs to ccdash; refusing to remove it")
            stop_service(unit, uid)
            unit.unlink(missing_ok=True)
            (root / "token").unlink(missing_ok=True)
            print("Service and local token removed. Revoke the device on /collector.")
            print("Client configuration and backups are retained. Restore reviewed .ccdash-backup files "
                  "or remove only the managed Codex block and Claude OTEL settings; keep model/auth settings.")
            print("After reviewing retained queue and files, you may remove " + str(root))
            return 0
        read_token(root / "token")
        changes, notes = client_plan(home, state["userId"])
        for note in notes:
            print(note)
        running = service_command(unit, "status", uid)
        healthy = False
        try:
            with urllib.request.urlopen("http://127.0.0.1:13133", timeout=3) as response:
                healthy = response.status == 200
        except OSError:
            pass
        print(json.dumps({"serviceRunning": running, "localCollectorHealthy": healthy,
                          "clientConfigurationCurrent": not changes,
                          "deliveryVerification": "Check device last-delivery time on the dashboard"}))
        return 0 if running and healthy and not changes else 1
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        # SDK/download/OS diagnostics may expose URLs or environment details.
        message = str(error) if isinstance(error, ValueError) else "operation failed; check permissions, network and service status"
        print("ccdash collector: " + message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
