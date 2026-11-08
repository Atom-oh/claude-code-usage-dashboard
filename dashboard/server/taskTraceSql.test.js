// Real ClickHouse regression for the task-trace SQL (scripts/test-client-sql.sh). Fixtures use
// the otel_traces/otel_logs layout of clickhouse-schema.sql: only the maps are inserted, and
// the promoted MATERIALIZED columns (UserEmail, SpanType, AgentId, Model, EventName, ...)
// derive from them, as in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { userTasks } from "./taskTraces.js";
import { userTaskDetail, codexDetailSql } from "./taskTraceDetail.js";
import { NotFoundError } from "./http.js";
import { requestListEstimate } from "./nonAnthropicCost.js";
import { priceCodexCompletion, buildCodexInsightsLogQuery } from "./codexInsightsLogs.js";
import { codexInsights } from "./codexInsights.js";
import { diagnosticSourceForRange } from "./codexDiagnosticSource.js";

const KIM = "kim@x.com", JOAKIM = "joakim@x.com";
const from = new Date("2026-11-05T00:00:00Z"), to = new Date("2026-11-06T00:00:00Z");
const prevFrom = new Date("2026-11-04T00:00:00Z");
const both = ["claude", "codex"];
const KIM_TRACE = "a".repeat(32), JOAKIM_TRACE = "b".repeat(32);
const ANTHROPIC = "claude-sonnet-4-5-20250929", NON_ANTHROPIC = "openai.gpt-6-astra";
const SECRET = "SECRET-DO-NOT-RETURN";
// Codex turn ids are UUIDs; `auto-compact-N` is a synthetic id that repeats across conversations.
const U1 = "019a0000-0000-7000-8000-000000000001", U2 = "019a0000-0000-7000-8000-000000000002";
const J1 = "019a0000-0000-7000-8000-00000000000a", COMPACT = "auto-compact-1";

const ts = (iso) => `${iso.replace("T", " ").replace("Z", "")}.000000000`;
const sec = (s) => s * 1e9;

const claudeSpan = (user, trace, id, parent, type, at, durationS, attrs = {}) => ({
  Timestamp: ts(at), TraceId: trace, SpanId: id, ParentSpanId: parent,
  SpanName: `claude_code.${type}`, Duration: sec(durationS),
  ResourceAttributes: { "user.email": user, "service.version": "2.1.300", "service.name": "claude-code" },
  SpanAttributes: { "span.type": type, "session.id": `session-${trace.slice(0, 4)}`, ...attrs },
});
const llm = (user, trace, id, parent, at, requestId, model, agent = "") => claudeSpan(user, trace, id, parent,
  "llm_request", at, 2, { request_id: requestId, model, input_tokens: "100", cache_read_tokens: "1000",
    cache_creation_tokens: "50", output_tokens: "20", ...(agent ? { agent_id: agent } : {}) });
const apiRequest = (user, at, requestId, model, cost) => ({
  Timestamp: ts(at),
  ResourceAttributes: { "user.email": user, "service.name": "claude-code" },
  LogAttributes: { "event.name": "api_request", request_id: requestId, model,
    input_tokens: "100", cache_read_tokens: "1000", cache_creation_tokens: "50", output_tokens: "20",
    ...(cost === undefined ? {} : { cost_usd: String(cost) }) },
});

const codexResource = (user) => ({ client: "codex", "user.email": user, backend: "bedrock-mantle" });
const sampling = (user, conversation, turn, id, at, durationS) => ({
  Timestamp: ts(at), TraceId: `codex-${conversation}`, SpanId: id, ParentSpanId: "",
  SpanName: "codex.sampling", Duration: sec(durationS), ResourceAttributes: codexResource(user),
  SpanAttributes: { "conversation.id": conversation, "turn.id": turn, model: NON_ANTHROPIC },
});
const exec = (user, conversation, turn, id, at, durationS) => ({
  Timestamp: ts(at), TraceId: `codex-${conversation}`, SpanId: id, ParentSpanId: "",
  SpanName: "exec_command", Duration: sec(durationS), ResourceAttributes: codexResource(user),
  SpanAttributes: { "conversation.id": conversation, turn_id: turn, tool_name: "shell",
    full_command: SECRET, aborted: "false" },
});
const COMPLETION_ATTRS = { input_token_count: "100", cached_token_count: "40", cache_write_token_count: "10",
  output_token_count: "30", reasoning_token_count: "10", model: NON_ANTHROPIC, model_reasoning_effort: "high" };
const completion = (user, conversation, at, extra = {}) => ({
  Timestamp: ts(at), ResourceAttributes: codexResource(user),
  LogAttributes: { "event.name": "codex.sse_event", "event.kind": "response.completed",
    "conversation.id": conversation, ...COMPLETION_ATTRS, ...extra },
});
const toolResult = (user, conversation, at, tool) => ({
  Timestamp: ts(at), ResourceAttributes: codexResource(user),
  LogAttributes: { "event.name": "codex.tool_result", "conversation.id": conversation, tool_name: tool,
    success: "true", duration_ms: "120" },
});

