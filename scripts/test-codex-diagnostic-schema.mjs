#!/usr/bin/env node
// Invoked only by the owned, network-isolated schema lifecycle fixture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { diagnosticSchemaSql, diagnosticBackfillSql } from "../dashboard/server/codexDiagnosticSchema.js";
import { buildCodexLogAggregateQuery, foldCodexLogAggregates } from "../dashboard/server/codexLogAggregates.js";

const container = process.argv[2];
if (!/^ccdash-schema-lifecycle-[a-f0-9]+$/.test(container || ""))
  throw new Error("Only the owned schema lifecycle fixture is accepted");
function execute(sql, params = {}) {
  return execFileSync("docker", ["exec", "-i",
    "-e", "CLICKHOUSE_PASSWORD=YOUR_SYNTHETIC_SCHEMA_FIXTURE_PASSWORD",
    container, "clickhouse-client", "--user", "otel_writer", "--multiquery",
    "--max_threads=1", "--max_execution_time=30", "--max_memory_usage=800000000",
    ...Object.entries(params).map(([key, value]) => `--param_${key}=${value}`)],
  { input: sql, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 45000 });
}
const rows = (sql, params = {}) => execute(`${sql} FORMAT JSONEachRow`, params)
  .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
execute(`CREATE DATABASE claude_code;
CREATE TABLE claude_code.otel_logs (
  Timestamp DateTime64(9), ResourceAttributes Map(LowCardinality(String),String),
  LogAttributes Map(LowCardinality(String),String),
  EventName String DEFAULT LogAttributes['event.name'],
  UserEmail String MATERIALIZED ResourceAttributes['user.email'],
  EndUserId String MATERIALIZED ResourceAttributes['enduser.id']
) ENGINE=MergeTree ORDER BY (EventName,Timestamp);`);

const model = "openai.gpt-6.1-sol", otherModel = "openai.gpt-6-astra";
const user = "synthetic@example.test";
let next = 1;
function event(name, attributes = {}, resource = {}, timestamp) {
  return { Timestamp: timestamp || `2026-10-21 12:00:20.${String(next++).padStart(9, "0")}`,
    ResourceAttributes: { "user.email": user, backend: "bedrock-mantle", "project.name": "project-a", ...resource },
    LogAttributes: { "event.name": `codex.${name}`, "conversation.id": "session-a", model, ...attributes } };
}
function insert(values) {
  execute("INSERT INTO claude_code.otel_logs (Timestamp,ResourceAttributes,LogAttributes,EventName) FORMAT JSONEachRow\n"
    + values.map(value => JSON.stringify({ ...value, EventName: value.EventName ?? value.LogAttributes["event.name"] ?? "" })).join("\n"));
}
const token = { input_token_count: "100", cached_token_count: "30", cache_write_token_count: "10",
  output_token_count: "40", reasoning_token_count: "10" };
const historical = [
  event("sse_event", { ...token, "event.kind": "response.completed", duration_ms: "12.5" }),
  event("sse_event", { "event.kind": "response.failed", error: "failure", duration_ms: "21" }),
  event("websocket_event", { "event.kind": "response.completed", duration_ms: "4.25" }),
  event("websocket_event", { "event.kind": "response.output_text.delta", duration_ms: "7" }),
  event("websocket_request", { duration_ms: "0" }),
  event("startup_phase", { "startup.phase": "bootstrap", duration_ms: "3" }),
  event("startup_phase", { "startup.phase": "/private/value", duration_ms: "4" }),
  event("conversation_starts", { reasoning_effort: "high", duration_ms: "11" }),
  event("user_prompt", { prompt_length: "20" }),
  event("future_event", { duration_ms: "5", arbitrary: "kept-in-identity" }),
  event("api_request", { attempt: "0", "http.response.status_code": "200", duration_ms: "9" }),
  event("api_request", { attempt: "1", "http.response.status_code": " 503 ", duration_ms: "11" }),
  event("api_error", { attempt: "2", "http.response.status_code": "429", duration_ms: "13" }),
  event("api_error", { attempt: "2", "http.response.status_code": "429", tool_token_count: "", duration_ms: "14" }),
  event("api_request", { attempt: "0", success: "false", error: "", duration_ms: "15" }),
  event("api_request", { attempt: "0", success: "true", error: "message one", duration_ms: "15" }),
  event("api_request", { attempt: "0", success: "true", "error.message": "message two", duration_ms: "15" }),
  event("api_request", { attempt: "0", success: "true", error: "", "error.message": "", duration_ms: "15" }),
  event("api_request", { attempt: "bad", "http.response.status_code": "?", duration_ms: "15" }),
  event("api_request", { attempt: "1.5", "http.response.status_code": "0x1f4", duration_ms: "0b11" }),
  event("api_request", { attempt: "0", "http.response.status_code": "599", duration_ms: "0o17" }),
  event("api_request", { attempt: "0", "http.response.status_code": "600", duration_ms: "1e2" }),
  event("api_request", { attempt: "0", "http.response.status_code": "0", duration_ms: "9007199254740992" }),
  event("turn_ttft", { duration_ms: "2.5" }),
  event("tool_result", { tool_name: "shell", success: "true", duration_ms: "3.75" }),
  event("tool_result", { tool_name: "shell", success: "false", duration_ms: "7" }),
  event("tool_result", { tool_name: "apply_patch", duration_ms: "11" }),
  event("tool_result", { tool_name: "unsafe/도구", success: "true", duration_ms: "0" }),
];
for (const duration_ms of ["", " ", "bad", "-1", "NaN", "Infinity", "0", "4.25", "0x10", "0b101", "0o17"])
  historical.push(event("sse_event", { "event.kind": "response.output_text.delta", duration_ms }),
    event("tool_result", { tool_name: "duration-check", success: "true", duration_ms }));
