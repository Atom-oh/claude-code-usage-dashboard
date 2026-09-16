import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodexInsightsLogQuery, foldCodexInsightsLogs } from "./codexInsightsLogs.js";
import { ValidationError } from "./http.js";

const log = (n, event, attributes = {}, resource = {}) => ({
  timestamp: `2026-09-15 10:00:00.${String(n).padStart(9, "0")}`,
  resource: { backend: "bedrock-mantle", "user.email": "test@example.invalid", ...resource },
  attributes: { "event.name": `codex.${event}`, "conversation.id": "session",
    model: "openai.gpt-6-astra", ...attributes },
});
const completion = (n, attributes = {}, resource = {}) => log(n, "sse_event", {
  "event.kind": "response.completed", input_token_count: "100", cached_token_count: "40",
  cache_write_token_count: "11", output_token_count: "30", reasoning_token_count: "10",
  model_reasoning_effort: "high", ...attributes,
}, resource);
const request = (n, attributes = {}, resource = {}) =>
  log(n, "api_request", { attempt: "0", "http.response.status_code": "200", ...attributes }, resource);
const fields = (actual, expected) => {
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, key);
};

test("empty logs expose coverage and no invented ratios or latency", () => {
  const out = foldCodexInsightsLogs([]);
  assert.deepEqual(out.coverage, { status: "empty", records: 0, last_seen: null });
  fields(out.summary, { prompts: 0, cache_hit_rate: null, cache_write_share: null,
    reasoning_share: null, tokens_per_request: null, cost_per_request: null,
    cost_per_session: null, retry_rate: null, api_error_rate: null,
    tool_success_rate: null, approval_rate: null, prompt_length_mean: null });
  for (const key of ["effort", "latency", "tools", "approvals", "runtime", "events"])
    assert.deepEqual(out[key], []);
});

test("dedupe uses nanosecond timestamp and sorted maps, without mutating input", () => {
  const first = completion(1);
  const reordered = { ...first,
    resource: Object.fromEntries(Object.entries(first.resource).reverse()),
    attributes: Object.fromEntries(Object.entries(first.attributes).reverse()) };
  const rows = [first, first, reordered, completion(2), request(3)];
  const before = structuredClone(rows);
  const out = foldCodexInsightsLogs(rows);
  assert.equal(out.coverage.records, 3);
  assert.equal(out.coverage.last_seen, "2026-09-15T10:00:00.000Z");
  fields(out.summary, { tokens_per_request: 260, cost_per_request: 0.0047685 });
  assert.equal(out.events.find((r) => r.event === "codex.sse_event").count, 2);
  assert.deepEqual(rows, before);
});

test("prefix and event.name identify Codex events, independently of resource client", () => {
  const rows = [log(1, "user_prompt", { prompt_length: "5" }, { client: "claude" }),
    log(2, "user_prompt", { "event.name": "user_prompt", prompt_length: "20" }, { client: "codex" }),
    log(3, "user_prompt", { "event.name": "", prompt_length: "30" }, { client: "codex" })];
  fields(foldCodexInsightsLogs(rows).summary, { prompts: 1, prompt_length_mean: 5 });
  assert.equal(foldCodexInsightsLogs(rows).coverage.records, 1);
});

test("raw overflow is rejected before dedupe, including identical exports", () => {
  const row = request(1);
  assert.equal(foldCodexInsightsLogs(Array(50000).fill(row)).coverage.records, 1);
  assert.throws(() => foldCodexInsightsLogs(Array(50001).fill(row)),
    (error) => error instanceof ValidationError && error.status === 400);
});

test("price only usage-bearing completions, preserving token subsets and request denominators", () => {
  const out = foldCodexInsightsLogs([completion(1), request(2), request(3, { attempt: "1" }),
    log(4, "sse_event", { "event.kind": "response.completed" }),
    log(5, "sse_event", { "event.kind": "response.output_text.delta", input_token_count: "10000" }),
    log(6, "turn_cost", { estimated_usd: "900" })]);
  fields(out.summary, { cache_hit_rate: 0.4, cache_write_share: 0.11, reasoning_share: 1 / 3,
    tokens_per_request: 65, cost_per_request: 0.001192125, cost_per_session: 0.00238425,
    retry_rate: 0.5, api_error_rate: 0 });
  fields(out.effort[0], { effort: "high", requests: 1, tokens: 130, cost_usd: 0.00238425, unpriced: 0 });
});