const traces = [
  // kim's Claude task: interaction on 11-05, main call, Agent tool -> general-purpose subagent
  // whose calls start 2h after the interaction day ends (inside the 24h span slack).
  claudeSpan(KIM, KIM_TRACE, "i1", "", "interaction", "2026-11-05T22:30:00Z", 4 * 3600, { user_prompt: SECRET }),
  llm(KIM, KIM_TRACE, "l1", "i1", "2026-11-05T22:30:05Z", "r1", ANTHROPIC),
  // Duplicate export of the same span: counted once.
  llm(KIM, KIM_TRACE, "l1", "i1", "2026-11-05T22:30:05Z", "r1", ANTHROPIC),
  claudeSpan(KIM, KIM_TRACE, "t1", "i1", "tool", "2026-11-05T22:31:00Z", 3 * 3600,
    { tool_name: "Agent", subagent_type: "general-purpose", full_command: SECRET, file_path: SECRET }),
  claudeSpan(KIM, KIM_TRACE, "w1", "t1", "tool.blocked_on_user", "2026-11-05T22:31:00Z", 5,
    { decision: "accept", source: "user" }),
  claudeSpan(KIM, KIM_TRACE, "x1", "t1", "tool.execution", "2026-11-05T22:31:05Z", 3 * 3600),
  llm(KIM, KIM_TRACE, "l2", "x1", "2026-11-06T02:00:00Z", "r2", ANTHROPIC, "ag1"),
  llm(KIM, KIM_TRACE, "l3", "x1", "2026-11-06T02:05:00Z", "r3", NON_ANTHROPIC, "ag1"),
  // joakim's Claude task in the same bucket ("kim" is a substring of his address).
  claudeSpan(JOAKIM, JOAKIM_TRACE, "j1", "", "interaction", "2026-11-05T05:00:00Z", 60),
  llm(JOAKIM, JOAKIM_TRACE, "j2", "j1", "2026-11-05T05:00:05Z", "rj", ANTHROPIC),
  // kim's Codex turn U1: two sampling spans and one exec_command, window 10:00:10..10:00:55.
  sampling(KIM, "C1", U1, "s1", "2026-11-05T10:00:10Z", 15),
  // Duplicate export of s1 (counted once) and a turn-less span (never part of a turn).
  sampling(KIM, "C1", U1, "s1", "2026-11-05T10:00:10Z", 15),
  { ...sampling(KIM, "C1", U1, "s0", "2026-11-05T09:59:00Z", 600), SpanName: "session_task",
    SpanAttributes: { "conversation.id": "C1" } },
  exec(KIM, "C1", U1, "e1", "2026-11-05T10:00:26Z", 3),
  sampling(KIM, "C1", U1, "s2", "2026-11-05T10:00:30Z", 25),
  // kim's turn U2 crosses into the bucket: it starts on 11-04 and belongs to that bucket.
  sampling(KIM, "C2", U2, "s3", "2026-11-04T23:59:30Z", 60),
  // joakim's Codex turn.
  sampling(JOAKIM, "CJ", J1, "sj", "2026-11-05T09:00:00Z", 10),
  // Two of kim's conversations share the synthetic turn id: one merged, unlinkable turn row.
  sampling(KIM, "C1", COMPACT, "ac1", "2026-11-05T11:00:00Z", 10),
  sampling(KIM, "C3", COMPACT, "ac3", "2026-11-05T14:00:00Z", 10),
];
const kimFirst = completion(KIM, "C1", "2026-11-05T10:00:20Z");
const logs = [
  apiRequest(KIM, "2026-11-05T22:30:07Z", "r1", ANTHROPIC, 0.01),
  // Two deliveries of r2: one without a report; the reported one wins.
  apiRequest(KIM, "2026-11-06T02:00:02Z", "r2", ANTHROPIC),
  apiRequest(KIM, "2026-11-06T02:00:02Z", "r2", ANTHROPIC, 0.02),
  // Non-Anthropic report is ignored for the ADR-017 list estimate.
  apiRequest(KIM, "2026-11-06T02:05:02Z", "r3", NON_ANTHROPIC, 9.99),
  apiRequest(JOAKIM, "2026-11-05T05:00:07Z", "rj", ANTHROPIC, 7),
  // kim's U1: two completions plus duplicate deliveries of the first.
  kimFirst, { ...kimFirst },
  // The same delivery with reordered map keys: still one event (sorted-map identity).
  { ...kimFirst, ResourceAttributes: Object.fromEntries(Object.entries(kimFirst.ResourceAttributes).reverse()),
    LogAttributes: Object.fromEntries(Object.entries(kimFirst.LogAttributes).reverse()) },
  completion(KIM, "C1", "2026-11-05T10:00:50Z"),
  // Unattached: same conversation, far outside every turn window.
  completion(KIM, "C1", "2026-11-05T12:00:00Z"),
  // Inside the auto-compact-1 windows of C1 and C3: unattached, the turn id is not unique.
  completion(KIM, "C1", "2026-11-05T11:00:05Z"),
  completion(KIM, "C3", "2026-11-05T14:00:05Z"),
  // Won by U2 (a context turn in this bucket): neither listed nor unattached here.
  completion(KIM, "C2", "2026-11-05T00:00:20Z"),
  // joakim: one attached and one unattached completion, both invisible to kim.
  completion(JOAKIM, "CJ", "2026-11-05T09:00:05Z"),
  completion(JOAKIM, "CJ", "2026-11-05T15:00:00Z"),
  toolResult(KIM, "C1", "2026-11-05T10:00:28Z", "shell"),
  toolResult(JOAKIM, "CJ", "2026-11-05T09:00:06Z", "apply_patch"),
];

