#!/usr/bin/env node
// Invoked by the isolated Python fixture runner. Never connects to a remote DB.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildCodexQuery, codexPrices, foldClientMetrics } from "../dashboard/server/clientMetrics.js";
import { costSchemaSql, costBackfillSql } from "../dashboard/server/codexCostSchema.js";
import { compareCodexCost } from "../dashboard/server/compareCodexCost.js";

const container = process.argv[2];
if (!/^ccdash-schema-lifecycle-[a-f0-9]+$/.test(container || ""))
  throw new Error("Only the owned schema lifecycle fixture is accepted");
function execute(sql, params = {}, extra = []) {
  return execFileSync("docker", ["exec", "-i",
    "-e", "CLICKHOUSE_PASSWORD=YOUR_SYNTHETIC_SCHEMA_FIXTURE_PASSWORD",
    container, "clickhouse-client", "--user", "otel_writer", "--multiquery",
    "--max_threads=1", "--max_execution_time=30", "--max_memory_usage=800000000",
    ...Object.entries(params).map(([key, value]) => `--param_${key}=${value}`), ...extra],
  { input: sql, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 45000 });
}
const rows = (sql, params = {}, extra = []) => execute(`${sql} FORMAT JSONEachRow`, params, extra)
  .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
execute(`CREATE DATABASE claude_code;
CREATE TABLE claude_code.otel_logs (
  Timestamp DateTime64(9), ResourceAttributes Map(String,String), LogAttributes Map(String,String),
  EventName String MATERIALIZED LogAttributes['event.name'],
  UserEmail String MATERIALIZED ResourceAttributes['user.email'],
  EndUserId String MATERIALIZED ResourceAttributes['enduser.id']
) ENGINE=MergeTree ORDER BY (EventName,Timestamp);`);
const token = { input_token_count: "100", cached_token_count: "30", cache_write_token_count: "10",
  output_token_count: "40", reasoning_token_count: "10" };
const model = "openai.gpt-6.1-sol";
function event(attrs = {}, resource = {}, time = "2026-10-21 12:00:20.000000001") {
  return { Timestamp: time,
    ResourceAttributes: { "user.email": "synthetic@example.test", "backend": "bedrock-mantle", ...resource },
    LogAttributes: { "event.name": "codex.sse_event", "event.kind": "response.completed",
      "conversation.id": "session-a", model, ...attrs } };
}
function insert(values) {
  execute("INSERT INTO claude_code.otel_logs (Timestamp, ResourceAttributes, LogAttributes) FORMAT JSONEachRow\n"
    + values.map(value => JSON.stringify(value)).join("\n"));
}
const historical = [
  event(token), event(token), // repeated delivery
  event({ ...token, input_token_count: "272001" }),
  event({ ...token, input_token_count: "272000" }),
  event({ ...token, model: "us." + model }, { backend: "bedrock-runtime" }),
  event({ ...token, model: "global." + model }),
  event({ ...token, model: "unknown-model" }),
  event({}), // generic completion is not usage
  event({ input_token_count: "100", output_token_count: "20" }), // partial
  event({ ...token, cached_token_count: "99" }), // invalid cache subsets
  event({ ...token, reasoning_token_count: "41" }), // invalid reasoning subset
  event(Object.fromEntries(Object.keys(token).map(key => [key, "0"]))),
  ...["", "bad", "-1", "1.5", "NaN", "Infinity", "9007199254740992"].map(value =>
    event({ ...token, input_token_count: value })),
  event({ ...token, input_token_count: "9007199254740991", output_token_count: "1" }),
  event({ "event.kind": "response.output_text.delta", input_token_count: "99999999" }),
  event({ "event.kind": "response.output_text.delta", "conversation.id": "scope-only" }),
  event({ "event.kind": "response.in_progress", model: "", "conversation.id": "scope-only" }),
  event({ "event.name": "codex.api_error", "http.response.status_code": " 429 ",
    "conversation.id": "rejected-only" }),
  event({ "event.name": "codex.api_error", "http.response.status_code": "429",
    tool_token_count: "0", "conversation.id": "rejected-needs-usage" }),
  event({ "event.name": "codex.api_request", "http.response.status_code": "200" }),
  event({ "event.name": "codex.tool_result" }),
  event({ "event.name": "codex.tool_decision" }),
  event({ "event.name": "codex.turn_ttft" }),
  event({ "event.name": "codex.future_event", "conversation.id": "scope-only" }),
  event({ "event.name": "codex.user_prompt", "conversation.id": "setup-only" }),
  event({ "event.name": "codex.user_prompt", input_token_count: "", "conversation.id": "setup-usage" }),
  event({ ...token, "conversation.id": "" }, { "user.email": "" }),
  event({ ...token, "conversation.id": "fallback-user" }, { "user.email": "", "enduser.id": "fallback@example.test" }),
  event({ ...token, "conversation.id": "other-user" }, { "user.email": "other@example.test", "project.name": "p2" }),
  event({ "event.name": "codex.api_error", model: "", "conversation.id": "boundary",
    "http.response.status_code": "429" }, {}, "2026-10-21 12:00:30"),
  event({ "event.kind": "response.output_text.delta", "conversation.id": "boundary" },
    {}, "2026-10-21 12:00:14.999999999"),
  event({ "event.kind": "response.output_text.delta", "conversation.id": "boundary" },
    {}, "2026-10-21 12:00:45"),
  event({ "event.kind": "response.output_text.delta", "conversation.id": "" },
    { "user.email": "" }, "2026-10-21 12:00:31"),
  event({ "event.name": "unrelated.event", ...token }),
];
// Identity is canonical across map ordering, but unknown extra attributes remain
// part of it: dropping them would incorrectly merge distinct completion records.
historical.push({ ...historical[0],
  ResourceAttributes: Object.fromEntries(Object.entries(historical[0].ResourceAttributes).reverse()),
  LogAttributes: Object.fromEntries(Object.entries(historical[0].LogAttributes).reverse()) });