test("per-completion tiers and routing use the supplied priceCodexUsage rates", () => {
  const rate = (input) => ({ input, cacheWrite: 0, cacheRead: 0, output: 0 });
  const prices = { "test.model": { short_context_limit: 100,
    regional: { short: rate(1), long: rate(2) }, global: { short: rate(3), long: rate(4) } } };
  const make = (n, input, model, backend) => completion(n, { model, input_token_count: String(input),
    cached_token_count: "0", cache_write_token_count: "0", output_token_count: "0",
    reasoning_token_count: "0" }, { backend });
  const out = foldCodexInsightsLogs([make(1, 100, "test.model", "bedrock-mantle"),
    make(2, 101, "test.model", "bedrock-mantle"),
    make(3, 101, "global.test.model", "bedrock-runtime")], prices);
  assert.equal(out.effort[0].cost_usd, 0.000706);
  assert.equal(out.summary.cost_per_session, 0.000706, "backend changes do not create another conversation");
});

test("runtime is start evidence and never fills missing or changed completion effort", () => {
  const start = log(1, "conversation_starts", { reasoning_effort: "high",
    approval_policy: "never", sandbox_policy: "read-only", provider_name: "amazon-bedrock",
    "app.version": "0.154.0" });
  const out = foldCodexInsightsLogs([start, { ...start, timestamp: log(2, "").timestamp },
    completion(3, { model_reasoning_effort: "low" }),
    completion(4, { model_reasoning_effort: undefined }), completion(5)]);
  assert.deepEqual(out.effort.map((r) => [r.effort, r.requests]).sort(),
    [["high", 1], ["low", 1], ["unknown", 1]]);
  assert.deepEqual(out.runtime, [{ model: "openai.gpt-6-astra", version: "0.154.0",
    provider: "amazon-bedrock", effort: "high", sandbox_policy: "read-only",
    approval_policy: "never", sessions: 1 }]);
});

test("runtime policies expose recognized names, never structured configuration or unsafe labels", () => {
  const out = foldCodexInsightsLogs([log(1, "conversation_starts", {
    sandbox_policy: JSON.stringify({ type: "workspace-write", writable_roots: ["/synthetic/private"] }),
    approval_policy: JSON.stringify({ reject: { sandbox_approval: true } }),
    model: "/synthetic/model", "app.version": "v".repeat(200),
    provider_name: "https://synthetic.invalid", reasoning_effort: "{\"private\":\"synthetic\"}",
  }), log(2, "conversation_starts", { sandbox_policy: "{\"name\":\"read-only\"}",
    approval_policy: "on-request", provider_name: "Amazon Bedrock" })]);
  const row = out.runtime.find((r) => r.sandbox_policy === "workspace-write");
  assert.ok(row, "structured policy should expose only its recognized type");
  fields(row, { approval_policy: "reject", model: "unknown", version: "unknown",
    provider: "unknown", effort: "unknown" });
  fields(out.runtime.find((r) => r.sandbox_policy === "read-only"),
    { approval_policy: "on-request", provider: "Amazon Bedrock" });
  assert.ok(!JSON.stringify(out).includes("synthetic"));
  for (const value of ["{\"type\":\"unrecognized\",\"roots\":[]}", "{broken", "", "/private"]) {
    fields(foldCodexInsightsLogs([log(3, "conversation_starts",
      { sandbox_policy: value, approval_policy: value })]).runtime[0],
    { sandbox_policy: "unknown", approval_policy: "unknown" });
  }
});

test("generic completions alone and usage-missing sessions make unit costs unavailable", () => {
  for (const rows of [
    [request(1), log(2, "sse_event", { "event.kind": "response.completed" })],
    [completion(1), request(2, { "conversation.id": "missing" })],
  ]) {
    fields(foldCodexInsightsLogs(rows).summary, {
      tokens_per_request: null, cost_per_request: null, cost_per_session: null, cache_hit_rate: null,
    });
  }
});