const usage = priceCodexCompletion({ ...COMPLETION_ATTRS }, "bedrock-mantle");

test("real ClickHouse task trace list, detail and exact-user drilldown", {
  skip: !process.env.TASK_TRACE_SQL_TEST_URL,
}, async () => {
  const { createClient } = await import("@clickhouse/client");
  const db = createClient({ url: process.env.TASK_TRACE_SQL_TEST_URL, database: "claude_code" });
  const run = async (sql, params) =>
    (await db.query({ query: sql, query_params: params, format: "JSONEachRow" })).json();
  try {
    await db.insert({ table: "otel_traces", format: "JSONEachRow", values: traces });
    await db.insert({ table: "otel_logs", format: "JSONEachRow", values: logs });

    // List: kim has one Claude and one Codex task; joakim's rows never appear.
    const kim = await userTasks(from, to, { userExact: KIM }, both, run);
    assert.deepEqual(kim.tasks.map(t => t.id).sort(), [`claude:${KIM_TRACE}`, `codex:C1:${U1}`]);
    assert.deepEqual(kim.coverage, { claude: "observed", codex: "observed" });
    const claude = kim.tasks.find(t => t.client === "claude");
    assert.equal(claude.llm_calls, 3, "duplicate span export counted once; post-bucket subagent calls included");
    assert.equal(claude.subagents, 1);
    assert.deepEqual(claude.models, ["claude-sonnet-4-5", NON_ANTHROPIC]);
    assert.deepEqual({ input: claude.tokens.input, cache_read: claude.tokens.cache_read,
      cache_write: claude.tokens.cache_write, output: claude.tokens.output },
    { input: 300, cache_read: 3000, cache_write: 150, output: 60 });
    const estimate = requestListEstimate({ model: NON_ANTHROPIC, input_tokens: 100, cache_read_tokens: 1000,
      cache_creation_tokens: 50, output_tokens: 20 });
    assert.ok(Number.isFinite(estimate) && estimate !== 9.99);
    assert.ok(Math.abs(claude.cost_usd - (0.01 + 0.02 + estimate)) < 1e-12, String(claude.cost_usd));
    assert.equal(claude.cost_basis, "mixed");
    assert.equal(claude.cost_partial, false);

    const codex = kim.tasks.find(t => t.client === "codex");
    assert.equal(codex.llm_calls, 2);
    assert.equal(codex.duration_ms, 45000);
    assert.equal(codex.tokens.observed_tokens, 2 * usage.observed_tokens, "duplicate delivery counted once");
    assert.equal(codex.tokens.input, 2 * usage.input_tokens);
    assert.equal(codex.tokens.cache_read, 2 * usage.cache_read_tokens);
    assert.ok(Math.abs(codex.cost_usd - 2 * usage.cost_usd) < 1e-12);
    assert.ok(!kim.tasks.some(t => t.id.includes(COMPACT)), "a synthetic turn id is never listed");
    assert.equal(kim.unattached_codex.completions, 3);
    assert.ok(Math.abs(kim.unattached_codex.cost_usd - 3 * usage.cost_usd) < 1e-12);
    assert.deepEqual({ ...kim.unattached_codex, cost_usd: 0 }, { completions: 3, cost_usd: 0, cost_partial: false,
      turns_without_conversation: 0, turns_without_unique_id: 1 });
    for (const forbidden of [SECRET, JOAKIM, "user_prompt", "full_command", "r1", "CJ"])
      assert.ok(!JSON.stringify(kim).includes(forbidden), forbidden);

    const joakim = await userTasks(from, to, { userExact: JOAKIM }, both, run);
    assert.deepEqual(joakim.tasks.map(t => t.id).sort(), [`claude:${JOAKIM_TRACE}`, `codex:CJ:${J1}`]);
    assert.equal(joakim.unattached_codex.completions, 1);
    assert.equal(joakim.tasks.find(t => t.client === "claude").cost_usd, 7);
    assert.deepEqual((await userTasks(from, to, { userExact: "kim" }, both, run)).tasks, []);

    // A turn crossing a bucket edge is listed only in the bucket it starts in.
    const previous = await userTasks(prevFrom, from, { userExact: KIM }, ["codex"], run);
    assert.deepEqual(previous.tasks.map(t => t.id), [`codex:C2:${U2}`]);
    assert.equal(previous.tasks[0].tokens.observed_tokens, usage.observed_tokens,
      "the completion after the bucket end still links to its turn");
    assert.equal(previous.unattached_codex.completions, 0);

    // Detail: subagent lane present, totals equal the list row, no non-allowlisted attributes.
    const detail = await userTaskDetail(from, to, { id: `claude:${KIM_TRACE}`, userExact: KIM }, both, run);
    assert.deepEqual(detail.lanes.map(l => [l.id, l.kind, l.label, l.spawned_by]),
      [["main", "main", "main", null], ["ag1", "general-purpose", "general-purpose", "t1"]]);
    // One bar per tool call: the tool.execution span folds into its tool span.
    assert.ok(!detail.spans.some(s => s.id === "x1"));
    assert.equal(detail.spans.find(s => s.id === "l2").parent, "t1");
    assert.equal(detail.spans.find(s => s.id === "t1").execution_ms, 3 * 3600 * 1000);
    assert.equal(detail.lanes[1].llm_calls, 2);
    assert.equal(detail.truncated, false);
    assert.equal(detail.span_total, 6, "interaction excluded, duplicate span once");
    for (const k of ["llm_calls", "subagents", "tokens", "cost_usd", "cost_basis", "cost_partial"])
      assert.deepEqual(detail.task[k], claude[k], k);
    assert.deepEqual(detail.spans.find(s => s.id === "t1").attrs, { tool_name: "Agent", subagent_type: "general-purpose" });
    assert.deepEqual(detail.spans.find(s => s.id === "w1").attrs, { decision: "accept", source: "user" });
    assert.equal(detail.spans.find(s => s.id === "l3").cost_basis, "aws_list_estimate");
    for (const forbidden of [SECRET, "user_prompt", "full_command", "file_path", "r1", "r2", "session-"])
      assert.ok(!JSON.stringify(detail).includes(forbidden), forbidden);
    for (const raw of [{ id: `claude:${JOAKIM_TRACE}`, userExact: KIM },
      { id: `claude:${KIM_TRACE}`, userExact: JOAKIM }, { id: `codex:CJ:${J1}`, userExact: KIM },
      { id: `codex:C2:${U2}`, userExact: KIM }, { id: `codex:C3:${U1}`, userExact: KIM }]) {
      const err = await userTaskDetail(from, to, raw, both, run).then(() => null, e => e);
      assert.ok(err instanceof NotFoundError, JSON.stringify(raw));
    }

    const codexDetail = await userTaskDetail(from, to, { id: `codex:C1:${U1}`, userExact: KIM }, both, run);
    for (const k of ["llm_calls", "tokens", "cost_usd", "duration_ms"])
      assert.deepEqual(codexDetail.task[k], codex[k], k);
    assert.deepEqual(codexDetail.spans.map(s => s.id).sort(), ["e1", "s1", "s2"]);
    assert.equal(codexDetail.task.completions_without_span, 0);
    assert.deepEqual(codexDetail.spans.find(s => s.id === "e1").attrs, { tool_name: "shell", aborted: false });
    assert.ok(!JSON.stringify(codexDetail).includes(SECRET));
    // The detail span query keeps the requested conversation only (and spans without one).
    const compact = codexDetailSql(from, to, { userExact: KIM }, "C1", COMPACT).spans;
    assert.deepEqual((await run(compact.sql, compact.params)).map(r => r.span_id), ["ac1"]);

    // /api/codex/insights tools profile with userExact on the raw-log path: kim only.
    assert.equal(diagnosticSourceForRange(from, to), "raw");
    const raw = buildCodexInsightsLogQuery(from, to, { userExact: KIM });
    const rawRows = await run(raw.sql, raw.params);
    assert.ok(rawRows.length > 0);
    assert.deepEqual([...new Set(rawRows.map(r => r.resource["user.email"]))], [KIM]);
    const insights = await codexInsights(from, to, { profile: "tools", userExact: KIM }, run);
    assert.deepEqual(insights.tools.map(t => [t.tool, t.calls]), [["shell", 1]]);
    assert.ok(!JSON.stringify(insights).includes("apply_patch"));
  } finally {
    await db.close();
  }
});
