"""Native policy fixture: CCDASH_TEST_COLLECTOR_BINARY=/path/to/otelcol-contrib."""
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BINARY = os.environ.get("CCDASH_TEST_COLLECTOR_BINARY")


def attributes(values):
    return [{"key": key, "value": {"stringValue": value}} for key, value in values.items()]


def values(items):
    return {item["key"]: next(iter(item["value"].values())) for item in items}


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@unittest.skipUnless(BINARY, "set CCDASH_TEST_COLLECTOR_BINARY for native policy fixture")
class Runtime(unittest.TestCase):
    @contextmanager
    def collector(self, central=False):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            token = directory / "token"
            token.write_text("fixture-token")
            token.chmod(0o600)
            if central:
                config = (ROOT / "generated/central.yaml").read_text()
                config = config.replace("/var/run/ccdash-ingest/token", str(token))
            else:
                spec = importlib.util.spec_from_file_location("installer", ROOT / "install.py")
                installer = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(installer)
                config = installer.render_config(directory, "https://dashboard.example/api/ingest", "fixture-user")
            output = directory / "output.json"
            prefix, rest = config.split("\nexporters:\n", 1)
            service = rest.split("\nservice:\n", 1)[1]
            config = prefix + '\nexporters:\n  file:\n    path: ' + str(output) + '\nservice:\n' + service
            for name in ("clickhouse/codex", "clickhouse", "otlp_http"):
                config = config.replace("exporters: [" + name + "]", "exporters: [file]")
            port, health, grpc = free_port(), free_port(), free_port()
            config = config.replace("0.0.0.0:4318", "127.0.0.1:" + str(port))
            config = config.replace("127.0.0.1:4318", "127.0.0.1:" + str(port))
            config = config.replace("127.0.0.1:4317", "127.0.0.1:" + str(grpc))
            config = config.replace("0.0.0.0:13133", "127.0.0.1:" + str(health))
            config = config.replace("127.0.0.1:13133", "127.0.0.1:" + str(health))
            config = config.replace("timeout: 5s", "timeout: 100ms")
            path = directory / "config.yaml"
            path.write_text(config)
            with (directory / "stderr").open("wb") as errors:
                process = subprocess.Popen([BINARY, "--config", str(path)], stdout=errors, stderr=errors)
                try:
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        if process.poll() is not None:
                            self.fail((directory / "stderr").read_text()[-6000:])
                        try:
                            urllib.request.urlopen("http://127.0.0.1:" + str(health), timeout=1).close()
                            break
                        except OSError:
                            time.sleep(0.05)
                    else:
                        self.fail("Collector did not start")
                    yield port, output
                finally:
                    process.terminate()
                    process.wait(timeout=15)

    def send(self, port, signal, payload, central=False):
        headers = {"Content-Type": "application/json"}
        if central:
            headers["Authorization"] = "Bearer fixture-token"
        else:
            headers["x-ccdash-backend"] = "bedrock-mantle"
        request = urllib.request.Request("http://127.0.0.1:" + str(port) + "/v1/" + signal,
                                         json.dumps(payload).encode(), headers)
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)

    def collect(self, output):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            rows = [json.loads(line) for line in output.read_text().splitlines()] if output.exists() else []
            total = sum(len(row.get(key, [])) for row in rows
                        for key in ("resourceLogs", "resourceMetrics", "resourceSpans"))
            if total >= 6:
                return rows
            time.sleep(0.1)
        self.fail("missing telemetry output: " + str(rows))

    def test_both_hops_preserve_usage_identity_and_scrub_content(self):
        logs, metrics, traces = [], [], []
        for client, service in (("claude", "claude-code"), ("codex", "codex")):
            resource = {"attributes": attributes({"service.name": service, "experiment.group": "A"})}
            log_attrs = {"event.name": "api_request" if client == "claude" else "codex.api_request",
                         "session.id": client + "-session", "prompt.id": "prompt-identity",
                         "input_tokens": "25", "model": "fixture-model", "prompt": "sensitive-prompt",
                         "tool_parameters": "sensitive-command", "new_context": "sensitive-context"}
            logs.append({"resource": resource, "scopeLogs": [{"logRecords": [{
                "timeUnixNano": "1792540800000000000", "body": {"stringValue": "sensitive-body"},
                "attributes": attributes(log_attrs)}]}]})
            metrics.append({"resource": resource, "scopeMetrics": [{"metrics": [{
                "name": "claude_code.token.usage" if client == "claude" else "codex.token.usage",
                "sum": {"aggregationTemporality": 2, "isMonotonic": True, "dataPoints": [{
                    "startTimeUnixNano": "1792540700000000000", "timeUnixNano": "1792540800000000000",
                    "asInt": "25", "attributes": attributes({"model": "fixture-model"})}]}}]}]})
            traces.append({"resource": resource, "scopeSpans": [{"spans": [{
                "traceId": "11" * 16, "spanId": ("22" if client == "claude" else "33") * 8,
                "name": "claude_code.llm_request" if client == "claude" else "codex.turn",
                "startTimeUnixNano": "1792540700000000000", "endTimeUnixNano": "1792540800000000000",
                "attributes": attributes({"session.id": client + "-session", "span.type": "llm_request",
                                          "model": "fixture-model", "ttft_ms": "10",
                                          "new_context": "sensitive-context", "tool_input": "sensitive-input"}),
                "status": {"message": "sensitive-error", "code": 2},
                "events": [{"timeUnixNano": "1792540750000000000", "name": "tool.output",
                            "attributes": attributes({"content": "sensitive-event"})}]}]}]})
        with self.collector() as (port, output):
            for signal, key, records in (("logs", "resourceLogs", logs), ("metrics", "resourceMetrics", metrics),
                                         ("traces", "resourceSpans", traces)):
                self.send(port, signal, {key: records})
            local = self.collect(output)
        with self.collector(central=True) as (port, output):
            for row in local:
                signal = next(signal for signal, key in (("logs", "resourceLogs"), ("metrics", "resourceMetrics"),
                                                        ("traces", "resourceSpans")) if key in row)
                self.send(port, signal, row, central=True)
            central = self.collect(output)
        for stage in (local, central):
            serialized = json.dumps(stage)
            self.assertNotIn("sensitive-", serialized)
            for row in stage:
                key = next(key for key in ("resourceLogs", "resourceMetrics", "resourceSpans") if key in row)
                for resource in row[key]:
                    attrs = values(resource["resource"]["attributes"])
                    self.assertEqual(attrs["user.email"], "fixture-user")
                    if attrs["service.name"] == "codex":
                        self.assertEqual(attrs["backend"], "bedrock-mantle")
                        self.assertEqual(attrs["client"], "codex")
                        self.assertNotIn("experiment.group", attrs)
                    else:
                        self.assertEqual(attrs["experiment.group"], "A")
                        if key == "resourceLogs":
                            record = resource["scopeLogs"][0]["logRecords"][0]
                            self.assertEqual(values(record["attributes"])["prompt.id"], "prompt-identity")
                        if key == "resourceSpans":
                            span = resource["scopeSpans"][0]["spans"][0]
                            self.assertEqual(values(span["attributes"])["ttft_ms"], "10")
                    if key == "resourceMetrics":
                        metric = resource["scopeMetrics"][0]["metrics"][0]["sum"]
                        self.assertEqual(metric["aggregationTemporality"], 2)
                        self.assertEqual(metric["dataPoints"][0]["asInt"], "25")
                        self.assertEqual(metric["dataPoints"][0]["startTimeUnixNano"], "1792540700000000000")


if __name__ == "__main__":
    unittest.main()
