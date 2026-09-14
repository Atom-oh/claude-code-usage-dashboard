#!/usr/bin/env python3
"""Launch Codex with process-scoped Bedrock and structured-log telemetry settings."""

import json
import os
from pathlib import Path
import re
import sys


CONFIG_KEYS = {
    "CLAUDE_ENABLED", "CODEX_ENABLED", "CODEX_BEDROCK_ENDPOINT",
    "CODEX_BEDROCK_REGION", "CODEX_MODEL", "CODEX_VERSION",
    "CODEX_OTEL_RESOURCE_ATTRIBUTES",
}
RUNTIME_REGIONS = {
    "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1",
    "eu-central-1", "eu-north-1", "eu-west-1", "eu-west-2", "eu-west-3",
    "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-south-1",
    "ap-southeast-1", "ap-southeast-2", "sa-east-1",
}


def load_environment(environ):
    """Read optional nonsecret KEY=value defaults without shell evaluation."""
    path = Path(environ.get("CCDASH_CLIENT_ENV", "/etc/ccdash/clients.env"))
    defaults = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            key, separator, value = line.partition("=")
            if not separator or key not in CONFIG_KEYS or key in defaults:
                raise ValueError("invalid or duplicate key in client environment file")
            defaults[key] = value
    return {**defaults, **environ}


def settings(env):
    enabled = []
    for name, default, client in [
        ("CLAUDE_ENABLED", "true", "claude"),
        ("CODEX_ENABLED", "false", "codex"),
    ]:
        value = (env.get(name) or default).lower()
        if value not in ("true", "false", "1", "0"):
            raise ValueError(name + " must be true or false")
        if value in ("true", "1"):
            enabled.append(client)
    if not enabled:
        raise ValueError("at least one of CLAUDE_ENABLED and CODEX_ENABLED must be true")
    endpoint = env.get("CODEX_BEDROCK_ENDPOINT") or "mantle"
    if endpoint not in ("mantle", "runtime"):
        raise ValueError("CODEX_BEDROCK_ENDPOINT must be mantle or runtime")
    region = env.get("CODEX_BEDROCK_REGION", "us-west-2")
    model = env.get("CODEX_MODEL", "openai.gpt-6-astra" if endpoint == "mantle" else "us.openai.gpt-6-astra")
    version = env.get("CODEX_VERSION", "0.154.0")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("CODEX_VERSION must be an explicit release version")
    if endpoint == "mantle":
        if region != "us-west-2":
            raise ValueError("this Mantle integration requires CODEX_BEDROCK_REGION=us-west-2")
        if not re.fullmatch(r"openai\.[a-z0-9][a-z0-9.-]*", model):
            raise ValueError("Mantle CODEX_MODEL must be an unprefixed openai model ID")
        base_url = "https://bedrock-mantle.us-west-2.api.aws/openai/v1"
    else:
        if region not in RUNTIME_REGIONS:
            raise ValueError("unsupported CODEX_BEDROCK_REGION for this Runtime integration")
        if not re.fullmatch(r"(us|global)\.openai\.[a-z0-9][a-z0-9.-]*", model):
            raise ValueError("Runtime CODEX_MODEL requires a us. or global. openai inference profile")
        if model.startswith("us.") and not region.startswith("us-"):
            raise ValueError("a us. inference profile requires a US source region")
        base_url = "https://bedrock-runtime." + region + ".amazonaws.com/openai/v1"
    return {
        "enabledClients": enabled, "endpoint": endpoint, "region": region,
        "model": model, "base_url": base_url, "version": version,
    }