test("usage availability isolates model, backend, user and project", () => {
  for (const [attributes, resource] of [
    [{ model: "other" }, {}], [{}, { backend: "bedrock-runtime" }],
    [{}, { "user.email": "other@example.invalid" }], [{}, { "project.name": "other" }],
  ]) {
    assert.equal(foldCodexInsightsLogs([completion(1), request(2, attributes, resource)])
      .summary.cost_per_session, null);
  }
  assert.equal(foldCodexInsightsLogs([completion(1),
    log(2, "tool_result", { model: "", success: "true" }), request(3)]).summary.cost_per_request, 0.00238425);
  assert.equal(foldCodexInsightsLogs([completion(1, { "conversation.id": "" }),
    request(2, { "conversation.id": "" })]).summary.cost_per_session, null);
});

test("unknown model or backend preserves measured tokens but nulls combined costs", () => {
  for (const [attributes, resource] of [[{ model: "unpriced" }, {}], [{}, { backend: "" }],
    [{}, { backend: "unknown", provider_name: "amazon-bedrock" }]]) {
    const out = foldCodexInsightsLogs([completion(1), completion(2, attributes, resource), request(3)]);
    fields(out.summary, { cost_per_session: null, tokens_per_request: 260 });
    fields(out.effort[0], { cost_usd: null, unpriced: 1 });
  }
});

test("invalid and absent token components propagate without hiding independently valid subsets", () => {
  const cache = foldCodexInsightsLogs([completion(1), completion(2, { cached_token_count: "101" }), request(3)]);
  fields(cache.summary, { cost_per_request: null, tokens_per_request: null,
    cache_hit_rate: null, cache_write_share: null, reasoning_share: 1 / 3 });
  const reasoning = foldCodexInsightsLogs([completion(1), completion(2, { reasoning_token_count: "31" }), request(3)]);
  fields(reasoning.summary, { cost_per_request: null, tokens_per_request: null,
    reasoning_share: null, cache_hit_rate: 0.4 });
  for (const value of [undefined, null, "", " ", "NaN", "Infinity", "-1", "1.5", true, "9007199254740992"]) {
    const out = foldCodexInsightsLogs([completion(1, { input_token_count: value }), request(2)]);
    fields(out.summary, { tokens_per_request: null, cost_per_request: null, cache_hit_rate: null });
  }
});

test("explicit zero usage remains zero with undefined zero-denominator fractions", () => {
  const out = foldCodexInsightsLogs([request(1), completion(2, { input_token_count: "0",
    cached_token_count: "0", cache_write_token_count: "0", output_token_count: "0", reasoning_token_count: "0" })]);
  fields(out.summary, { tokens_per_request: 0, cost_per_request: 0, cost_per_session: 0,
    cache_hit_rate: null, cache_write_share: null, reasoning_share: null });
});

test("WebSocket completion usage is priced; anonymous usage cannot inflate per-session cost", () => {
  const out = foldCodexInsightsLogs([completion(1),
    completion(2, { "event.name": "codex.websocket_event", "conversation.id": "" }), request(3)]);
  fields(out.summary, { tokens_per_request: 260, cost_per_request: 0.0047685, cost_per_session: null });
});

test("overflowing aggregate estimates stay null rather than serializing Infinity", () => {
  const rate = { input: 1e302, cacheWrite: 0, cacheRead: 0, output: 0 };
  const prices = { "openai.gpt-6-astra": { short_context_limit: 100,
    regional: { short: rate, long: rate } } };
  const small = { input_token_count: "1", cached_token_count: "0", cache_write_token_count: "0",
    output_token_count: "0", reasoning_token_count: "0" };
  const out = foldCodexInsightsLogs([completion(1, small), completion(2, small), request(3)], prices);
  assert.equal(out.summary.cost_per_request, null);
  assert.equal(out.effort[0].cost_usd, null);
});

test("retry attempts are zero-based and missingness never becomes a first attempt", () => {
  assert.equal(foldCodexInsightsLogs([request(1), request(2, { attempt: "1" }),
    request(3, { attempt: "3" })]).summary.retry_rate, 2 / 3);
  for (const attempt of [undefined, "", " ", "-1", "1.5", "NaN", true]) {
    assert.equal(foldCodexInsightsLogs([request(1), request(2, { attempt })]).summary.retry_rate, null);
  }
});