historical.push(event("sse_event", { "event.kind": "response.output_text.delta" }),
  event("tool_result", { tool_name: "duration-check", success: "true" }));
for (const decision of ["approved", "approved_for_session", "approved_with_amendment",
  "approved_mcp_policy_amendment", "approved_with_network_policy_allow", "denied",
  "denied_with_network_policy_deny", "unknown", "", "unsafe/value"])
  historical.push(event("tool_decision", { tool_name: "shell", decision, source: "agent" }));

// Exact identities retain unknown attributes and resources, while map insertion
// order alone is not a new identity.
const duplicate = event("tool_result", { tool_name: "same", success: "true", duration_ms: "3.5", extra: "first" });
historical.push(duplicate, duplicate, {
  ...duplicate,
  ResourceAttributes: Object.fromEntries(Object.entries(duplicate.ResourceAttributes).reverse()),
  LogAttributes: Object.fromEntries(Object.entries(duplicate.LogAttributes).reverse()),
}, { ...duplicate, LogAttributes: { ...duplicate.LogAttributes, extra: "second" } },
{ ...duplicate, ResourceAttributes: { ...duplicate.ResourceAttributes, extra: "third" } });

// Model-less events are attributed through an eligible event in the same
// conversation, user and project, even if its backend differs from the filter.
historical.push(
  event("api_request", { "conversation.id": "scope", model, attempt: "0", success: "true" }),
  event("tool_result", { "conversation.id": "scope", model: "", tool_name: "scoped", success: "true", duration_ms: "5" }),
  event("tool_result", { "conversation.id": "scope", model: "", tool_name: "other-project", success: "true" },
    { "project.name": "project-b" }),
  event("tool_result", { "conversation.id": "scope", model: "", tool_name: "other-user", success: "true" },
    { "user.email": "other@example.test" }),
  event("sse_event", { "conversation.id": "cross-backend", model, "event.kind": "response.output_text.delta", duration_ms: "2" }),
  event("tool_result", { "conversation.id": "cross-backend", model: "", tool_name: "cross-backend", success: "true" },
    { backend: "bedrock-runtime" }),
  event("conversation_starts", { "conversation.id": "setup-only", model }),
  event("tool_result", { "conversation.id": "setup-only", model: "", tool_name: "no-scope", success: "true" }),
  event("api_request", { model: otherModel, attempt: "0", success: "true" },
    { "user.email": "other@example.test" }),
  event("tool_result", { "conversation.id": "", model: "", tool_name: "anonymous", success: "false" },
    { "user.email": "", backend: "" }),
  event("tool_result", { tool_name: "fallback", success: "true", duration_ms: "8" },
    { "user.email": "", "enduser.id": "fallback@example.test" }),
  event("tool_result", { model: "us." + model, tool_name: "routing", success: "true", duration_ms: "8" },
    { backend: "" }),
);
// Both the promoted event header and the attribute prefix gate log selection.
historical.push(
  { ...event("tool_result", { tool_name: "excluded-header", success: "true" }), EventName: "other.event" },
  { ...event("tool_result", { "event.name": "", tool_name: "excluded-attribute", success: "true" }), EventName: "codex.tool_result" },
  { ...event("tool_result", { "event.name": "other.event", tool_name: "excluded-prefix", success: "true" }), EventName: "codex.tool_result" },
  { ...event("tool_result", { tool_name: "different-header", success: "true" }), EventName: "codex.future_event" },
);
for (const timestamp of ["2026-10-21 12:00:14.999999999", "2026-10-21 12:00:15.000000000",
  "2026-10-21 12:00:15.000000001", "2026-10-21 12:00:44.999999999",
  "2026-10-21 12:00:45.000000000", "2026-10-21 12:00:45.000000001"])
  historical.push(event("turn_ttft", { duration_ms: "6" }, {}, timestamp));