historical.push(event({ ...token, diagnostic_extra: "distinct" }));
const tool = event({ "event.name": "codex.tool_result", tool_name: 'shell "quoted"\\path\n한국어',
  success: "false", error: "synthetic failure", duration_ms: "12.5" });
historical.push(tool, tool, event({ ...tool.LogAttributes, diagnostic_extra: "distinct" }));
for (const duration_ms of ["0", "4.25", "", "bad", "-1", "NaN", "Infinity"])
  historical.push(event({ "event.name": "codex.api_request", duration_ms,
    "http.response.status_code": " 503 ", "conversation.id": "request-durations" }));
historical.push(
  event({ "event.name": "codex.turn_ttft", duration_ms: "7.5" }),
  event({ "event.name": "codex.tool_decision", tool_name: "apply_patch", success: "false" }),
  // Full views split non-usage operations by input context too.
  event({ "event.name": "codex.api_request", input_token_count: "272001", duration_ms: "10" }),
  event({ "event.name": "codex.api_request", input_token_count: "272000", duration_ms: "11" }),
  event({ "event.kind": "response.failed", error: "synthetic stream failure", duration_ms: "20" }),
);
insert(historical);
// Map permits duplicate keys. JSON identity decoding must retain their lookup
// semantics instead of collapsing the map through a JavaScript object.
execute(`INSERT INTO claude_code.otel_logs (Timestamp,ResourceAttributes,LogAttributes)
  SELECT toDateTime64('2026-10-21 12:00:21.000000001',9),
    map('user.email','synthetic@example.test','backend','bedrock-mantle'),
    map('event.name','codex.tool_result','conversation.id','duplicate-map-keys',
      'model','${model}','tool_name','first','tool_name','second',
      'duration_ms','5','duration_ms','9','success','false')`);
execute(costSchemaSql());
// Fixed historical fixtures must not disappear as wall-clock time advances.
// The independent schema lifecycle suite verifies the declared retention.
execute(`ALTER TABLE claude_code.codex_cost_events_v1 REMOVE TTL;
ALTER TABLE claude_code.codex_cost_scope_v1 REMOVE TTL;`);

const from = new Date("2026-10-01T00:00:00Z"), to = new Date("2026-10-26T00:00:00Z");
const backfillParams = { backfillFrom: "2026-10-21 00:00:00", backfillTo: "2026-10-22 00:00:00" };
const filters = [{}, { user: "SYNTHETIC" }, { userExact: "synthetic@example.test" },
  { userExact: "fallback@example.test" }, { userExact: "none" }, { model },
  { modelExact: model }, { modelExact: "unknown-model" }, { backend: "bedrock-mantle" },
  { backend: "bedrock-runtime" }, { backend: "unknown" },
  { userExact: "synthetic@example.test", modelExact: model, backend: "bedrock-mantle" }];
