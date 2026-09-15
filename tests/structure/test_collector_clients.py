"""Replay synthetic OTLP into an isolated Collector; never contact ClickHouse."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import urllib.request
import uuid

import yaml


ROOT = Path(__file__).resolve().parents[2]
IMAGE = "otel/opentelemetry-collector-contrib:0.119.0"
NOW = 1789380000123456789
CLAUDE_EVENTS = {"api_request", "tool_result", "user_prompt", "skill_activated", "claude_code.api_request"}


def docker(*arguments, check=True):
    return subprocess.run(["docker", *arguments], check=check, text=True, capture_output=True, timeout=45)


def attributes(values):
    return [{"key": key, "value": {"intValue" if isinstance(value, int) else "stringValue": str(value)}}
            for key, value in values.items()]


def values(items):
    return {item["key"]: next(iter(item["value"].values())) for item in items}


def log(event, stamp=0, **extra):
    return {"timeUnixNano": str(stamp), "observedTimeUnixNano": str(NOW),
            "body": {"stringValue": "private body"},
            "attributes": attributes({"event.name": event, **extra})}


def payload():
    # Mixed provenance in one resource batch exercises isolation between pipelines.
    records = [
        log("claude_code.api_request", NOW, model="claude-fixture", prompt="private prompt"),
        log("tool_result", NOW, tool_name="Read", success="true"),
        log("user_prompt", NOW, prompt="private prompt"),
        log("skill_activated", NOW, skill_name="fixture"),
        log("codex.sse_event", **{"event.kind": "response.completed", "conversation.id": "fixture-conversation"}),
        log("codex.sse_event", **{
            "event.kind": "response.completed", "conversation.id": "fixture-conversation",
            "event.timestamp": "2026-09-14T10:00:00.123456789Z",
            "input_token_count": "100", "output_token_count": "30", "cached_token_count": 40,
            "cache_write_token_count": 11, "reasoning_token_count": 10, "model": "openai.gpt-6-astra",
        }),
        log("codex.tool_result", NOW - 1, **{
            "call_id": "call_fixture", "tool_name": "exec_command", "duration_ms": 5,
            "success": "true", "tool_arguments": "private arguments", "arguments": "private arguments",
            "output": "private output", "output_snippet": "private snippet", "user_prompt": "private prompt",
            "prompt": "private prompt", "prompt_text": "private prompt", "tool_parameters": "private arguments",
        }),
        log("unrelated.event", NOW, model="openai.gpt-6-astra"),
        log("api_request", NOW, client="codex", model="openai.gpt-6-astra"),
    ]
    return {"resourceLogs": [{
        "resource": {"attributes": attributes({
            "service.name": "fixture", "user.email": "fixture@example.invalid", "team": "test",
            "backend": "bedrock-mantle", "experiment.group": "enterprise",
        })},
        "scopeLogs": [{"scope": {"name": "fixture"}, "logRecords": records}],
    }]}


class CollectorTests(unittest.TestCase):
    def run_collector(self, claude=None, codex=None, requests=None, configure=None):
        config = yaml.safe_load((ROOT / "collector-config.yaml").read_text())
        if configure:
            configure(config)
        identifier = "ccdash-collector-" + uuid.uuid4().hex[:12]
        env = {"EXPERIMENT_GROUP": "bedrock", "CH_HOST": "127.0.0.1", "CH_PORT": "9440",
               "CH_DB": "fixture", "CH_USER": "fixture", "CH_PASSWORD": "fixture",
               "OTELCOL_QUEUE_DIR": "/data/queue"}
        if claude is not None:
            env["CLAUDE_ENABLED"] = claude
        if codex is not None:
            env["CODEX_ENABLED"] = codex
        env_args = [value for key, val in env.items() for value in ["-e", key + "=" + val]]
        with tempfile.TemporaryDirectory(prefix="collector-clients-") as directory:
            base = Path(directory)
            original = base / "original.yaml"
            original.write_text(yaml.safe_dump(config))
            validated = docker("run", "--rm", "--network", "none", "--cap-drop", "ALL",
                               "--security-opt", "no-new-privileges", *env_args,
                               "-v", str(original) + ":/config.yaml:ro", IMAGE,
                               "validate", "--config=/config.yaml", check=False)
            self.assertEqual(validated.returncode, 0, validated.stderr)
            # Production listeners stay on loopback. Only this internal test network
            # receives container traffic. No port is published on the host.
            config["receivers"]["otlp"]["protocols"]["http"]["endpoint"] = "0.0.0.0:4318"
            config["exporters"] = {"file": {"path": "/data/events.json", "flush_interval": "100ms"}}
            config["processors"]["batch"]["timeout"] = "100ms"
            for pipeline in config["service"]["pipelines"].values():
                pipeline["exporters"] = ["file"]
            (base / "config.yaml").write_text(yaml.safe_dump(config))
            docker("network", "create", "--internal", identifier)
            try:
                docker("run", "-d", "--name", identifier, "--network", identifier, "--user", str(os.getuid()),
                       "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                       "--read-only", *env_args, "-v", str(base) + ":/data",
                       IMAGE, "--config=/data/config.yaml")
                details = json.loads(docker("inspect", identifier).stdout)[0]
                address = details["NetworkSettings"]["Networks"][identifier]["IPAddress"]
                self.assertTrue(address, docker("logs", identifier).stderr)
                url = "http://" + address + ":4318"
                for attempt in range(50):
                    try:
                        self.post(url + "/v1/logs", {"resourceLogs": []})
                        break
                    except OSError:
                        state = json.loads(docker("inspect", identifier).stdout)[0]["State"]
                        self.assertTrue(state["Running"], docker("logs", identifier).stderr)
                        if attempt == 49:
                            self.fail(docker("logs", identifier).stderr)
                        time.sleep(0.1)
                for path, body, headers in requests or [
                    ("/v1/logs", payload(), {}),
                    ("/v1/metrics", self.metrics(), {}),
                    ("/v1/traces", self.traces(), {}),
                ]:
                    self.post(url + path, body, headers)
                time.sleep(0.5)
                docker("stop", "--time", "3", identifier)
                output = base / "events.json"
                events = [json.loads(line) for line in output.read_text().splitlines()] if output.exists() else []
                return events
            finally:
                docker("rm", "-f", identifier, check=False)
                docker("network", "rm", identifier, check=False)

    def post(self, url, payload, headers=None):
        request = urllib.request.Request(url, json.dumps(payload).encode(),
                                         {"Content-Type": "application/json", **(headers or {})})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=3) as response:
            self.assertEqual(response.status, 200)

    def metrics(self):
        point = {"startTimeUnixNano": str(NOW - 100), "timeUnixNano": str(NOW), "asDouble": 7,
                 "attributes": attributes({"session.id": "claude-session", "type": "input"})}
        return {"resourceMetrics": [{"resource": {"attributes": attributes({"service.name": "claude-code"})},
                "scopeMetrics": [{"scope": {"name": "fixture"}, "metrics": [
                    {"name": name, "sum": {"aggregationTemporality": 2, "isMonotonic": True, "dataPoints": [point]}}
                    for name in ["claude_code.token.usage", "codex.token.usage", "unrelated.metric"]
                ]}]}]}

    def traces(self):
        return {"resourceSpans": [
            {"resource": {"attributes": attributes({"service.name": service})}, "scopeSpans": [{
                "scope": {"name": service}, "spans": [{
                    "traceId": "0102030405060708090a0b0c0d0e0f10", "spanId": "0102030405060708",
                    "name": service + ".request", "startTimeUnixNano": str(NOW - 100),
                    "endTimeUnixNano": str(NOW), "kind": 1,
                }],
            }]} for service in ["claude-code", "unrelated"]
        ]}

    def test_three_activation_modes_defaults_and_fail_closed_ingestion(self):
        for claude, codex, expected in [
            (None, None, CLAUDE_EVENTS),
            ("true", "true", CLAUDE_EVENTS | {"codex.sse_event", "codex.tool_result"}),
            ("false", "true", {"codex.sse_event", "codex.tool_result"}),
            ("false", "false", set()),
            ("0", "TRUE", {"codex.sse_event", "codex.tool_result"}),
            ("", "", CLAUDE_EVENTS),
        ]:
            with self.subTest(claude=claude, codex=codex):
                events = self.run_collector(claude, codex)
                logs = [(resource, record)
                        for batch in events for resource in batch.get("resourceLogs", [])
                        for scope in resource["scopeLogs"] for record in scope["logRecords"]]
                self.assertEqual({values(record["attributes"])["event.name"] for _, record in logs}, expected)
                codex_logs = [(resource, record) for resource, record in logs
                              if values(record["attributes"])["event.name"].startswith("codex.")]
                self.assertEqual(len(codex_logs), 3 if "codex.sse_event" in expected else 0)
                for resource, record in codex_logs:
                    attrs = values(record["attributes"])
                    res = values(resource["resource"]["attributes"])
                    self.assertEqual(attrs["client"], "codex")
                    self.assertNotIn("experiment.group", res)
                    self.assertNotIn("experiment.group", attrs)
                    self.assertEqual(res["backend"], "bedrock-mantle")
                    self.assertEqual(res["user.email"], "fixture@example.invalid")
                    self.assertNotIn("private", json.dumps(record))
                    self.assertEqual(int(record["timeUnixNano"]), NOW - 1 if attrs["event.name"] == "codex.tool_result" else NOW)
                    if "input_token_count" in attrs:
                        self.assertEqual(attrs["input_token_count"], "100")
                        self.assertEqual(int(attrs["cached_token_count"]), 40)
                        self.assertEqual(attrs["conversation.id"], "fixture-conversation")
                        self.assertEqual(attrs["event.timestamp"], "2026-09-14T10:00:00.123456789Z")
                    if attrs["event.name"] == "codex.tool_result":
                        self.assertEqual(attrs["call_id"], "call_fixture")
                        self.assertEqual(attrs["tool_name"], "exec_command")
                metrics = [metric for batch in events for res in batch.get("resourceMetrics", [])
                           for scope in res["scopeMetrics"] for metric in scope["metrics"]]
                self.assertEqual([metric["name"] for metric in metrics], ["claude_code.token.usage"] if "claude_code.api_request" in expected else [])
                if metrics:
                    self.assertEqual(metrics[0]["sum"]["aggregationTemporality"], 2)
                    self.assertEqual(metrics[0]["sum"]["dataPoints"][0]["asDouble"], 7)
                spans = [span for batch in events for res in batch.get("resourceSpans", [])
                         for scope in res["scopeSpans"] for span in scope["spans"]]
                self.assertEqual([span["name"] for span in spans], ["claude-code.request"] if "claude_code.api_request" in expected else [])
                for resource, record in logs:
                    if values(record["attributes"])["event.name"] in CLAUDE_EVENTS:
                        self.assertEqual(values(resource["resource"]["attributes"])["experiment.group"], "bedrock")
                        self.assertNotIn("prompt", values(record["attributes"]))


if __name__ == "__main__":
    unittest.main()
