#!/usr/bin/env python3
"""Install, check, or remove the private per-device ccdash Collector."""
import argparse
import errno
import fcntl
import getpass
import hashlib
import http.client
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
import time
import urllib.parse
import urllib.request
from xml.parsers.expat import ExpatError

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "vendor"))
spec = importlib.util.spec_from_file_location("client_telemetry", HERE / "generated/configure-client-telemetry.py")
configurator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configurator)
LABEL = "org.ccdash.collector"
LEGACY_LABEL = "com.ccdash.otelcol"
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


def occupied_ports():
    ports = []
    for port in (4317, 4318, 13133):
        # Detect wildcard listeners even on systems that permit a reusable
        # loopback bind beside them. Closed TIME_WAIT connections refuse this.
        with socket.socket() as probe:
            try:
                probe.settimeout(0.2)
                result = probe.connect_ex(("127.0.0.1", port))
            except OSError as error:
                result = error.errno
            if result == 0:
                ports.append(port)
                continue
            if result != errno.ECONNREFUSED:
                raise ValueError("cannot check local port " + str(port) + ": "
                                 + errno.errorcode.get(result, "OS error"))
        with socket.socket() as sock:
            try:
                # Match the Collector's Go TCP listener: closed connections in
                # TIME_WAIT must not prevent replacement or rollback.
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(("127.0.0.1", port))
                sock.listen(1)
            except OSError as error:
                if error.errno != errno.EADDRINUSE:
                    raise ValueError("cannot check local port " + str(port) + ": "
                                     + errno.errorcode.get(error.errno, "OS error")) from None
                ports.append(port)
    return ports


def check_ports(legacy=None):
    ports = occupied_ports()
    for port in ports:
        # Read PID fields only; process arguments and environments may contain secrets.
        owners = set()
        if sys.platform == "darwin":
            output = run(["lsof", "-nP", "-a", "-iTCP:" + str(port), "-sTCP:LISTEN", "-Fp"],
                         required=False, output=True)
            owners = set(re.findall(r"^p([0-9]+)$", output or "", re.MULTILINE))
        if not legacy or not legacy["pid"] or owners != {legacy["pid"]}:
            detail = " (PID " + ", ".join(sorted(owners)) + ")" if owners else ""
            inspect = "lsof -nP -iTCP -sTCP:LISTEN" if sys.platform == "darwin" else "ss -ltnp"
            raise ValueError("local port " + str(port) + detail
                             + " is occupied by an unverified service; inspect with `" + inspect
                             + "`. Workshop collectors require organizer migration.")


def legacy_mac_state(home, uid):
    """Recognize only the historical per-user script layout and its loaded job."""
    unit = home / "Library/LaunchAgents" / (LEGACY_LABEL + ".plist")
    if not unit.exists() and not unit.is_symlink():
        return None
    config = home / ".otelcol/config.yaml"
    paths = [unit, config]
    for name in ("env", "enable-test-telemetry.sh"):
        path = home / ".otelcol" / name
        if path.exists() or path.is_symlink():
            paths.append(path)
    states = {}
    for path in paths:
        if any(p.is_symlink() for p in (path, *path.parents)):
            raise ValueError("legacy service/configuration has a symlink; manual migration required")
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
            raise ValueError("legacy service/configuration must be regular files owned by you, not writable by others")
        states[path] = file_state(path)
    try:
        data = plistlib.loads(unit.read_bytes())
    except (ValueError, plistlib.InvalidFileException, ExpatError):
        raise ValueError("legacy LaunchAgent is invalid; manual migration required") from None
    if not isinstance(data, dict):
        raise ValueError("legacy LaunchAgent is invalid; manual migration required") from None
    arguments = data.get("ProgramArguments")
    if (data.get("Label") != LEGACY_LABEL or not isinstance(arguments, list)
            or not all(isinstance(arg, str) and not any(ord(c) < 32 for c in arg) for arg in arguments)
            or not arguments or not Path(arguments[0]).is_absolute()
            or Path(arguments[0]).name != "otelcol-contrib"
            or arguments[1:] not in (["--config=" + str(config)], ["--config", str(config)])
            or data.get("Program", arguments[0]) != arguments[0]):
        raise ValueError("legacy LaunchAgent does not match the known personal Collector; manual migration required")
    domain = "gui/" + str(uid)
    target = domain + "/" + LEGACY_LABEL
    if not run(["launchctl", "print", domain], required=False):
        raise ValueError("macOS login service manager unavailable; run setup from your logged-in desktop session")
    disabled = run(["launchctl", "print-disabled", domain], required=False, output=True)
    if disabled is None:
        raise ValueError("cannot inspect legacy LaunchAgent enablement; no service was changed")
    override = re.search(r'^\s*"' + re.escape(LEGACY_LABEL) + r'"\s*=>\s*(.*?)\s*$',
                         disabled, re.MULTILINE)
    if ("disabled services = {" not in disabled
            or (override and override[1] not in ("true", "false", "enabled", "disabled"))
            or (not override and '"' + LEGACY_LABEL + '"' in disabled)):
        raise ValueError("cannot interpret legacy LaunchAgent enablement; no service was changed")
    is_disabled = override[1] in ("true", "disabled") if override else bool(data.get("Disabled", False))
    loaded = run(["launchctl", "print", target], required=False, output=True)
    pid = None
    if loaded is not None:
        # launchctl print is diagnostic text, not a stable API. Fail closed if
        # its format changes; never print the captured environment to the user.
        path_match = re.search(r"^\tpath = (.+)$", loaded, re.MULTILINE)
        program_match = re.search(r"^\tprogram = (.+)$", loaded, re.MULTILINE)
        args_match = re.search(r"^\targuments = \{\n(.*?)^\t\}", loaded, re.MULTILINE | re.DOTALL)
        runtime_arguments = args_match[1].splitlines() if args_match else []
        if (not path_match or path_match[1] != str(unit)
                or not program_match or program_match[1] != arguments[0]
                or runtime_arguments != ["\t\t" + arg for arg in arguments]):
            raise ValueError("loaded legacy service has an unverified location or arguments; manual migration required")
        pid_match = re.search(r"^\tpid = ([0-9]+)$", loaded, re.MULTILINE)
        pid = pid_match[1] if pid_match else None
    return {"unit": unit, "target": target, "domain": domain, "files": states,
            "loaded": loaded is not None, "disabled": is_disabled, "pid": pid}