def resource_attributes(value):
    """Keep valid OTel values (including spaces, equals and percent escapes)."""
    attributes = {}
    if not value:
        return attributes
    for item in value.split(","):
        key, separator, content = item.partition("=")
        key, content = key.strip(), content.strip()
        if (not separator or not re.fullmatch(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+", key)
                or any(ord(char) < 32 or ord(char) == 127 for char in item)):
            raise ValueError("invalid OTEL_RESOURCE_ATTRIBUTES entry")
        attributes[key] = content
    return attributes


def validate_arguments(arguments, endpoint):
    """Keep provider and telemetry identity in sync with the selected deployment."""
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--":
            break
        if endpoint == "runtime" and argument.split("=")[0] == "--search":
            raise ValueError("Runtime does not support hosted web search; --search is unavailable")
        if (argument.split("=")[0] in ("--model", "--profile", "--oss", "--local-provider")
                or (argument.startswith(("-m", "-p")) and not argument.startswith("--"))):
            raise ValueError("select the model/provider with CODEX_MODEL and CODEX_BEDROCK_ENDPOINT")
        override = None
        if argument in ("-c", "--config"):
            index += 1
            if index == len(arguments):
                raise ValueError("missing value for --config")
            override = arguments[index]
        elif argument.startswith("--config="):
            override = argument[len("--config="):]
        elif argument.startswith("-c") and not argument.startswith("--"):
            override = argument[2:]
        if override is not None:
            key = override.partition("=")[0].strip()
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", key):
                raise ValueError("use unquoted dotted keys for additional --config overrides")
            root = key.split(".")[0]
            if endpoint == "runtime" and root == "web_search":
                raise ValueError("Runtime web_search is managed as disabled")
            if root in ("otel", "model", "model_provider", "model_providers", "profile", "profiles"):
                raise ValueError("provider and telemetry overrides are managed by the Codex launcher")
        index += 1


def launch_command(env, arguments):
    config = settings(env)
    if "codex" not in config["enabledClients"]:
        raise ValueError("Codex is disabled; set CODEX_ENABLED=true consistently across deployment and collector")
    validate_arguments(arguments, config["endpoint"])
    if config["endpoint"] == "runtime" and not env.get("AWS_BEARER_TOKEN_BEDROCK", "").strip():
        raise ValueError("Runtime requires AWS_BEARER_TOKEN_BEDROCK supplied externally")
    child = dict(env)
    attributes = resource_attributes(env.get("CODEX_OTEL_RESOURCE_ATTRIBUTES", ""))
    attributes.update(resource_attributes(env.get("OTEL_RESOURCE_ATTRIBUTES", "")))
    attributes.pop("experiment.group", None)
    attributes["backend"] = "bedrock-" + config["endpoint"]
    child["OTEL_RESOURCE_ATTRIBUTES"] = ",".join(key + "=" + value for key, value in attributes.items())
    child["AWS_REGION"] = config["region"]
    child["AWS_DEFAULT_REGION"] = config["region"]
    overrides = [
        "model=" + json.dumps(config["model"]),
        'otel.metrics_exporter="none"',
        'otel.trace_exporter="none"',
        'otel.log_user_prompt=false',
        'otel.exporter={otlp-http={endpoint="http://127.0.0.1:4318/v1/logs",protocol="json"}}',
    ]
    if config["endpoint"] == "mantle":
        overrides += [
            'model_provider="amazon-bedrock"',
            "model_providers.amazon-bedrock.aws.region=" + json.dumps(config["region"]),
        ]
    else:
        overrides += [
            # Runtime supports client-side functions, not hosted web search.
            # Override inherited user/project defaults before Codex builds tools.
            'web_search="disabled"',
            'model_provider="ccdash-bedrock-runtime"',
            'model_providers.ccdash-bedrock-runtime={name="Bedrock Runtime",base_url='
            + json.dumps(config["base_url"])
            + ',wire_api="responses",env_key="AWS_BEARER_TOKEN_BEDROCK",requires_openai_auth=false}',
        ]
    command = ["codex"]
    for value in overrides:
        command.extend(["-c", value])
    return command + list(arguments), child


def main():
    try:
        env = load_environment(os.environ)
        if sys.argv[1:] == ["--check"]:
            config = settings(env)
            resource_attributes(env.get("CODEX_OTEL_RESOURCE_ATTRIBUTES", ""))
            resource_attributes(env.get("OTEL_RESOURCE_ATTRIBUTES", ""))
            print(json.dumps(config))
            return 0
        command, child = launch_command(env, sys.argv[1:])
        os.execvpe(command[0], command, child)
    except (ValueError, OSError) as error:
        print("codex-launch: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
