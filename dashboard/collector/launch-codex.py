#!/usr/bin/env python3
"""Launch the existing Codex provider with loopback telemetry and backend provenance."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import urllib.parse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "vendor"))
spec = importlib.util.spec_from_file_location("client_config", HERE / "generated/configure-client-telemetry.py")
configurator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configurator)


def launch_command(config, arguments, environment, provenance_known=True):
    effective = copy.deepcopy(config)
    profile = config.get("profile")
    profile_selected = profile is not None
    overrides = []
    local = False
    index = 0
    while index < len(arguments):
        arg = arguments[index]
        if arg == "--":
            break
        if (arg.split("=", 1)[0] in ("--cd", "--cwd", "--worktree", "-C", "-w")
                or (arg.startswith(("-C", "-w")) and not arg.startswith("--"))):
            provenance_known = False
        if arg in ("--oss", "--local-provider") or arg.startswith("--local-provider="):
            local = True
        if arg in ("-p", "--profile", "-c", "--config"):
            index += 1
            if index == len(arguments):
                raise ValueError("missing profile/config argument")
            if arg in ("-p", "--profile"):
                profile = arguments[index]
                profile_selected = True
            else:
                overrides.append(arguments[index])
        elif arg.startswith("--profile="):
            profile = arg.split("=", 1)[1]
            profile_selected = True
        elif arg.startswith("--config="):
            overrides.append(arg.split("=", 1)[1])
        elif arg.startswith("-c") and not arg.startswith("--"):
            overrides.append(arg[2:])
        elif arg.startswith("-p") and not arg.startswith("--"):
            profile = arg[2:]
            profile_selected = True
        index += 1
    for override in overrides:
        key, separator, value = override.partition("=")
        if key.strip() == "profile" and separator:
            profile_selected = True
            try:
                profile = configurator.toml_load("value=" + value)["value"]
            except ValueError:
                profile = value
    if profile:
        effective.update(effective.get("profiles", {}).get(profile, {}))
    for override in overrides:
        key, separator, value = override.partition("=")
        key = key.strip()
        if key.startswith("otel.") or key == "otel":
            raise ValueError("telemetry overrides conflict with the local Collector; edit the managed setup instead")
        if key == "model_provider" or key.startswith("model_providers."):
            if not separator:
                raise ValueError("invalid provider override")
            try:
                parsed = configurator.toml_load("value=" + value)["value"]
            except ValueError:
                parsed = value
            owner = effective
            parts = key.split(".")
            for part in parts[:-1]:
                owner = owner.setdefault(part, {})
            owner[parts[-1]] = parsed
    provider = effective.get("model_provider", "openai")
    backend = None
    settings = effective.get("model_providers", {}).get(provider, {})
    if provider == "amazon-bedrock" and not settings.get("base_url"):
        backend = "bedrock-mantle"
    host = urllib.parse.urlsplit(settings.get("base_url", "")).hostname or ""
    if re.fullmatch(r"bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com", host):
        backend = "bedrock-runtime"
    elif re.fullmatch(r"bedrock-mantle\.[a-z0-9-]+\.api\.aws", host):
        backend = "bedrock-mantle"
    # Named profiles and directory/worktree switches use configuration that Codex
    # resolves independently. Preserve those selections without claiming a backend.
    if local or profile_selected or not provenance_known:
        backend = None
    command = ["codex", "-c", "otel.log_user_prompt=false"]
    for key, signal in (("exporter", "logs"), ("metrics_exporter", "metrics"), ("trace_exporter", "traces")):
        header = ',headers={"x-ccdash-backend"=' + json.dumps(backend) + '}' if backend else ""
        command.extend(["-c", 'otel.' + key + '={otlp-http={endpoint="http://127.0.0.1:4318/v1/'
                        + signal + '",protocol="json"' + header + '}}'])
    return command + arguments, dict(environment)


def project_provider_config(directory, user_config):
    """Conservatively avoid attribution when project trust/precedence is unknown."""
    for parent in (directory, *directory.parents):
        candidate = parent / ".codex/config.toml"
        if candidate == user_config or not candidate.exists():
            continue
        data = configurator.toml_load(candidate.read_text())
        if any(key in data for key in ("model_provider", "model_providers", "profile", "profiles")):
            return True
    return False


def main():
    try:
        config_path = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "config.toml"
        config = configurator.toml_load(config_path.read_text() if config_path.exists() else "")
        command, environment = launch_command(config, sys.argv[1:], os.environ,
                                              not project_provider_config(Path.cwd(), config_path))
        os.execvpe("codex", command, environment)
    except (OSError, ValueError, TypeError, KeyError):
        print("ccdash Codex launcher: cannot resolve provider/configuration; review config and install Codex", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