test("API outcomes use status and error.message without treating absent status as success", () => {
  const out = foldCodexInsightsLogs([request(1), request(2, { "http.response.status_code": "429" }),
    request(3, { "error.message": "synthetic failure" }), log(4, "api_error")]);
  assert.equal(out.summary.api_error_rate, 0.75);
  assert.equal(foldCodexInsightsLogs([request(1), request(2, { "http.response.status_code": "" })])
    .summary.api_error_rate, null);
  for (const status of ["302", "399"])
    assert.equal(foldCodexInsightsLogs([request(1, { "http.response.status_code": status })]).summary.api_error_rate, 0);
});

test("failed SSE/WebSocket records count after HTTP success and can exceed requests", () => {
  for (const event of ["sse_event", "websocket_event"]) {
    const failed = log(2, event, { "event.kind": "response.failed" });
    for (const [status, rate] of [["200", 1], ["302", 1], ["400", 2]])
      assert.equal(foldCodexInsightsLogs([request(1, { "http.response.status_code": status }), failed, failed])
        .summary.api_error_rate, rate);
    assert.equal(foldCodexInsightsLogs([failed]).summary.api_error_rate, null);
    assert.equal(foldCodexInsightsLogs([request(1, { "http.response.status_code": "" }), failed])
      .summary.api_error_rate, null);
  }
});

test("latency uses valid raw samples, exact nearest-rank quantiles and startup phases", () => {
  const rows = [request(1, { duration_ms: "0" }), request(2, { duration_ms: "10" }),
    request(3, { duration_ms: "20" }), request(4, { duration_ms: "1000" }),
    log(5, "sse_event", { duration_ms: "7" }), log(6, "turn_ttft", { duration_ms: "100" }),
    log(7, "tool_result", { duration_ms: "30" }),
    log(8, "startup_phase", { "startup.phase": "thread_start_total", duration_ms: "50" }),
    log(9, "startup_phase", { "startup.phase": "thread_start_create_thread", duration_ms: "25" }),
    log(10, "websocket_request", { duration_ms: "15" }),
    log(11, "websocket_event", { duration_ms: "3" }),
    ...[undefined, "", " ", "-1", "NaN", "Infinity", true].map((duration_ms, i) => request(20 + i, { duration_ms }))];
  rows.push(rows[3]);
  const out = foldCodexInsightsLogs(rows);
  assert.deepEqual(out.latency.find((r) => r.name === "api_request"),
    { name: "api_request", count: 4, average_ms: 257.5, p50_ms: 10, p95_ms: 1000, max_ms: 1000 });
  for (const [name, mean] of [["sse_event", 7], ["turn_ttft", 100], ["tool_result", 30],
    ["startup_phase:thread_start_total", 50], ["startup_phase:thread_start_create_thread", 25],
    ["websocket_request", 15], ["websocket_event", 3]]) {
    assert.equal(out.latency.find((r) => r.name === name)?.average_ms, mean, name);
  }
});

test("tool counts retain unknown success and missing duration without inventing failures", () => {
  const rows = [log(1, "tool_result", { tool_name: "shell", success: "true", duration_ms: "10" }),
    log(2, "tool_result", { tool_name: "shell", success: "false", duration_ms: "30" })];
  const known = foldCodexInsightsLogs(rows);
  fields(known.tools[0], { calls: 2, successes: 1, failures: 1, unknown: 0,
    success_rate: 0.5, average_ms: 20, p95_ms: 30 });
  const partial = foldCodexInsightsLogs([...rows, log(3, "tool_result", { tool_name: "shell" })]);
  fields(partial.tools[0], { calls: 3, successes: 1, failures: 1, unknown: 1,
    success_rate: null, average_ms: 20, p95_ms: 30 });
  assert.equal(partial.summary.tool_success_rate, null);
});