function request(source, filter = {}, start = from, end = to, seconds = 3600, costView = true) {
  return buildCodexQuery(start, end, filter, codexPrices, "codex", seconds,
    { costView, costSource: source });
}
function query(request, extra = []) { return rows(request.sql, request.params, extra); }
const stable = value => Array.isArray(value) ? value.map(stable).sort((a, b) => {
  const left = JSON.stringify(a), right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
}) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
let assertions = 0;
function equal(filter = {}, start = from, end = to, seconds = 3600) {
  for (const costView of [true, false]) {
    const rawRequest = request("raw", filter, start, end, seconds, costView);
    const factsRequest = request("facts", filter, start, end, seconds, costView);
    assert.match(factsRequest.sql, /FROM claude_code\.codex_cost_events_v1/,
      "Parity must exercise facts, including full views");
    const raw = query(rawRequest);
    const facts = query(factsRequest);
    assert.deepEqual(stable(facts), stable(raw),
      "SQL parity " + JSON.stringify({ filter, start, end, costView }));
    for (const compactTime of [false, true]) {
      const fold = values => foldClientMetrics(values.map(row => ({ ...row, client: "codex" })),
        ["codex"], codexPrices, { costView, modelTime: true, compactTime });
      assert.deepEqual(stable(fold(facts)), stable(fold(raw)), "Fold parity");
    }
    assertions += 3;
  }
}
assert.equal(query(request("facts")).length, 0, "Creating views must not pretend to backfill history");
execute(costBackfillSql(), backfillParams);
for (const filter of filters) equal(filter);
// Live/backfill overlap and a complete repeated backfill must be idempotent.
insert([historical[0], historical[20], event({ ...token, "event.name": "codex.websocket_event" })]);
execute(costBackfillSql(), backfillParams);
execute(costBackfillSql(), backfillParams);
for (const filter of filters) equal(filter);
for (const [start, end] of [[15, 45], [14, 45], [15, 46], [31, 32], [46, 59]]) {
  for (const filter of [{}, { modelExact: model }]) {
    equal(filter, new Date(`2026-10-21T12:00:${start}Z`),
      new Date(`2026-10-21T12:00:${end}Z`), 60);
  }
}
execute("OPTIMIZE TABLE claude_code.codex_cost_events_v1 FINAL; OPTIMIZE TABLE claude_code.codex_cost_scope_v1 FINAL;");
equal();
const comparison = await compareCodexCost({ from: "2026-10-21T00:00:00Z", to: "2026-10-22T00:00:00Z" },
  async (sql, params) => rows(sql, params));
assert.equal(comparison.matched, true);
assert.equal(comparison.has_evidence, true);
console.log(JSON.stringify({ status: "passed", assertions, historical_rows: historical.length }));

if (process.env.COST_BENCHMARK === "1") {
  // 200k synthetic deltas plus 2k completion events, 20 users.
  execute(`INSERT INTO claude_code.otel_logs (Timestamp,ResourceAttributes,LogAttributes)
    SELECT toDateTime64('2026-10-22 00:00:00',9) + number / 100,
      map('user.email',concat('bench-',toString(number % 20),'@example.test'),'backend','bedrock-mantle'),
      map('event.name','codex.sse_event','event.kind',
        if(number % 101 = 0,'response.completed','response.output_text.delta'),
        'conversation.id',concat('bench-',toString(number % 200)),
        'model','${model}','input_token_count','100','cached_token_count','30',
        'cache_write_token_count','10','output_token_count','40','reasoning_token_count','10',
        'diagnostic',repeat('synthetic-metadata-',20))
    FROM numbers(202000)`);
  for (const filter of [{}, { userExact: "bench-1@example.test" }]) {
    equal(filter);
    for (const source of ["raw", "facts"]) {
      query(request(source, filter)); // warm-up, excluded
      const measurements = [];
      for (let i = 0; i < 3; i++) {
        const id = "cost-schema-" + randomUUID();
        query(request(source, filter), ["--query_id=" + id, "--log_queries=1"]);
        execute("SYSTEM FLUSH LOGS");
        measurements.push(rows(`SELECT query_duration_ms,read_rows,read_bytes,memory_usage
          FROM system.query_log WHERE type='QueryFinish' AND query_id={id:String}`, { id })[0]);
      }
      console.log(JSON.stringify({ benchmark: source, filter, measurements }));
    }
  }
}
