"""Local ClickHouse + pinned Collector: schema guards and actual exporter writes."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import unittest
import uuid

import yaml

import test_collector_clients as clients
from test_collector_clients import IMAGE, ROOT, NOW, docker
from test_codex_signals import histogram_presence_metrics, metrics, traces


class CodexStorageTests(unittest.TestCase):
  post = clients.CollectorTests.post

  def test_migration_and_all_exporter_insert_shapes(self):
    identifier = "ccdash-storage-" + uuid.uuid4().hex[:12]
    collector = identifier + "-collector"
    migration = (ROOT / "clickhouse-migration-006.sql").read_text()
    digest = hashlib.sha256("".join(line for line in migration.splitlines(keepends=True)
                    if "INSERT INTO claude_code.schema_migrations" not in line).encode()).hexdigest()
    self.assertIn("'" + digest + "'", migration)
    local = (ROOT / "clickhouse-schema.sql").read_text().split("-- 006:")[1]
    replicated = (ROOT / "infra/files/clickhouse-schema-replicated.sql").read_text().split("-- 006:")[1]
    def localize(text):
      text = text[text.index("CREATE TABLE"):]
      text = re.sub(r" ON CLUSTER 'replicated'", "", text)
      text = re.sub(r"ReplicatedMergeTree\([^)]*\)", "MergeTree", text)
      text = re.sub(r" \+ INTERVAL 90 DAY TO VOLUME 'cold',\s*toDateTime\(TimeUnix\)", "", text)
      return text.replace("storage_policy = 'hot_cold', ", "")
    self.assertEqual(localize(migration), localize(local))
    self.assertEqual(localize(replicated), localize(local))
    with tempfile.TemporaryDirectory(prefix="codex-storage-") as directory:
      base = Path(directory)
      docker("network", "create", "--internal", identifier)
      try:
        docker("run", "-d", "--name", identifier, "--network", identifier,
             "--network-alias", "clickhouse", "-e", "CLICKHOUSE_SKIP_USER_SETUP=1",
             "--ulimit", "nofile=262144:262144", "clickhouse/clickhouse-server:24.8")

        def sql(query, check=True):
          result = subprocess.run(
            ["docker", "exec", "-i", identifier, "clickhouse-client", "--multiquery"],
            input=query, text=True, capture_output=True, timeout=45,
          )
          if check:
            self.assertEqual(result.returncode, 0, result.stderr)
          return result

        for attempt in range(100):
          if sql("SELECT 1", check=False).returncode == 0:
            break
          time.sleep(0.1)
        else:
          self.fail("local ClickHouse did not become ready")
        sql("""CREATE DATABASE claude_code;
                    CREATE TABLE claude_code.schema_migrations
                    (version UInt16, name String, applied_at DateTime DEFAULT now(), checksum String)
                    ENGINE=MergeTree ORDER BY version;
                    CREATE TABLE claude_code.existing_usage (value UInt64) ENGINE=MergeTree ORDER BY tuple();
                    INSERT INTO claude_code.existing_usage VALUES (17);""")
        dependency = migration[migration.index("SELECT throwIf"):migration.index("CREATE TABLE")]
        runnable = dependency + localize(local)
        self.assertNotEqual(sql(runnable, check=False).returncode, 0)
        self.assertEqual(sql("SELECT count() FROM system.tables WHERE database='claude_code' AND startsWith(name,'codex_metrics_')").stdout.strip(), "0")
        sql("INSERT INTO claude_code.schema_migrations (version,name,checksum) VALUES (4,'fixture','fixture')")
        sql(runnable)
        sql(runnable)
        self.assertEqual(sql("SELECT count() FROM claude_code.schema_migrations WHERE version=6").stdout.strip(), "1")
        self.assertEqual(sql("SELECT count() FROM claude_code.schema_migrations WHERE version=5").stdout.strip(), "0")
        self.assertEqual(sql("SELECT sum(value) FROM claude_code.existing_usage").stdout.strip(), "17")
        self.assertEqual(sql("SELECT count() FROM system.mutations WHERE database='claude_code'").stdout.strip(), "0")
        source = (ROOT / "clickhouse-schema.sql").read_text()
        trace_sql = source[source.index("CREATE TABLE IF NOT EXISTS claude_code.otel_traces"):]
        trace_sql = trace_sql[:trace_sql.index("TTL toDateTime(Timestamp) + INTERVAL 90 DAY;")
                    + len("TTL toDateTime(Timestamp) + INTERVAL 90 DAY;")]
        sql(trace_sql)

        config = yaml.safe_load((ROOT / "collector-config.yaml").read_text())
        config["receivers"]["otlp"]["protocols"]["http"]["endpoint"] = "0.0.0.0:4318"
        config["processors"]["batch"]["timeout"] = "100ms"
        config["service"]["pipelines"] = {key: value for key, value in config["service"]["pipelines"].items()
                         if key in ("metrics/codex", "traces/codex")}
        for exporter in config["exporters"].values():
          exporter.update(endpoint="tcp://clickhouse:9000", database="claude_code",
                  username="default", password="")
          exporter["sending_queue"] = {"enabled": False}
        (base / "collector.yaml").write_text(yaml.safe_dump(config))
        docker("run", "-d", "--name", collector, "--network", identifier, "--user", str(os.getuid()),
             "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
             "-e", "CLAUDE_ENABLED=false", "-e", "CODEX_ENABLED=true",
             "-e", "EXPERIMENT_GROUP=fixture", "-e", "OTELCOL_QUEUE_DIR=/data/queue",
             "-v", str(base) + ":/data", IMAGE, "--config=/data/collector.yaml")
        details = json.loads(docker("inspect", collector).stdout)[0]
        address = details["NetworkSettings"]["Networks"][identifier]["IPAddress"]
        url = "http://" + address + ":4318"
        for attempt in range(60):
          try:
            self.post(url + "/v1/metrics", {"resourceMetrics": []})
            break
          except OSError:
            time.sleep(0.1)
        else:
          self.fail(docker("logs", collector).stderr)
        self.post(url + "/v1/metrics", metrics(), {"x-ccdash-backend": "bedrock-runtime"})
        self.post(url + "/v1/traces", traces(), {"x-ccdash-backend": "bedrock-runtime"})
        kinds = ["sum", "gauge", "histogram", "exponential_histogram"]
        for attempt in range(60):
          counts = [int(sql("SELECT count() FROM claude_code.codex_metrics_" + kind).stdout) for kind in kinds]
          spans = int(sql("SELECT count() FROM claude_code.otel_traces").stdout)
          if counts == [1, 1, 1, 1] and spans == 2:
            break
          time.sleep(0.1)
        self.assertEqual(counts, [1, 1, 1, 1], docker("logs", collector).stderr)
        self.assertEqual(spans, 2, docker("logs", collector).stderr)
        for kind in kinds:
          row = json.loads(sql("SELECT *, toUnixTimestamp64Nano(StartTimeUnix) AS start_ns, "
                     "toUnixTimestamp64Nano(TimeUnix) AS time_ns FROM claude_code.codex_metrics_"
                     + kind + " FORMAT JSONEachRow").stdout)
          self.assertEqual(row["ResourceAttributes"]["backend"], "bedrock-runtime")
          self.assertEqual(row["ResourceAttributes"]["client"], "codex")
          self.assertEqual(row["ResourceAttributes"]["user.email"], "fixture@example.invalid")
          self.assertEqual(int(row["start_ns"]), NOW - 100)
          self.assertEqual(int(row["time_ns"]), NOW)
          self.assertEqual(row["Flags"], 1)
          self.assertNotIn("private", json.dumps(row))
          if kind != "gauge":
            self.assertEqual(row["AggregationTemporality"], 1)
          if kind in ("sum", "gauge"):
            self.assertEqual(row["Value"], 7 if kind == "sum" else 2)
          else:
            self.assertEqual(int(row["Count"]), 2)
            self.assertEqual(row["Sum"], 30)
            self.assertEqual(row["Min"], 10)
            self.assertEqual(row["Max"], 20)
          if kind == "histogram":
            self.assertEqual(list(map(int, row["BucketCounts"])), [1, 1])
            self.assertEqual(row["ExplicitBounds"], [15])
          if kind == "exponential_histogram":
            self.assertEqual(row["Scale"], 1)
            self.assertEqual(row["PositiveOffset"], 1)
            self.assertEqual(list(map(int, row["PositiveBucketCounts"])), [1, 1])
        stored = sql("SELECT * FROM claude_code.otel_traces FORMAT JSONEachRow").stdout
        self.assertNotIn("private", stored)
        self.assertIn('"ParentSpanId":"0102030405060708"', stored)

        self.post(url + "/v1/metrics", histogram_presence_metrics())
        for kind in ("histogram", "exponential_histogram"):
          query = ("SELECT Count, Sum, Min, Max FROM claude_code.codex_metrics_" + kind
               + " WHERE toUnixTimestamp64Nano(TimeUnix) >= " + str(NOW + 1000)
               + " ORDER BY TimeUnix FORMAT JSONEachRow")
          for attempt in range(60):
            rows = [json.loads(line) for line in sql(query).stdout.splitlines()]
            if len(rows) == 2:
              break
            time.sleep(0.1)
          self.assertEqual(len(rows), 2)
          self.assertEqual(rows[0], rows[1])
          self.assertEqual({key: rows[0][key] for key in ("Sum", "Min", "Max")},
                   {"Sum": 0, "Min": 0, "Max": 0})
          self.assertEqual(int(rows[0]["Count"]), 2)

        sql("CREATE DATABASE incomplete; CREATE TABLE incomplete.schema_migrations AS claude_code.schema_migrations;"
          "INSERT INTO incomplete.schema_migrations (version,name,checksum) VALUES (4,'fixture','fixture');"
          "CREATE TABLE incomplete.codex_metrics_sum (Value Float32) ENGINE=MergeTree ORDER BY tuple();")
        sql(runnable.replace("claude_code", "incomplete"))
        self.assertEqual(sql("SELECT count() FROM incomplete.schema_migrations WHERE version=6").stdout.strip(), "0")
      finally:
        docker("rm", "-f", collector, identifier, check=False)
        docker("network", "rm", identifier, check=False)


if __name__ == "__main__":
  unittest.main()