test("approval decisions and sources stay distinct; permission is not code acceptance", () => {
  const decisions = ["approved", "approved_for_session", "approved_with_amendment",
    "approved_mcp_policy_amendment", "approved_with_network_policy_allow", "denied", "denied_with_network_policy_deny"];
  const rows = decisions.map((decision, n) => log(n, "tool_decision",
    { tool_name: "shell", decision, source: n ? "User" : "Config" }));
  const out = foldCodexInsightsLogs(rows);
  assert.equal(out.summary.approval_rate, 5 / 7);
  assert.deepEqual(out.approvals.find((r) => r.source === "Config"),
    { tool: "shell", decision: "approved", source: "Config", count: 1 });
  const unknown = foldCodexInsightsLogs([...rows, log(8, "tool_decision", { decision: "future_decision" })]);
  assert.equal(unknown.summary.approval_rate, null);
});

test("prompt lengths use characters as emitted and never return raw payload fields", () => {
  const rows = [log(1, "user_prompt", { prompt_length: "0", prompt: "synthetic payload" }),
    log(2, "user_prompt", { prompt_length: "12" }),
    log(3, "tool_result", { arguments: "synthetic arguments", output: "synthetic output" }),
    request(4, { "error.message": "synthetic error", endpoint: "synthetic endpoint" })];
  const out = foldCodexInsightsLogs(rows);
  fields(out.summary, { prompts: 2, prompt_length_mean: 6 });
  assert.ok(!JSON.stringify(out).includes("synthetic"));
  fields(foldCodexInsightsLogs([...rows, log(5, "user_prompt")]).summary,
    { prompts: 3, prompt_length_mean: null });
});

test("query bounds all selectors and caps sorted-map deduplicated raw rows", () => {
  const term = "model' OR 1=1";
  const { sql, params } = buildCodexInsightsLogQuery(new Date("2026-09-15T10:00:00Z"),
    new Date("2026-09-15T11:00:00Z"), { user: term, model: term, backend: "unknown" });
  assert.ok(!sql.includes(term));
  assert.ok(Object.values(params).includes(term));
  assert.ok(Object.values(params).includes("unknown"));
  assert.equal(params.from, "2026-09-15 10:00:00");
  assert.equal(params.to, "2026-09-15 11:00:00");
  assert.match(sql, /LIMIT 50001\b/);
  assert.match(sql, /mapSort\(ResourceAttributes\)/);
  assert.match(sql, /mapSort\(LogAttributes\)/);
  assert.match(sql, /startsWith\(EventName, 'codex\.'\)/);
});