insert(historical);
// Maps also permit duplicate keys; JSON compaction must preserve first lookup.
execute(`INSERT INTO claude_code.otel_logs (Timestamp,ResourceAttributes,LogAttributes)
  SELECT toDateTime64('2026-10-21 12:00:21.000000001',9),
    map('user.email','${user}','backend','bedrock-mantle','project.name','project-a'),
    map('event.name','codex.tool_result','conversation.id','duplicate-keys','model','${model}',
      'tool_name','first','tool_name','second','duration_ms','5','duration_ms','9','success','false')`);
const sqlMap = entries => `map(${entries.flat().map(value => "'" + value.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'").join(",")})`;
const duplicatedResources = [
  ["user.email", user], ["enduser.id", "fallback@example.test"], ["backend", "bedrock-mantle"],
  ["project.name", "project-a"], ...Array.from({ length: 25 }, (_, i) => ["user.email", `duplicate-${i}@example.test`]),
  ["enduser.id", "other@example.test"], ["backend", "bedrock-runtime"], ["project.name", "project-b"],
];
const duplicatedAttributes = [
  ["event.name", "codex.tool_result"], ["conversation.id", "scope"], ["model", model],
  ["tool_name", "duplicate-dimensions"], ["success", "true"], ["duration_ms", "2"],
  ...Array.from({ length: 25 }, (_, i) => ["model", i % 2 ? model : otherModel]),
  ["conversation.id", "other-scope"], ["event.name", "codex.api_request"], ["attempt", "1"],
];
for (const [index, reorder] of [
  entries => entries, entries => [...entries].reverse(), entries => [...entries.slice(5), ...entries.slice(0, 5)],
].entries()) {
  execute(`INSERT INTO claude_code.otel_logs (Timestamp,ResourceAttributes,LogAttributes,EventName)
    SELECT toDateTime64('2026-10-21 12:00:22.00000000${index}',9),
      ${sqlMap(reorder(duplicatedResources))},${sqlMap(reorder(duplicatedAttributes))},'codex.tool_result'`);
}
// A deliberately uneven distribution detects unweighted quantiles: 90% of the
// identities share the low-duration bucket, including repeated export delivery.
const weighted = `INSERT INTO claude_code.otel_logs (Timestamp,ResourceAttributes,LogAttributes)
  SELECT toDateTime64('2026-10-21 12:00:30',9) + toIntervalNanosecond(number),
    map('user.email','weighted@example.test','backend','bedrock-mantle'),
    map('event.name','codex.sse_event','event.kind','response.output_text.delta',
      'conversation.id','weighted','model','${model}',
      'duration_ms',if(number < 90,'1','100')) FROM numbers(100)`;
execute(weighted);
execute(weighted);

execute(diagnosticSchemaSql());
execute("ALTER TABLE claude_code.codex_diagnostic_events_v1 REMOVE TTL");
const from = new Date("2026-10-21T12:00:00Z"), to = new Date("2026-10-21T12:01:00Z");
const backfillParams = { backfillFrom: "2026-10-21 00:00:00", backfillTo: "2026-10-22 00:00:00" };
const filters = [{}, { user: "SYNTHETIC" }, { user: "other@example.test" }, { user: "fallback@" },
  { user: "weighted@" },
  { user: "no-such-user" }, { model }, { model: otherModel }, { model: "no-such-model" },
  { backend: "bedrock-mantle" }, { backend: "bedrock-runtime" }, { backend: "unknown" },
  { user, model, backend: "bedrock-mantle" }, { model, backend: "bedrock-runtime" }];
