import { test } from "node:test";
import assert from "node:assert/strict";
import { foldCodexMetrics, foldCodexTraces, buildMetricQuery, buildTraceQuery } from "./codexSignals.js";

const fields = (actual, expected) => {
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, key);
};
const from = new Date("2026-09-15T00:00:00Z");
const to = new Date("2026-09-15T01:00:00Z");
const point = {
  name: "codex.tool.call", type: "sum", unit: "", timestamp: "2026-09-15T00:01:00Z",
  start: "2026-09-14T23:00:00Z", value: 3, temporality: 1, monotonic: true,
  resource: { client: "codex", backend: "bedrock-mantle", "service.instance.id": "one" },
  attributes: { tool: "shell", success: "true" }, scope: "codex", flags: 0,
};
test("delta exports deduplicate retries and remain separate from billing usage", () => {
  const out = foldCodexMetrics([point, point, { ...point, timestamp: "2026-09-15T00:02:00Z", value: 2 }], from, to);
  fields(out.metrics[0], { value: 5, points: 2 });
  assert.equal(out.coverage.status, "observed");
  assert.equal(out.cost_usd, undefined);
});
test("cumulative counters use baseline differences and distinguish process starts", () => {
  const cumulative = { ...point, temporality: 2 };
  const out = foldCodexMetrics([
    { ...cumulative, timestamp: "2026-09-14T23:59:00Z", value: 10 },
    { ...cumulative, value: 13 },
    { ...cumulative, timestamp: "2026-09-15T00:03:00Z", value: 18 },
    { ...cumulative, start: "2026-09-15T00:04:00Z", timestamp: "2026-09-15T00:05:00Z", value: 2 },
  ], from, to);
  fields(out.metrics[0], { value: 10, partial: false });
});
test("missing cumulative baseline and invalid samples withhold the affected aggregate", () => {
  for (const row of [{ ...point, temporality: 2 }, { ...point, value: null }, { ...point, flags: 1 }]) {
    const out = foldCodexMetrics([row], from, to);
    fields(out.metrics[0], { value: null, partial: true });
  }
});
test("histograms merge counts and sums, not means or cumulative observations", () => {
  const h = { ...point, name: "codex.tool.call.duration_ms", type: "histogram",
    count: 2, sum: 100, min: 10, max: 90, unit: "ms" };
  const out = foldCodexMetrics([h, { ...h, timestamp: "2026-09-15T00:02:00Z", count: 1, sum: 20, min: 20, max: 20 }], from, to);
  fields(out.metrics[0], { count: 3, sum: 120, mean: 40, min: 10, max: 90, p95: undefined });
  const c = foldCodexMetrics([
    { ...h, temporality: 2, timestamp: "2026-09-14T23:59:00Z" },
    { ...h, temporality: 2, count: 3, sum: 120 },
  ], from, to).metrics[0];
  fields(c, { count: 1, mean: 20, min: null, max: null });
});

