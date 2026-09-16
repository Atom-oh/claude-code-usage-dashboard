import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { buildMetricQuery, buildTraceQuery, foldCodexMetrics, foldCodexTraces } from "./codexSignals.js";

// Opt in with CODEX_SIGNALS_SQL_TEST=1. No CH_URL/credentials are consumed:
// all DDL, synthetic inserts and production SELECTs run inside a networkless,
// disposable Docker container. CODEX_SIGNALS_SCHEMA can point at a pending local DDL.
test("Codex signal SQL against isolated ClickHouse", {
  skip: process.env.CODEX_SIGNALS_SQL_TEST !== "1", timeout: 120000,
}, async (t) => {
  const name = `ccdash-signals-sql-${process.pid}`;
  const directory = mkdtempSync(join(tmpdir(), "codex-signals-sql-"));
  function docker(args, input) {
    const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
    return result.stdout.trim();
  }
  function execute(sql, parameters = {}) {
    return docker(["exec", "-i", name, "clickhouse-client", "--multiquery",
      ...Object.entries(parameters).map(([key, value]) => `--param_${key}=${value}`)], sql);
  }
  const from = new Date("2026-09-15T00:00:00Z"), to = new Date("2026-09-15T01:00:00Z");
  const resource = { client: "codex", backend: "bedrock-mantle", "service.instance.id": "one", "user.email": "fixture@example.test" };
  const base = { ResourceAttributes: resource, ScopeName: "codex", ScopeVersion: "1",
    ScopeAttributes: { mode: "one" }, Attributes: { model: "fixture", tool: "shell" },
    StartTimeUnix: "2026-09-14 23:00:00.000000000", TimeUnix: "2026-09-15 00:01:00.000000000",
    MetricUnit: "1", AggregationTemporality: 1 };
  function insert(type, rows) {
    execute(`INSERT INTO claude_code.codex_metrics_${type} FORMAT JSONEachRow\n${rows.map((row) => JSON.stringify(row)).join("\n")}`);
  }
  function metric(type, filters = {}) {
    const request = buildMetricQuery(type, from, to, filters);
    const output = execute(`${request.sql} FORMAT JSONEachRow`, request.params);
    const rows = output ? output.split("\n").map((line) => JSON.parse(line)) : [];
    return { rows, ...foldCodexMetrics(rows, from, to) };
  }
  t.after(() => {
    try { docker(["rm", "-f", name]); } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  writeFileSync(join(directory, "test.xml"), `<clickhouse>
    <background_schedule_pool_size>16</background_schedule_pool_size>
    <background_buffer_flush_schedule_pool_size>4</background_buffer_flush_schedule_pool_size>
    <background_message_broker_schedule_pool_size>4</background_message_broker_schedule_pool_size>
    <background_distributed_schedule_pool_size>4</background_distributed_schedule_pool_size>
    <max_server_memory_usage>1500000000</max_server_memory_usage>
  </clickhouse>`);
  docker(["run", "-d", "--name", name, "--network", "none", "--memory", "2g", "--cpus", "2",
    "--tmpfs", "/var/lib/clickhouse:rw,size=1g", "--tmpfs", "/var/log/clickhouse-server:rw,size=128m",
    "-v", `${join(directory, "test.xml")}:/etc/clickhouse-server/config.d/test.xml:ro`,
    "clickhouse/clickhouse-server:24.8"]);
  let startupError;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { execute("SELECT 1"); startupError = null; break; }
    catch (error) { startupError = error; await setTimeout(250); }
  }
  if (startupError) throw startupError;
  const schema = readFileSync(process.env.CODEX_SIGNALS_SCHEMA || new URL("../../clickhouse-schema.sql", import.meta.url), "utf8");
  execute("CREATE DATABASE claude_code");
  for (const table of ["codex_metrics_sum", "codex_metrics_gauge", "codex_metrics_histogram",
    "codex_metrics_exponential_histogram", "otel_traces"]) {
    const ddl = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS claude_code\\.${table}\\s*\\([\\s\\S]*?;`))?.[0];
    assert(ddl, `missing local schema for ${table}`);
    execute(ddl);
  }

  await t.test("60000 advancing delta intervals deduplicate and aggregate before the guard", () => {
    // More than the old cap outside the window must not starve a short request.
    execute(`INSERT INTO claude_code.codex_metrics_sum
      (ResourceAttributes, MetricName, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic)
      SELECT map('client','codex'), concat('codex.old.', toString(number)),
        toDateTime64('2026-09-14 12:00:00',9), toDateTime64('2026-09-14 12:01:00',9), 9, 1, true
      FROM numbers(60000)`);
    const insertWindow = `INSERT INTO claude_code.codex_metrics_sum
      (ResourceAttributes, ScopeName, ScopeVersion, ScopeAttributes, Attributes,
       MetricName, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic)
      SELECT map('client','codex','backend','bedrock-mantle'), 'codex', '1', map('mode','one'),
        map('model','scale'), concat('codex.scale.', toString(number % 39)),
        addMicroseconds(toDateTime64('2026-09-15 00:00:00',9), number),
        addMicroseconds(toDateTime64('2026-09-15 00:00:00',9), number + 1), 1, 1, true
      FROM numbers(60000)`;
    execute(insertWindow);
    execute(insertWindow);
    const result = metric("sum");
    assert.equal(result.rows.length, 39);
    assert.equal(result.metrics.length, 39);
    assert.equal(result.metrics.reduce((sum, row) => sum + row.value, 0), 60000);
    assert.equal(result.metrics.reduce((sum, row) => sum + row.points, 0), 60000);
    assert.deepEqual(result.coverage, { status: "observed", records: 60000, last_seen: "2026-09-15T00:00:00.060Z" });
    assert(result.metrics.every((row) => !row.partial));
  });

  await t.test("delta identity, flags, negative monotonic values and bound selectors survive SQL", () => {
    const row = { ...base, MetricName: "codex.identity", Value: 2, IsMonotonic: true };
    insert("sum", [row, { ...row, ResourceAttributes: Object.fromEntries(Object.entries(resource).reverse()),
      Attributes: { tool: "shell", model: "fixture" } },
    { ...row, ScopeVersion: "2" }, { ...row, ScopeAttributes: { mode: "two" } },
    { ...row, ResourceAttributes: { ...resource, "service.instance.id": "two" } },
    { ...row, ResourceAttributes: { ...resource, backend: "bedrock-runtime" } },
    { ...row, MetricName: "codex.invalid", Value: -1 },
    { ...row, MetricName: "codex.invalid", TimeUnix: "2026-09-15 00:02:00", Value: 8 },
    { ...row, MetricName: "codex.flagged", Flags: 1 },
    { ...row, MetricName: "codex.nonmonotonic", Value: -4, IsMonotonic: false },
    { ...row, MetricName: "codex.nonfinite", Value: "nan" },
    { ...row, MetricName: "codex.end", TimeUnix: "2026-09-15 01:00:00" }]);
    const result = metric("sum", { user: "fixture@example.test", model: "fixture", backend: "bedrock-mantle" });
    assert.equal(result.rows.filter((r) => r.name === "codex.identity").length, 4);
    assert.equal(result.metrics.find((r) => r.name === "codex.identity").value, 8);
    for (const name of ["codex.invalid", "codex.flagged", "codex.nonfinite"]) {
      assert.equal(result.metrics.find((r) => r.name === name).partial, true);
      assert.equal(result.metrics.find((r) => r.name === name).value, null);
    }
    assert.equal(result.metrics.find((r) => r.name === "codex.nonmonotonic").value, -4);
    assert(!result.metrics.some((r) => r.name === "codex.end"));
    assert.equal(Number(result.rows.find((r) => r.name === "codex.invalid").invalid_samples), 1);
    assert.equal(metric("sum", { user: "' OR 1=1 --" }).coverage.status, "empty");
  });

  await t.test("only active cumulative series contribute their last prior baseline", () => {
    const row = { ...base, MetricName: "codex.counter", Value: 10, IsMonotonic: true, AggregationTemporality: 2 };
    insert("sum", [
      { ...row, TimeUnix: "2026-09-14 23:30:00", Value: 5 },
      { ...row, TimeUnix: "2026-09-14 23:59:00" }, { ...row, TimeUnix: "2026-09-14 23:59:00" },
      { ...row, Value: 13 }, { ...row, TimeUnix: "2026-09-15 00:02:00", Value: 18 },
      { ...row, StartTimeUnix: "2026-09-15 00:03:00", TimeUnix: "2026-09-15 00:04:00", Value: 2 },
      { ...row, MetricName: "codex.inactive", TimeUnix: "2026-09-14 23:59:00" },
      { ...row, MetricName: "codex.missing", ScopeVersion: "2", Value: 13 },
      { ...row, MetricName: "codex.missing", TimeUnix: "2026-09-14 23:59:00" },
      { ...row, MetricName: "codex.scope", ScopeAttributes: { mode: "two" }, Value: 13 },
      { ...row, MetricName: "codex.scope", TimeUnix: "2026-09-14 23:59:00" },
      { ...row, MetricName: "codex.stale", StartTimeUnix: "2026-09-10 00:00:00", Value: 13 },
      { ...row, MetricName: "codex.stale", StartTimeUnix: "2026-09-10 00:00:00", TimeUnix: "2026-09-11 23:59:00" },
      { ...row, MetricName: "codex.conflict", TimeUnix: "2026-09-14 23:59:00" },
      { ...row, MetricName: "codex.conflict", TimeUnix: "2026-09-14 23:59:00", Value: 11 },
      { ...row, MetricName: "codex.conflict", Value: 13 },
    ]);
    const result = metric("sum", { model: "fixture" });
    const counterRows = result.rows.filter((r) => r.name === "codex.counter");
    assert.equal(counterRows.length, 4);
    const counter = result.metrics.find((r) => r.name === "codex.counter");
    assert.equal(counter.value, 10);
    assert.equal(counter.points, 3);
    assert.equal(counter.partial, false);
    assert(!result.rows.some((r) => r.name === "codex.inactive"));
    for (const name of ["codex.missing", "codex.scope", "codex.stale", "codex.conflict"]) {
      assert.equal(result.metrics.find((r) => r.name === name).value, null);
      assert.equal(result.metrics.find((r) => r.name === name).partial, true);
    }
  });

  for (const type of ["histogram", "exponential_histogram"]) {
    await t.test(`${type} aggregates observations and exports without making quantiles`, () => {
      const row = { ...base, MetricName: `codex.${type}`, Count: 2, Sum: 100, Min: 10, Max: 90 };
      insert(type, [row, row, { ...row, TimeUnix: "2026-09-15 00:02:00", StartTimeUnix: "2026-09-15 00:01:00",
        Count: 1, Sum: 20, Min: 20, Max: 20 },
      { ...row, MetricName: `codex.${type}.cumulative`, AggregationTemporality: 2, TimeUnix: "2026-09-14 23:59:00" },
      { ...row, MetricName: `codex.${type}.cumulative`, AggregationTemporality: 2, Count: 3, Sum: 120 },
      { ...row, MetricName: `codex.${type}.invalid`, Flags: 1 },
      { ...row, MetricName: `codex.${type}.extremes`, Min: "nan" }]);
      const result = metric(type);
      const h = result.metrics.find((r) => r.name === row.MetricName);
      assert.equal(result.rows.filter((r) => r.name === row.MetricName).length, 1);
      for (const [key, value] of Object.entries({ count: 3, sum: 120, points: 2, mean: 40, min: 10, max: 90, p95_ms: undefined }))
        assert.equal(h[key], value, key);
      const cumulative = result.metrics.find((r) => r.name.endsWith(".cumulative"));
      assert.equal(cumulative.count, 1);
      assert.equal(cumulative.mean, 20);
      assert.equal(cumulative.min, null);
      assert.equal(result.metrics.find((r) => r.name.endsWith(".invalid")).partial, true);
      assert.equal(result.metrics.find((r) => r.name.endsWith(".extremes")).min, null);
      assert.equal(result.coverage.records, 5);
    });
  }

  await t.test("gauges keep sample means and latest values instead of summing observations", () => {
    const { AggregationTemporality, ...gauge } = base;
    const row = { ...gauge, MetricName: "codex.gauge", Value: 2 };
    insert("gauge", [row, row, { ...row, TimeUnix: "2026-09-15 00:02:00", Value: 8 },
      { ...row, TimeUnix: "2026-09-14 23:59:00", Value: 100 }]);
    const result = metric("gauge");
    assert.equal(result.rows.length, 2);
    assert.equal(result.metrics[0].value, 8);
    assert.equal(result.metrics[0].mean, 5);
    assert.equal(result.coverage.records, 2);
  });

  await t.test("real trace SELECT deduplicates retries and isolates conflicting traces", () => {
    const row = { Timestamp: "2026-09-15 00:01:00", TraceId: "trace", SpanId: "one", SpanName: "turn",
      Duration: 100000000, StatusCode: "Unset", ResourceAttributes: resource,
      SpanAttributes: { model: "fixture", "gen_ai.request.model": "other", tool_name: "exec_command",
        "codex.turn.reasoning_effort": "high", "codex.request.reasoning_effort": "low", turn_id: "turn-1",
        "code.file.path": "/private/work", "tool.arguments": "secret", "gen_ai.usage.input_tokens": "100" } };
    execute(`INSERT INTO claude_code.otel_traces FORMAT JSONEachRow\n${[row, row,
      { ...row, SpanId: "two", Duration: 200000000,
        SpanAttributes: { "gen_ai.request.model": "fixture", "codex.request.reasoning_effort": "xhigh", "turn.id": "turn-2" } },
      { ...row, SpanId: "excluded", ResourceAttributes: { client: "claude_code" } }]
      .map((r) => JSON.stringify(r)).join("\n")}`);
    const request = buildTraceQuery(from, to, { model: "fixture" });
    const read = () => execute(`${request.sql} FORMAT JSONEachRow`, request.params).split("\n").map((line) => JSON.parse(line));
    const result = foldCodexTraces(read());
    assert.equal(result.coverage.records, 2);
    assert.equal(result.spans[0].p95_ms, 200);
    const first = result.traces[0].spans.find((r) => r.span_id === "one");
    const second = result.traces[0].spans.find((r) => r.span_id === "two");
    assert.equal(first.model, "fixture");
    assert.equal(first.tool_name, "exec_command");
    assert.equal(first.effort, "high");
    assert.equal(first.turn_id, "turn-1");
    assert.equal(second.model, "fixture");
    assert.equal(second.effort, "xhigh");
    assert.equal(second.turn_id, "turn-2");
    assert.equal(second.tool_name, null);
    assert(!JSON.stringify(result).includes("/private/work"));
    assert.equal(first.attributes, undefined);
    assert.equal(first.input_tokens, undefined);
    execute(`INSERT INTO claude_code.otel_traces FORMAT JSONEachRow\n${JSON.stringify({ ...row, Duration: 300000000 })}`);
    const partial = foldCodexTraces(read());
    assert.deepEqual(partial.traces, [
      { trace_id: "trace", span_count: null, wall_ms: null, errors: null, spans: [], partial: true }]);
    assert.deepEqual(partial.spans, []);
    assert.deepEqual(partial.coverage, { status: "observed", records: 2,
      last_seen: "2026-09-15T00:01:00.000Z", partial: true, partial_traces: 1, conflicting_spans: 1 });
  });
  await t.test("recent trace selection precedes the span guard on large daily windows", () => {
    execute(`INSERT INTO claude_code.otel_traces
      (Timestamp, TraceId, SpanId, SpanName, Duration, ResourceAttributes, SpanAttributes)
      SELECT toDateTime64('2026-09-15 00:10:00',9)+toIntervalMicrosecond(number),
        concat('bulk-',toString(intDiv(number,100))),toString(number),'operation',1000000,
        map('client','codex','backend','bedrock-mantle'),map('model','fixture')
      FROM numbers(60000)`);
    const q = buildTraceQuery(from, to, { model: "fixture" });
    const rows = execute(`${q.sql} FORMAT JSONEachRow`, q.params).split("\n").map(JSON.parse);
    assert.equal(rows.length, 5000);
    const result = foldCodexTraces(rows);
    assert.equal(result.traces.length, 50);
    assert.equal(result.coverage.records, 5000);
    assert(result.traces.every((r) => Number(r.trace_id.slice(5)) >= 550));
  });
  await t.test("a long-running trace is bounded and cannot claim a complete duration or error total", () => {
    execute(`INSERT INTO claude_code.otel_traces
      (Timestamp, TraceId, SpanId, SpanName, Duration, ResourceAttributes, SpanAttributes)
      SELECT toDateTime64('2026-09-15 00:20:00',9)+toIntervalMicrosecond(number),
        'long-running',toString(number),'operation',1000000,
        map('client','codex','backend','bedrock-mantle'),map('model','fixture')
      FROM numbers(60000)`);
    const q = buildTraceQuery(from, to, { model: "fixture" });
    const rows = execute(`${q.sql} FORMAT JSONEachRow`, q.params).split("\n").map(JSON.parse);
    assert.equal(rows.length, 5100);
    const result = foldCodexTraces(rows);
    const trace = result.traces.find((r) => r.trace_id === "long-running");
    assert.equal(trace.span_count, 200);
    assert.equal(trace.truncated, true);
    assert.equal(trace.wall_ms, null);
    assert.equal(trace.errors, null);
    assert(trace.spans.every((s) => Number(s.span_id) >= 59800));
    assert.equal(result.coverage.truncated_traces, 1);
  });
  await t.test("a conflicting variant outside the preview cap still withholds the entire trace", () => {
    execute(`INSERT INTO claude_code.otel_traces
      (Timestamp, TraceId, SpanId, SpanName, Duration, ResourceAttributes, SpanAttributes)
      SELECT toDateTime64('2026-09-15 00:30:00',9)+toIntervalMicrosecond(number),
        'capped-conflict',if(number=0,'199',toString(number)),'operation',1000000,
        map('client','codex','backend','bedrock-mantle'),map('model','conflict-fixture')
      FROM numbers(201)`);
    const q = buildTraceQuery(from, to, { model: "conflict-fixture" });
    const rows = execute(`${q.sql} FORMAT JSONEachRow`, q.params).split("\n").map(JSON.parse);
    assert.equal(rows.length, 200);
    assert.equal(rows.filter((r) => r.span_id === "199").length, 1);
    const result = foldCodexTraces(rows);
    assert.deepEqual(result.spans, []);
    assert.equal(result.coverage.conflicting_spans, 1);
    assert.equal(result.coverage.partial_traces, 1);
    assert.deepEqual(result.traces, [
      { trace_id: "capped-conflict", span_count: null, wall_ms: null, errors: null, spans: [], partial: true }]);
  });
});