def confirm_legacy(args, legacy):
    print("Found legacy macOS Collector: " + str(legacy["unit"]))
    print("Migration will back up its settings, disable its LaunchAgent, and start the device Collector.")
    print("Close Claude Code/Codex and let the old queue drain first. The old queue stays in ~/.otelcol; "
          "it is not imported. Failed installation restores the previous service state.")
    if getattr(args, "migrate_legacy", False):
        return
    if not sys.stdin.isatty():
        raise ValueError("legacy migration requires terminal confirmation or explicit --migrate-legacy")
    try:
        answer = input("Migrate this legacy Collector now? [y/N]: ").strip().lower()
    except EOFError:
        answer = ""
    if answer not in ("y", "yes"):
        raise ValueError("migration cancelled; the existing service is unchanged")


def migration_user_id(args, home):
    if args.user_id:
        return args.user_id
    settings = home / ".claude/settings.json"
    if settings.is_symlink():
        raise ValueError("client configuration is a symlink; configure its owner instead")
    try:
        data = json.loads(settings.read_text()) if settings.exists() else {}
    except ValueError:
        raise ValueError("invalid Claude settings JSON; no client configuration was changed") from None
    if not isinstance(data, dict) or not isinstance(data.get("env", {}), dict):
        raise ValueError("Claude settings and env must be JSON objects; no files changed")
    # Settings-owned attributes shadow shell attributes. Do not invent a new
    # identity when the existing owner does not specify a usable user.email.
    attributes = data.get("env", {}).get("OTEL_RESOURCE_ATTRIBUTES", os.environ.get("OTEL_RESOURCE_ATTRIBUTES", ""))
    if not isinstance(attributes, str):
        raise ValueError("Claude resource attributes must be a string; no files changed")
    values = {}
    for part in attributes.split(","):
        key, separator, value = part.partition("=")
        if separator:
            values[key.strip()] = value.strip()
    candidate = values.get("user.email", "")
    if re.fullmatch(r"[A-Za-z0-9._+@-]+", candidate):
        return candidate
    if not sys.stdin.isatty():
        raise ValueError("existing telemetry identity could not be determined; provide --user-id for migration")
    try:
        return input("Existing telemetry user ID/email (required): ").strip()
    except EOFError:
        raise ValueError("provide --user-id for migration; no service was changed") from None


def backup_legacy(legacy, root):
    directory = Path(tempfile.mkdtemp(prefix="legacy-backup-", dir=root))
    for path, state in legacy["files"].items():
        copy_atomic(path, directory / path.name, 0o600)
        if file_state(path) != state or file_state(directory / path.name)[1] != state[1]:
            raise ValueError("legacy configuration changed while backing up; no service was changed")
    atomic(directory / "migration.json", json.dumps({
        "service": str(legacy["unit"]), "loaded": legacy["loaded"], "disabled": legacy["disabled"],
        "files": [{"path": str(path), "backup": path.name, "mode": state[0], "sha256": state[1].hex()}
                  for path, state in legacy["files"].items()],
        "queue": "Preserved in place at ~/.otelcol/queue; not imported.",
    }, indent=2) + "\n")
    print("Private legacy backup: " + str(directory))
    return directory


