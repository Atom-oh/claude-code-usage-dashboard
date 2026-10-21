#!/usr/bin/env python3
"""Check the pinned Collector against an isolated, pre-existing ClickHouse schema."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def command(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def attributes(data):
    return [{"key": key, "value": {"stringValue": value}} for key, value in data.items()]


def main():
    container = None
    collector = None
    with tempfile.TemporaryDirectory(prefix="ccdash-collector-sql-") as temporary:
        scratch = Path(temporary)
        try:
            binary = os.environ.get("CCDASH_TEST_COLLECTOR_BINARY")
            if not binary:
                spec = importlib.util.spec_from_file_location("installer", ROOT / "dashboard/collector/install.py")
                installer = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(installer)
                release = json.loads((ROOT / "dashboard/collector/release.json").read_text())
                installer.download_binary(scratch, release)
                binary = str(scratch / "otelcol-contrib")
            for fixture in ("test_runtime.py", "test_privacy.py"):
                subprocess.run(
                    [sys.executable, "-m", "unittest", "discover",
                     "-s", str(ROOT / "dashboard/collector/tests"), "-p", fixture, "-v"],
                    env=dict(os.environ, CCDASH_TEST_COLLECTOR_BINARY=binary), check=True)
            container = command("docker", "run", "--detach", "--rm",
                                "--publish", "127.0.0.1::8123", "--publish", "127.0.0.1::9000",
                                "--env", "CLICKHOUSE_SKIP_USER_SETUP=1", "--ulimit", "nofile=262144:262144",
                                "clickhouse/clickhouse-server:24.8")
            for attempt in range(60):
                ready = subprocess.run(["docker", "exec", container, "clickhouse-client", "--query", "SELECT 1"],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
                if ready:
                    break
                time.sleep(1)
            else:
                raise RuntimeError("isolated ClickHouse did not become ready")
            with (ROOT / "clickhouse-schema.sql").open() as source:
                subprocess.run(["docker", "exec", "-i", container, "clickhouse-client", "--multiquery"],
                               stdin=source, check=True)
            # Mirror the existing ingestion grants: never grant schema creation.
            command("docker", "exec", container, "clickhouse-client", "--multiquery", "--query",
                    "CREATE USER fixture_ingest IDENTIFIED WITH plaintext_password BY 'fixture-only';"
                    "GRANT INSERT ON claude_code.* TO fixture_ingest;"
                    "GRANT SELECT ON claude_code.otel_metrics_sum TO fixture_ingest")
            ports = json.loads(command("docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", container))
            sql_url = "http://127.0.0.1:" + ports["8123/tcp"][0]["HostPort"]

            def query(sql):
                request = urllib.request.Request(sql_url, (sql + " FORMAT JSONEachRow").encode())
                with urllib.request.urlopen(request, timeout=10) as response:
                    return [json.loads(line) for line in response.read().splitlines()]

            before = query("SELECT name, create_table_query FROM system.tables WHERE database='claude_code' ORDER BY name")
            token, password = scratch / "token", scratch / "password"
            token.write_text("fixture-internal-token")
            password.write_text("fixture-only")
            otlp_port, health_port = port(), port()
            config = (ROOT / "dashboard/collector/generated/central.yaml").read_text()
            config = config.replace("/var/run/ccdash-ingest/token", str(token))
            config = config.replace("/var/run/ccdash-clickhouse/CH_PASSWORD", str(password))
            config = config.replace("0.0.0.0:4318", "127.0.0.1:" + str(otlp_port))
            config = config.replace("0.0.0.0:13133", "127.0.0.1:" + str(health_port))
            config_path = scratch / "central.yaml"
            config_path.write_text(config)
            environment = dict(os.environ, CH_HOST="127.0.0.1", CH_PORT=ports["9000/tcp"][0]["HostPort"],
                               CH_DB="claude_code", CH_USER="fixture_ingest")
            with (scratch / "collector.log").open("w") as output:
                collector = subprocess.Popen([binary, "--config", str(config_path)], env=environment,
                                             stdout=output, stderr=output)
                for attempt in range(100):
                    if collector.poll() is not None:
                        raise RuntimeError((scratch / "collector.log").read_text()[-5000:])
                    try:
                        urllib.request.urlopen("http://127.0.0.1:" + str(health_port), timeout=1).close()
                        break
                    except OSError:
                        time.sleep(0.1)
                else:
                    raise RuntimeError("isolated Collector did not become ready")
                now = str(time.time_ns())
                logs, metrics, spans = [], [], []
                for client in ("claude", "codex"):
                    resource = {"attributes": attributes({"service.name": "claude-code" if client == "claude" else "codex",
                        "user.email": "fixture@example.invalid", "backend": "bedrock-mantle"})}
                    logs.append({"resource": resource, "scopeLogs": [{"logRecords": [{"timeUnixNano": now,
                        # The SQL contract always derives EventName from the
                        # attribute, regardless of the newer OTLP field.
                        "eventName": "conflicting-native-name",
                        "attributes": attributes({"event.name": "api_request" if client == "claude" else "codex.api_request",
                                                  "session.id": client, "input_tokens": "25"}),
                        "body": {"stringValue": "sensitive-fixture"}}]}]})
                    metrics.append({"resource": resource, "scopeMetrics": [{"metrics": [{
                        "name": "claude_code.token.usage" if client == "claude" else "codex.token.usage",
                        "sum": {"aggregationTemporality": 2, "isMonotonic": True, "dataPoints": [{
                            "startTimeUnixNano": now, "timeUnixNano": now, "asInt": "25",
                            "attributes": attributes({"session.id": client, "type": "input"})}]}}]}]})
                    if client == "claude":
                        # The existing materialized expression yields an empty
                        # string when event.name is absent.
                        logs[-1]["scopeLogs"][0]["logRecords"].append({
                            "timeUnixNano": now, "eventName": "untrusted-native-name",
                            "attributes": attributes({"session.id": client}),
                            "body": {"stringValue": "sensitive-fixture"}})
                    else:
                        point = {"startTimeUnixNano": now, "timeUnixNano": now,
                                 "attributes": attributes({"session.id": client})}
                        metrics[-1]["scopeMetrics"][0]["metrics"].extend([
                            {"name": "codex.queue.depth", "gauge": {
                                "dataPoints": [dict(point, asDouble=3.5)]}},
                            {"name": "codex.request.duration", "histogram": {
                                "aggregationTemporality": 2, "dataPoints": [
                                    dict(point, count="3", sum=7.5, min=1.0, max=4.0,
                                         bucketCounts=["1", "2"], explicitBounds=[2.0])]}},
                            {"name": "codex.request.size", "exponentialHistogram": {
                                "aggregationTemporality": 2, "dataPoints": [
                                    dict(point, count="3", sum=7.0, min=0.0, max=4.0,
                                         scale=0, zeroCount="1",
                                         positive={"offset": 1, "bucketCounts": ["2"]},
                                         negative={"offset": 0, "bucketCounts": []})]}}
                        ])
                    spans.append({"resource": resource, "scopeSpans": [{"spans": [{
                        "traceId": ("11" if client == "claude" else "22") * 16, "spanId": "33" * 8,
                        "name": "claude_code.llm_request" if client == "claude" else "codex.turn",
                        "startTimeUnixNano": now, "endTimeUnixNano": now,
                        "attributes": attributes({"session.id": client, "span.type": "llm_request"})}]}]})
                for signal, key, items in (("logs", "resourceLogs", logs), ("metrics", "resourceMetrics", metrics),
                                           ("traces", "resourceSpans", spans)):
                    request = urllib.request.Request("http://127.0.0.1:" + str(otlp_port) + "/v1/" + signal,
                        json.dumps({key: items}).encode(), {"Content-Type": "application/json",
                                                         "Authorization": "Bearer fixture-internal-token"})
                    with urllib.request.urlopen(request, timeout=10) as response:
                        assert response.status == 200
                expected = {"otel_logs": 3, "otel_traces": 2, "otel_metrics_sum": 1,
                            "codex_metrics_sum": 1, "codex_metrics_gauge": 1,
                            "codex_metrics_histogram": 1, "codex_metrics_exponential_histogram": 1}
                for attempt in range(60):
                    counts = {table: int(query("SELECT count() AS n FROM claude_code." + table)[0]["n"]) for table in expected}
                    if counts == expected:
                        break
                    time.sleep(0.5)
                else:
                    raise AssertionError(f"export counts {counts}; Collector output:\n" +
                                         (scratch / "collector.log").read_text()[-6000:])
                for table in ("otel_metrics_sum", "codex_metrics_sum"):
                    assert query("SELECT Value, AggregationTemporality FROM claude_code." + table) == [
                        {"Value": 25, "AggregationTemporality": 2}]
                assert query("SELECT Value FROM claude_code.codex_metrics_gauge") == [{"Value": 3.5}]
                assert query("SELECT Count, Sum, BucketCounts, ExplicitBounds, Min, Max, "
                             "AggregationTemporality FROM claude_code.codex_metrics_histogram") == [
                    {"Count": "3", "Sum": 7.5, "BucketCounts": ["1", "2"], "ExplicitBounds": [2],
                     "Min": 1, "Max": 4, "AggregationTemporality": 2}]
                assert query("SELECT Count, Sum, Scale, ZeroCount, PositiveOffset, PositiveBucketCounts, "
                             "NegativeOffset, NegativeBucketCounts, Min, Max, AggregationTemporality "
                             "FROM claude_code.codex_metrics_exponential_histogram") == [
                    {"Count": "3", "Sum": 7, "Scale": 0, "ZeroCount": "1", "PositiveOffset": 1,
                     "PositiveBucketCounts": ["2"], "NegativeOffset": 0, "NegativeBucketCounts": [],
                     "Min": 0, "Max": 4, "AggregationTemporality": 2}]
                assert all(row["Body"] == "" for row in query("SELECT Body FROM claude_code.otel_logs"))
                assert query("SELECT EventName FROM claude_code.otel_logs ORDER BY EventName") == [
                    {"EventName": ""}, {"EventName": "api_request"}, {"EventName": "codex.api_request"}]
                assert query("SELECT count() AS n FROM claude_code.otel_logs "
                             "WHERE EventName != LogAttributes['event.name']") == [{"n": "0"}]
                assert before == query("SELECT name, create_table_query FROM system.tables WHERE database='claude_code' ORDER BY name")
                print("Collector → existing ClickHouse schema: both clients, logs/metrics/traces, "
                      "all seven tables, cumulative counters and unchanged schema passed.")
        finally:
            try:
                if collector is not None:
                    collector.terminate()
                    try:
                        collector.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        collector.kill()
                        collector.wait(timeout=5)
            finally:
                if container is not None:
                    subprocess.run(["docker", "rm", "-f", container], check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