test("exporter-ambiguous zero histogram fields keep counts but withhold unknown statistics", () => {
  const h = { ...point, type: "histogram", count: 2, sum: 0, min: 0, max: 0 };
  const out = foldCodexMetrics([h], from, to).metrics[0];
  fields(out, { count: 2, sum: null, mean: null, min: null, partial: true });
  const combined = foldCodexMetrics([{ ...h, count: 5, sum: 100, sum_ambiguous: 1 }], from, to).metrics[0];
  fields(combined, { count: 5, mean: null });
  const zeroIncrement = foldCodexMetrics([
    { ...h, temporality: 2, timestamp: "2026-09-14T23:59:00Z", sum: 100 },
    { ...h, temporality: 2, count: 3, sum: 100 },
  ], from, to).metrics[0];
  fields(zeroIncrement, { count: 1, mean: 0 });
});
test("gauge observations are not added as usage, and metric labels retain scope", () => {
  const g = { ...point, type: "gauge", name: "codex.queue", value: 2 };
  const out = foldCodexMetrics([g, { ...g, value: 8, timestamp: "2026-09-15T00:02:00Z" },
    { ...point, resource: { ...point.resource, backend: "bedrock-runtime" } }], from, to);
  const gauge = out.metrics.find((r) => r.type === "gauge");
  fields(gauge, { value: 8, mean: 5 });
  assert.equal(out.metrics.length, 2);
  assert.equal(out.metrics.find((r) => r.type === "sum").dimensions.backend, "bedrock-runtime");
});
test("unknown temporality and monotonic regression are partial, not zero", () => {
  assert.equal(foldCodexMetrics([{ ...point, temporality: 0 }], from, to).metrics[0].value, null);
  const out = foldCodexMetrics([
    { ...point, temporality: 2, timestamp: "2026-09-14T23:59:00Z", value: 20 },
    { ...point, temporality: 2, value: 5 },
  ], from, to);
  assert.equal(out.metrics[0].partial, true);
});
test("negative monotonic deltas and invalid cumulative baselines withhold totals", () => {
  for (const rows of [
    [{ ...point, value: -1 }],
    [{ ...point, temporality: 2, value: -2, timestamp: "2026-09-14T23:59:00Z" },
      { ...point, temporality: 2, value: 3 }],
  ]) {
    const result = foldCodexMetrics(rows, from, to).metrics[0];
    fields(result, { partial: true, value: null });
  }
  assert.equal(foldCodexMetrics([{ ...point, monotonic: false, value: -1 }], from, to).metrics[0].value, -1);
});
test("scope version, scope attributes and temporality cannot supply another counter's baseline", () => {
  const baseline = { ...point, temporality: 2, value: 10, timestamp: "2026-09-14T23:59:00Z",
    scope_version: "1", scope_attributes: { mode: "one" } };
  for (const change of [{ scope_version: "2" }, { scope_attributes: { mode: "two" } }]) {
    const result = foldCodexMetrics([baseline, { ...baseline, ...change, timestamp: point.timestamp, value: 13 }], from, to);
    fields(result.metrics[0], { partial: true, value: null });
  }
  const result = foldCodexMetrics([{ ...baseline, temporality: 1 },
    { ...baseline, timestamp: point.timestamp, value: 13 }], from, to);
  assert.equal(result.metrics[0].partial, true);
});
test("preaggregated deltas carry export counts, last time and invalid samples", () => {
  const summary = { ...point, value: 180000, points: "60000", invalid_samples: "0" };
  const result = foldCodexMetrics([summary, { ...point, timestamp: "2026-09-15T00:03:00Z", value: 2 }], from, to);
  fields(result.metrics[0], { value: 180002, points: 60001 });
  assert.deepEqual(result.coverage, { status: "observed", records: 60001, last_seen: "2026-09-15T00:03:00.000Z" });
  const invalid = foldCodexMetrics([{ ...summary, invalid_samples: "1" }], from, to);
  fields(invalid.metrics[0], { value: null, partial: true });
  assert.equal(invalid.coverage.records, 60000);
});
test("preaggregated histogram means are observation weighted and missing extremes stay null", () => {
  const h = { ...point, type: "histogram", points: "100", count: "200", sum: 1000, min: 1, max: 9 };
  const result = foldCodexMetrics([h, { ...h, timestamp: "2026-09-15T00:02:00Z",
    points: "1", count: "1", sum: 5, min: null, max: null, extremes_missing: "1" }], from, to);
  fields(result.metrics[0], { points: 101, count: 201, mean: 5, min: null, max: null, p95_ms: undefined });
});
test("conflicting cumulative samples cannot be used as an arbitrary baseline", () => {
  const baseline = { ...point, temporality: 2, timestamp: "2026-09-14T23:59:00Z", value: 10 };
  for (const rows of [[baseline, { ...baseline, value: 11 }], [{ ...baseline, value: 11 }, baseline]]) {
    const result = foldCodexMetrics([...rows, { ...point, temporality: 2, value: 13 }], from, to);
    fields(result.metrics[0], { partial: true, value: null });
  }
});
test("metrics use half-open export-time ranges, with baseline-only input remaining empty", () => {
  const out = foldCodexMetrics([{ ...point, timestamp: from.toISOString(), value: 2 },
    { ...point, timestamp: to.toISOString(), value: 9 }], from, to);
  assert.equal(out.metrics[0].value, 2);
  assert.equal(foldCodexMetrics([{ ...point, timestamp: "2026-09-14T23:59:00Z" }], from, to).coverage.status, "empty");
});
const span = {
  trace_id: "a".repeat(32), span_id: "b".repeat(16), parent_span_id: "",
  timestamp: "2026-09-15T00:01:00Z", name: "session_task.turn",
  duration_ns: 100_000_000, status: "Unset", attributes: { model: "test" },
};
test("trace windows retain the parent relationship and never sum overlapping span time", () => {
  const child = { ...span, span_id: "c".repeat(16), parent_span_id: span.span_id,
    name: "exec_command", timestamp: "2026-09-15T00:01:00.020Z", duration_ns: 50_000_000, status: "Error" };
  const out = foldCodexTraces([span, span, child]);
  fields(out.traces[0], { wall_ms: 100, span_count: 2, errors: 1 });
  assert.equal(out.traces[0].spans[1].parent_span_id, span.span_id);
  assert.equal(out.spans.find((r) => r.name === "exec_command").p95_ms, 50);
  assert.equal(out.coverage.records, 2);
  assert.equal(out.traces[0].spans[0].attributes, undefined);
});
test("invalid span duration stays unavailable and empty signals stay empty", () => {
  const out = foldCodexTraces([{ ...span, duration_ns: -1 }]);
  assert.equal(out.traces[0].wall_ms, null);
  assert.equal(out.spans[0].average_ms, null);
  assert.equal(foldCodexTraces([]).coverage.status, "empty");
});