def wait_for_free_ports():
    # bootout can return before either Collector has released its listeners.
    for _ in range(50):
        if not occupied_ports():
            return
        time.sleep(0.1)
    check_ports()  # Report the remaining conflict without touching its owner.


def stop_legacy(legacy):
    run(["launchctl", "disable", legacy["target"]])
    if legacy["loaded"]:
        run(["launchctl", "bootout", legacy["target"]])
    wait_for_free_ports()


def restore_legacy(legacy, home, uid):
    current = legacy_mac_state(home, uid)
    if current is None or current["files"] != legacy["files"]:
        raise ValueError("legacy files changed during installation; manual recovery required")
    if current["loaded"] and not legacy["loaded"]:
        raise ValueError("legacy service was started by another process; manual recovery required")
    if legacy["loaded"] and not current["loaded"]:
        wait_for_free_ports()
        run(["launchctl", "enable", legacy["target"]])
        try:
            run(["launchctl", "bootstrap", legacy["domain"], str(legacy["unit"])])
        finally:
            if legacy["disabled"]:
                run(["launchctl", "disable", legacy["target"]])
    else:
        run(["launchctl", "disable" if legacy["disabled"] else "enable", legacy["target"]])


def local_collector_healthy(timeout=1):
    # Direct loopback HTTP ignores corporate proxy environment settings
    # and does not follow redirects away from the local Collector.
    connection = http.client.HTTPConnection("127.0.0.1", 13133, timeout=timeout)
    try:
        connection.request("GET", "/")
        return connection.getresponse().status == 200
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def wait_for_local_collector(unit, uid):
    for _ in range(30):
        if service_command(unit, "status", uid) and local_collector_healthy():
            return
        time.sleep(0.2)
    raise ValueError("new Collector did not become locally healthy; restoring the previous service")


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
    legacy = legacy_mac_state(home, uid) if sys.platform == "darwin" and not unit.exists() else None
    if not unit.exists():
        check_ports(legacy)
    if legacy:
        confirm_legacy(args, legacy)
    user_id = migration_user_id(args, home) if legacy else args.user_id or user
    changes, notes = client_plan(home, user_id)
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
            atomic(stage / "config.yaml", render_config(stage, ingest_endpoint, user_id))
            if not run([str(stage / "otelcol-contrib"), "validate", "--config", str(stage / "config.yaml")],
                       required=False):
                raise ValueError("Collector rejected its configuration; client settings were not changed")
            # Prepare every runtime file before stopping the current service.
            atomic(stage / "config.yaml", render_config(root, ingest_endpoint, user_id))
            for relative in MAINTENANCE_FILES:
                copy_atomic(HERE / relative, stage / relative)
            atomic(stage / "state.json", json.dumps({"managedBy": MARKER, "endpoint": ingest_endpoint,
                                                     "version": release["version"], "unit": str(unit),
                                                     "userId": user_id}) + "\n")
            atomic(stage / "service", systemd_service(root) if sys.platform == "linux" else launchd_service(root))
            prepared = {path: stage / ("service" if path == unit else str(path.relative_to(root)))
                        for path in managed_paths}
            prepared_states = {path: file_state(source) for path, source in prepared.items()}
            # Include unchanged client files: rerunning token setup often has an
            # empty change plan, but an edit during download still cancels setup.
            assert_unchanged(managed_before)
            assert_unchanged(clients_before)
            if client_plan(home, user_id)[0] != changes:
                raise ValueError("client configuration changed during preparation; rerun setup")
            check_service(unit, user)
            if not unit.exists():
                if legacy and legacy_mac_state(home, uid) != legacy:
                    raise ValueError("legacy service or configuration changed during preparation; rerun setup")
                check_ports(legacy)
            if legacy:
                backup_legacy(legacy, root)
                if legacy_mac_state(home, uid) != legacy:
                    raise ValueError("legacy service or configuration changed during backup; rerun setup")
            written = []
            clients_attempted = False
            legacy_attempted = False
            try:
                if legacy:
                    legacy_attempted = True
                    stop_legacy(legacy)
                if unit.exists():
                    stop_service(unit, uid)
                assert_unchanged(clients_before)
                for path, source in prepared.items():
                    written.append(path)
                    copy_atomic(source, path, prepared_states[path][0])
                clients_attempted = True
                configurator.apply(changes)
                service_command(unit, "start", uid)
                if legacy:
                    wait_for_local_collector(unit, uid)
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
                    if legacy_attempted:
                        restore_legacy(legacy, home, uid)
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
    parser.add_argument("--migrate-legacy", action="store_true",
                        help="approve migration of the verified legacy personal macOS Collector without a prompt")
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
        healthy = local_collector_healthy(timeout=3)
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