test("real ClickHouse preserves raw identity, limits and clientMetrics model attribution", {
  skip: !process.env.CODEX_LOG_SQL_TEST_URL,
}, async () => {
  const { createClient } = await import("@clickhouse/client");
  const { buildCodexQuery, foldClientMetrics } = await import("./clientMetrics.js");
  const db = createClient({ url: process.env.CODEX_LOG_SQL_TEST_URL, database: "claude_code" });
  const from = new Date("2026-09-15T10:00:00Z"), to = new Date("2026-09-15T11:00:00Z");
  const select = async (filters, builder = buildCodexInsightsLogQuery) => {
    const { sql, params } = builder(from, to, filters);
    return (await db.query({ query: sql, query_params: params, format: "JSONEachRow" })).json();
  };
  const insert = (rows) => db.insert({ table: "otel_logs", format: "JSONEachRow",
    values: rows.map((row) => ({ Timestamp: row.timestamp,
      ResourceAttributes: row.resource, LogAttributes: row.attributes })) });
  try {
    const first = completion(1);
    await insert([first, first, { ...first,
      resource: Object.fromEntries(Object.entries(first.resource).reverse()),
      attributes: Object.fromEntries(Object.entries(first.attributes).reverse()) }, completion(2), request(3)]);
    const raw = await select({ user: "test@" });
    assert.equal(raw.length, 3);
    assert.deepEqual(Object.keys(raw[0]).sort(), ["attributes", "resource", "timestamp"]);
    assert.notEqual(raw[0].timestamp, raw[1].timestamp);
    assert.equal(foldCodexInsightsLogs(raw).summary.tokens_per_request, 260);
    assert.deepEqual(await select({ user: "' OR 1=1" }), []);
    assert.deepEqual(await select({ model: "absent" }), []);
    const errorsUser = { "user.email": "errors@example.invalid" };
    const failed = log(10, "sse_event", { "event.kind": "response.failed" }, errorsUser);
    await insert([request(10, {}, errorsUser), failed, failed,
      request(11, { "http.response.status_code": "302" }, errorsUser),
      log(11, "websocket_event", { "event.kind": "response.failed" }, errorsUser),
      request(12, { "http.response.status_code": "400" }, errorsUser),
      log(12, "sse_event", { "event.kind": "response.failed" }, errorsUser)]);
    const errors = { user: "errors@" };
    const totals = foldClientMetrics((await select(errors, buildCodexQuery))
      .map((row) => ({ ...row, client: "codex" })), ["codex"]).totals;
    fields(totals, { requests: 3, api_errors: 4 });
    assert.equal(foldCodexInsightsLogs(await select(errors)).summary.api_error_rate, 4 / 3);
    const model = "openai.gpt-6-astra";
    const make = (session, event, modelValue = "", resource = {}) => log(100, event,
      { "conversation.id": session, tool_name: session, model: modelValue },
      { "user.email": "scope@example.invalid", "project.name": "fixture", ...resource });
    await insert([
      make("matched", "api_request", model), make("matched", "tool_result"),
      make("matched", "tool_result", "nonmatching"), make("direct", "tool_result", model),
      ...[{ "user.email": "scope-other@example.invalid" }, { backend: "bedrock-runtime" },
        { "project.name": "other" }].map((resource) => make("matched", "tool_result", "", resource)),
      make("miss", "api_request", "nonmatching"), make("miss", "tool_result"),
      make("start-only", "conversation_starts", model), make("start-only", "tool_result"),
      { ...make("early", "api_request", model), timestamp: "2026-09-15 09:59:59" },
      { ...make("late", "api_request", model), timestamp: "2026-09-15 11:00:00" },
      make("early", "tool_result"), make("late", "tool_result"),
      make("", "api_request", model), make("", "tool_result"),
      ...["api_request", "tool_result"].map((event) => make("fallback", event,
        event === "api_request" ? model : "", { "user.email": "", "enduser.id": "scope-fallback" })),
      make("unknown-backend", "tool_result", model, { backend: "" }),
      { ...make("foreign", "api_request", model),
        attributes: { ...make("foreign", "api_request", model).attributes, "event.name": "api_request" } },
      make("foreign", "tool_result"),
    ]);
    const filters = { user: "scope", model: "ASTRA", backend: "bedrock-mantle" };
    const selected = await select(filters), overview = await select(filters, buildCodexQuery);
    assert.deepEqual(selected.filter((row) => row.attributes["event.name"] === "codex.tool_result")
      .map((row) => row.attributes.tool_name).sort(), ["direct", "fallback", "matched"]);
    assert.deepEqual(overview.filter((row) => row.kind === "tool").map((row) => row.tool).sort(),
      ["direct", "fallback", "matched"]);
    const unknown = await select({ user: "scope", model, backend: "unknown" });
    assert.deepEqual(unknown.map((row) => row.attributes.tool_name), ["unknown-backend"]);
    await db.command({ query: `INSERT INTO otel_logs (Timestamp, ResourceAttributes, LogAttributes)
      SELECT toDateTime64('2026-09-15 10:00:00', 9) + toIntervalMicrosecond(number),
        map('user.email','limit@example.invalid'), map('event.name','codex.api_request')
      FROM numbers(50002)` });
    const capped = await select({ user: "limit@" });
    assert.equal(capped.length, 50001);
    assert.throws(() => foldCodexInsightsLogs(capped), ValidationError);
  } finally {
    await db.close();
  }
});

test("session unit cost uses all priced detail sessions, not the subset with progress events", () => {
  const rows = [completion(1), request(2), completion(3, { "conversation.id": "second" }),
    request(4, { "conversation.id": "second" })];
  const expected = foldCodexInsightsLogs(rows);
  const summary = { coverage: expected.coverage, events: expected.events, latency: [] };
  rows.push({ is_scope: 1, timestamp: rows[0].timestamp, resource: rows[0].resource,
    attributes: { "conversation.id": "session" } });
  const actual = foldCodexInsightsLogs(rows, undefined, { summary, deduplicated: true });
  assert.equal(actual.summary.cost_per_session, expected.summary.cost_per_session);
});
