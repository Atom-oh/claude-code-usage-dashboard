#!/usr/bin/env python3
"""Configure local Claude/Codex telemetry without changing models or credentials."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile

BEGIN = "# >>> ccdash otel (setup-test-telemetry-all.sh) >>>"
END = "# <<< ccdash otel <<<"
CODEX_OTEL = '''[otel]
log_user_prompt = false
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }
metrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/metrics", protocol = "json" } }
trace_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/traces", protocol = "json" } }
'''
CLAUDE_ENV = {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "grpc",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4317",
    "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "cumulative",
    "OTEL_METRIC_EXPORT_INTERVAL": "10000",
    "OTEL_LOGS_EXPORT_INTERVAL": "5000",
    "OTEL_METRICS_INCLUDE_SESSION_ID": "true",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_TRACES_EXPORT_INTERVAL": "5000",
}


def toml_load(text):
    try:
        import tomllib
    except ImportError:
        try:
            import tomli as tomllib
        except ImportError:
            try:
                from pip._vendor import tomli as tomllib
            except ImportError:
                raise ValueError("Codex config validation needs Python 3.11+ or tomli") from None
    try:
        return tomllib.loads(text)
    except ValueError:
        raise ValueError("invalid Codex TOML; no client configuration was changed") from None


def codex_config(text, enabled):
    if not enabled and BEGIN not in text and END not in text:
        # A disabled client with no block we own needs no config operation.
        return text
    original = toml_load(text)
    lines = text.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if line.rstrip("\r\n") == BEGIN]
    ends = [i for i, line in enumerate(lines) if line.rstrip("\r\n") == END]
    if starts or ends:
        if len(starts) != 1 or len(ends) != 1 or ends[0] <= starts[0]:
            raise ValueError("malformed managed Codex telemetry markers; no files changed")
        stripped = "".join(lines[:starts[0]] + lines[ends[0] + 1:])
    else:
        stripped = text
    remaining = toml_load(stripped)
    if "otel" in remaining:
        if enabled and remaining["otel"] != toml_load(CODEX_OTEL)["otel"]:
            raise ValueError("unmanaged Codex [otel] conflicts with local collection; migrate it before setup")
        # A matching hand-written table already works. Never append a duplicate.
        return text
    result = stripped.rstrip() + "\n" if stripped.strip() else ""
    if enabled:
        result += "\n" + BEGIN + "\n" + CODEX_OTEL + END + "\n"
    after = toml_load(result)
    if {k: v for k, v in original.items() if k != "otel"} != {k: v for k, v in after.items() if k != "otel"}:
        raise ValueError("removing managed telemetry would change other Codex settings; no files changed")
    return result


def resource_attributes(value, user_id):
    attributes = {}
    for part in value.split(",") if value else []:
        key, sep, val = part.partition("=")
        if not sep or not key.strip():
            raise ValueError("invalid existing resource attributes; no files changed")
        attributes[key.strip()] = val.strip()
    attributes["user.email"] = user_id
    return ",".join(key + "=" + value for key, value in attributes.items())


def claude_config(text, enabled, user_id):
    try:
        data = json.loads(text or "{}")
    except ValueError:
        raise ValueError("invalid Claude settings JSON; no client configuration was changed") from None
    if not isinstance(data, dict) or not isinstance(data.get("env", {}), dict):
        raise ValueError("Claude settings and env must be JSON objects; no files changed")
    env = data.setdefault("env", {})
    if enabled:
        env.update(CLAUDE_ENV)
        # A new settings-owned string would shadow shell/project attribution.
        # Update only an existing owner; otherwise the shell helper owns identity.
        if "OTEL_RESOURCE_ATTRIBUTES" in env:
            old = env["OTEL_RESOURCE_ATTRIBUTES"]
            if not isinstance(old, str):
                raise ValueError("Claude resource attributes must be a string; no files changed")
            env["OTEL_RESOURCE_ATTRIBUTES"] = resource_attributes(old, user_id)
    else:
        env.update({"CLAUDE_CODE_ENABLE_TELEMETRY": "0", "OTEL_METRICS_EXPORTER": "none",
                    "OTEL_LOGS_EXPORTER": "none", "OTEL_TRACES_EXPORTER": "none"})
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def plan(codex_path, claude_path, codex_enabled, claude_enabled, user_id):
    if not re.fullmatch(r"[A-Za-z0-9._+@-]+", user_id):
        raise ValueError("user ID must contain only letters, digits, . _ + @ -")
    if not codex_enabled and not claude_enabled:
        raise ValueError("at least one client must be enabled")
    changes = []
    # Validate both clients before writing either one.
    for path, render in [(codex_path, lambda text: codex_config(text, codex_enabled)),
                         (claude_path, lambda text: claude_config(text, claude_enabled, user_id))]:
        path = Path(path)
        if path.is_symlink():
            raise ValueError("client configuration is a symlink; configure its owner instead")
        old = path.read_text() if path.exists() else ""
        new = render(old)
        if new != old:
            changes.append((path, old, new))
    return changes


def apply(changes):
    for path, old, new in changes:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path.exists():
            fd, backup = tempfile.mkstemp(prefix=path.name + ".ccdash-backup-", dir=path.parent)
            with os.fdopen(fd, "w") as file:
                file.write(old)
            print("Backup: " + backup)
        fd, temp = tempfile.mkstemp(prefix="." + path.name + ".ccdash-", dir=path.parent)
        try:
            with os.fdopen(fd, "w") as file:
                file.write(new)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temp, path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
        print("Configured: " + str(path))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--codex-config", required=True)
    parser.add_argument("--claude-config", required=True)
    parser.add_argument("--codex-enabled", choices=["true", "false"], default="true")
    parser.add_argument("--claude-enabled", choices=["true", "false"], default="true")
    parser.add_argument("--check", action="store_true", help="validate without writing files")
    args = parser.parse_args()
    try:
        changes = plan(args.codex_config, args.claude_config, args.codex_enabled == "true",
                       args.claude_enabled == "true", args.user_id)
        if args.check:
            print(json.dumps({"valid": True, "files_to_update": [str(path) for path, _, _ in changes]}))
        else:
            apply(changes)
        return 0
    except (OSError, ValueError) as error:
        # Parser exceptions and file contents can contain secrets. Only our
        # validation messages (not arbitrary OS exception text) leave the tool.
        print("telemetry setup: " + (str(error) if isinstance(error, ValueError) else "cannot update client configuration"), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