test("known RPC span names survive while dynamic paths stay private", () => {
  for (const [name, expected] of [["thread/start", "thread/start"], ["thread/unsubscribe", "thread/unsubscribe"],
    ["/home/private/project", "unknown"], ["https://example.test/path", "unknown"]]) {
    assert.equal(foldCodexTraces([{ ...span, name }]).spans[0].name, expected);
  }
});
test("trace p95 uses empirical nearest rank, consistent with log latencies", () => {
  const result = foldCodexTraces([span, { ...span, span_id: "c".repeat(16), duration_ns: 200_000_000 }]);
  fields(result.spans[0], { average_ms: 150, p95_ms: 200 });
});
test("conflicts withhold only their entire trace regardless of input order", () => {
  for (const change of [{ duration_ns: 200_000_000 }, { name: "other" }, { parent_span_id: "parent" },
    { timestamp: "2026-09-15T00:02:00Z" }, { status: "Error" }, { model: "gpt-5.4" },
    { tool_name: "exec_command" }, { effort: "high" }, { turn_id: "turn-1" }]) {
    const conflict = { ...span, ...change };
    for (const rows of [[span, conflict], [conflict, span]]) {
      const out = foldCodexTraces([...rows, span, { ...span, span_id: "child" },
        { ...span, trace_id: "healthy", duration_ns: 50_000_000 }]);
      assert.deepEqual(out.traces.find((r) => r.trace_id === span.trace_id),
        { trace_id: span.trace_id, span_count: null, wall_ms: null, errors: null, spans: [], partial: true });
      assert.equal(out.traces.find((r) => r.trace_id === "healthy").wall_ms, 50);
      assert.deepEqual(out.spans, [{ name: span.name, count: 1, errors: 0, average_ms: 50, p95_ms: 50 }]);
      assert.deepEqual(out.coverage, { status: "observed", records: 3,
        last_seen: new Date(change.timestamp || span.timestamp).toISOString(),
        partial: true, partial_traces: 1, conflicting_spans: 1 });
    }
  }
  const out = foldCodexTraces([span, { ...span, status: "Error" }]);
  assert.deepEqual(out.spans, []);
  assert.equal(out.coverage.status, "observed");
});
test("spans expose only bounded structured identifiers alongside timing", () => {
  const fields = { model: "gpt-5.4", tool_name: "functions.exec_command", effort: "xhigh",
    turn_id: "019945ad-1668-7093-b78d-662d7a8df91b" };
  const result = foldCodexTraces([{ ...span, ...fields, attributes: {
    "code.file.path": "/private/work", input_tokens: 100, "tool.arguments": "secret",
  } }]);
  const output = result.traces[0].spans[0];
  for (const [key, value] of Object.entries(fields)) assert.equal(output[key], value);
  assert.equal(result.spans[0].model, undefined);
  for (const key of ["attributes", "input_tokens", "cost_usd"]) assert.equal(output[key], undefined);
  for (const value of ["/private/work", "C:\\private\\file", "<script>", "has spaces", "x".repeat(129), "", null]) {
    const invalid = foldCodexTraces([{ ...span, name: value, model: value, tool_name: value, effort: value, turn_id: value }]);
    for (const key of Object.keys(fields)) assert.equal(invalid.traces[0].spans[0][key], null);
    assert.equal(invalid.spans[0].name, "unknown");
    assert.equal(invalid.traces[0].spans[0].name, "unknown");
  }
});
test("queries bind selectors, scope Codex, retain a counter baseline and reject arbitrary tables", () => {
  const filters = { user: "' OR 1=1", model: "gpt", backend: "bedrock-mantle" };
  const q = buildMetricQuery("sum", from, to, filters);
  assert(!q.sql.includes(filters.user));
  assert.equal(q.params.signalUser, filters.user);
  assert(q.sql.includes("INTERVAL 3 DAY"));
  assert(q.sql.includes("LIMIT 50001"));
  assert(q.sql.includes("codex_metrics_sum"));
  assert.throws(() => buildMetricQuery("sum;DROP", from, to, filters));
  const t = buildTraceQuery(from, to, filters);
  assert(t.sql.includes("ResourceAttributes['client'] = 'codex'"));
  assert(t.sql.includes("SpanAttributes['model']"));
  assert(!t.sql.includes(filters.user));
});