const select = (profile, source, filter = {}, start = from, end = to) => {
  const request = buildCodexLogAggregateQuery(start, end, filter, undefined,
    { profile, diagnosticSource: source });
  if (source === "states" && profile)
    assert.match(request.sql, /FROM claude_code\.codex_diagnostic_events_v1 FINAL/);
  return rows(request.sql, request.params);
};
// Ignore order of aggregate rows and rounding at the last binary float digit.
// Integer counts, percentile positions and timestamp strings remain exact.
function stable(value) {
  if (Array.isArray(value)) {
    const result = value.map(stable);
    return result.every(item => item && typeof item === "object")
      ? result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : result;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  if (typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value))
    return Number(value.toPrecision(14));
  return value;
}
function displayed(value, profile) {
  const summaryKeys = profile === "tools" ? ["tool_success_rate", "approval_rate"] : ["retry_rate", "api_error_rate"];
  return { events: value.events, coverage: value.coverage,
    summary: Object.fromEntries(summaryKeys.map(key => [key, value.summary[key]])),
    ...(profile === "tools" ? { tools: value.tools, approvals: value.approvals } : { latency: value.latency }) };
}
let assertions = 0;
function parity(filter = {}, start = from, end = to, baseline = true) {
  const full = baseline ? foldCodexLogAggregates(select(undefined, "raw", filter, start, end)) : null;
  for (const profile of ["tools", "performance"]) {
    const rawRows = select(profile, "raw", filter, start, end);
    const stateRows = select(profile, "states", filter, start, end);
    const label = JSON.stringify({ profile, filter, start, end });
    assert.deepEqual(stable(stateRows), stable(rawRows), "Raw/state SQL parity " + label);
    const raw = foldCodexLogAggregates(rawRows), state = foldCodexLogAggregates(stateRows);
    assert.deepEqual(stable(state), stable(raw), "Raw/state fold parity " + label);
    assertions += 2;
    if (full) {
      assert.deepEqual(stable(displayed(raw, profile)), stable(displayed(full, profile)),
        "Displayed profile/default parity " + label);
      assertions++;
    }
  }
}
assert.equal(select("tools", "states").length, 0, "Schema creation must not pretend to backfill history");
execute(diagnosticBackfillSql(), backfillParams);
const weightedLatency = foldCodexLogAggregates(select("performance", "states", { user: "weighted@" })).latency[0];
assert.deepEqual(weightedLatency, { name: "sse_event", count: 100, average_ms: 10.9,
  p50_ms: 1, p95_ms: 100, max_ms: 100 });
assertions++;
for (const filter of filters) parity(filter);
console.log(JSON.stringify({ phase: "historical", status: "passed", assertions }));

// Stop background merges so repeated backfills genuinely exercise FINAL across
// multiple parts before testing the same source after a complete merge.
execute("SYSTEM STOP MERGES claude_code.codex_diagnostic_events_v1");
insert([duplicate, event("tool_result", { tool_name: "live", success: "true", duration_ms: "17.5" }),
  event("sse_event", { "event.kind": "response.output_text.delta", duration_ms: "3" })]);
execute(diagnosticBackfillSql(), backfillParams);
execute(diagnosticBackfillSql(), backfillParams);
execute(diagnosticBackfillSql(), { backfillFrom: "2026-10-21 12:00:15", backfillTo: "2026-10-21 12:00:45" });
const parts = rows(`SELECT count() AS n FROM system.parts
  WHERE active AND database='claude_code' AND table='codex_diagnostic_events_v1'`)[0];
assert.ok(Number(parts.n) > 1, "Repeated/backfill overlap must leave multiple unmerged parts");
for (const filter of filters) parity(filter);
for (const [start, end] of [[15, 45], [14, 45], [15, 46], [21, 22], [46, 59]]) {
  for (const filter of [{}, { model }])
    parity(filter, new Date(`2026-10-21T12:00:${start}Z`), new Date(`2026-10-21T12:00:${end}Z`), false);
}
parity({}, new Date("2026-10-21T12:00:15.999Z"), new Date("2026-10-21T12:00:45.999Z"), false);
console.log(JSON.stringify({ phase: "overlap-and-boundaries", status: "passed", assertions }));
execute("SYSTEM START MERGES claude_code.codex_diagnostic_events_v1; OPTIMIZE TABLE claude_code.codex_diagnostic_events_v1 FINAL");
parity();
parity({ model, backend: "bedrock-runtime" });
console.log(JSON.stringify({ status: "passed", assertions, historical_rows: historical.length + 204 }));
