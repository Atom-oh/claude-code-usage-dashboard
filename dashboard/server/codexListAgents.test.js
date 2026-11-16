import test from "node:test";
import assert from "node:assert/strict";
import { LIST_AGENT_BUDGET_MS, LIST_LINEAGE_SPAN_LIMIT, LIST_TOOL_SPAN_LIMIT, codexLinkToolSql, codexListSubagents } from "./codexListAgents.js";
import { SPAN_SLACK_MS, userTasks } from "./taskTraces.js";
import { DEFAULT_CODEX_PRICING } from "./codexPricing.js";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ms = (iso) => Date.parse(iso);
const P = uuid(1), Q = uuid(2), C1 = uuid(11), C2 = uuid(12), C3 = uuid(13);
const turn = (conversation, turnId, at, overrides = {}) => ({
  conversation_id: conversation, turn_id: turnId, in_bucket: 1, started_at: at,
  start_ms: String(ms(at)), end_ms: String(ms(at) + 60000), llm_calls: "2", models: ["openai.gpt-6-astra"],
  app_version: "0.169.0", ...overrides,
});
const span = (trace, id, parent, name, extra = {}) => ({ trace_id: trace, span_id: id, parent_id: parent, name,
  conversation: "", turn: "", call_id: "", start_ms: "0", ...extra });
// A subagent turn `child` (conversation `conv`) started by tool span `tool` of turn `parentTurn` (Codex 0.166+).
const chain = (trace, tag, parentTurn, child, conv, { tool = "multi_agent_v1spawn_agent" } = {}) => [
  span(trace, `g${tag}`, "x", tool, { turn: parentTurn, conversation: "root", call_id: `call_${tag}` }),
  span(trace, `d${tag}`, `g${tag}`, "dispatch_tool_call_with_state"),
  span(trace, `o${tag}`, `d${tag}`, "op.dispatch.turn_input"),
  span(trace, `t${tag}`, `o${tag}`, "codex.turn_input", { turn: child, conversation: conv }),
  span(trace, `c${tag}`, `t${tag}`, "session_task.turn", { turn: child }),
];
// The same chain before Codex 0.166: the tool span carries only its call id.
const legacyChain = (trace, tag, child, at = "2026-11-05T01:00:01Z") => [
  span(trace, `g${tag}`, "x", "multi_agent_v1spawn_agent", { call_id: `call_${tag}`, start_ms: String(ms(at)) }),
  span(trace, `d${tag}`, `g${tag}`, "dispatch_tool_call_with_state"),
  span(trace, `o${tag}`, `d${tag}`, "op.dispatch.turn_input"),
  span(trace, `t${tag}`, `o${tag}`, "codex.turn_input", { turn: child }),
  span(trace, `c${tag}`, `t${tag}`, "session_task.turn", { turn: child }),
];
const tools = (rows) => rows.filter((r) => /^(collaboration|multi_agent_v1)/.test(r.name));
// A run() serving the tool-span scan, the lineage read and the legacy lookups, recording every read.
const fakeRun = (seen, { lineage = [], toolRows = tools(lineage), logs = [], conversations = [] } = {}) => async (sql, params) => {
  seen.push({ sql, params });
  if (sql.includes("op.dispatch")) return lineage.filter((r) => params.traceIds.includes(r.trace_id));
  if (sql.includes("codex.tool_result")) return logs;
  if (sql.includes("{turnIds:Array(String)}")) return conversations;
  if (params && "r0From" in params) return toolRows;
  throw new Error(`unexpected SQL ${sql.slice(0, 60)}`);
};

test("the tool-span scan binds the owner and each turn window, and reads only agent tool spans", () => {
  const { sql, params } = codexLinkToolSql("kim@x.com", [{ fromMs: ms("2026-11-05T01:00:00Z"), toMs: ms("2026-11-05T01:10:00Z") },
    { fromMs: ms("2026-11-05T03:00:00Z"), toMs: ms("2026-11-05T03:05:00Z") }]);
  assert.match(sql, /\{userExact:String\}/);
  assert.match(sql, /Timestamp >= \{r0From:DateTime\} AND Timestamp < \{r0To:DateTime\}/);
  assert.match(sql, /Timestamp >= \{r1From:DateTime\} AND Timestamp < \{r1To:DateTime\}/);
  for (const prefix of ["collaboration", "multi_agent_v1"]) assert.ok(sql.includes(`startsWith(SpanName, '${prefix}')`), prefix);
  assert.ok(sql.includes(`LIMIT ${LIST_TOOL_SPAN_LIMIT + 1}`));
  assert.equal(params.userExact, "kim@x.com");
  assert.equal(params.r0From, "2026-11-05 01:00:00");
  assert.equal(params.r1To, "2026-11-05 03:05:01");
});

test("a list turn counts the distinct subagent conversations its tool calls started", async () => {
  // Two spawns into two conversations, and a send_input that starts another turn of the first one.
  const lineage = [...chain("t1", 1, P, C1, "sub1"), ...chain("t2", 2, P, C2, "sub2"),
    ...chain("t3", 3, P, C3, "sub1", { tool: "multi_agent_v1send_input" })];
  const seen = [];
  const out = await codexListSubagents("kim@x.com", [turn("root", P, "2026-11-05T01:00:00Z")], [],
    { run: fakeRun(seen, { lineage }) });
  assert.equal(out.get(P), 2);
  assert.ok(seen.every((s) => s.params.userExact === "kim@x.com"));
  const lineageRead = seen.find((s) => s.sql.includes("op.dispatch"));
  assert.deepEqual(lineageRead.params.traceIds, ["t1", "t2", "t3"]);
  assert.ok(lineageRead.sql.includes(`LIMIT ${LIST_LINEAGE_SPAN_LIMIT + 1}`));
});

test("no link tool span is a zero only for a version that names its turn on tool spans", async () => {
  const seen = [];
  const out = await codexListSubagents("kim@x.com", [turn("root", P, "2026-11-05T01:00:00Z"),
    turn("old", Q, "2026-11-05T02:00:00Z", { app_version: "0.163.0" })], [], { run: fakeRun(seen) });
  assert.equal(out.get(P), 0);
  assert.equal(out.get(Q), null);
  // Nothing to walk: only the scan ran.
  assert.equal(seen.length, 1);
});

test("a turn whose rollup row counts spawn calls is never a zero, even when the scan finds none", async () => {
  const out = await codexListSubagents("kim@x.com", [turn("root", P, "2026-11-05T01:00:00Z", { spawn_calls: "3", names_turn: 1 })], [],
    { run: fakeRun([]) });
  assert.equal(out.get(P), null);
});

test("a turn whose tool call started no traced subagent turn is unknown, not zero", async () => {
  const lone = [span("t1", "g1", "x", "multi_agent_v1send_input", { turn: P, conversation: "root" })];
  const out = await codexListSubagents("kim@x.com", [turn("root", P, "2026-11-05T01:00:00Z")], [],
    { run: fakeRun([], { lineage: lone }) });
  assert.equal(out.get(P), null);
});

test("a legacy spawn resolves to its calling turn through the call log", async () => {
  const at = "2026-11-05T01:00:00Z";
  const seen = [];
  const lineage = legacyChain("t1", 1, C1);
  const out = await codexListSubagents("kim@x.com", [turn("root", P, at, { app_version: "0.163.0" })],
    [turn("root", P, at, { app_version: "0.163.0" })], { run: fakeRun(seen, { lineage,
      logs: [{ call_id: "call_1", conversation: "root", at_ms: String(ms(at) + 1000) }],
      conversations: [{ turn_id: C1, conversation: "sub1" }] }) });
  assert.equal(out.get(P), 1);
  assert.deepEqual(seen.find((s) => s.sql.includes("codex.tool_result")).params.callIds, ["call_1"]);
});

test("a legacy call that resolves to no page turn leaves the legacy turn unknown", async () => {
  const at = "2026-11-05T01:00:00Z";
  const old = turn("root", P, at, { app_version: "0.163.0" });
  // The call log names another conversation, with no turn in the list's read.
  const out = await codexListSubagents("kim@x.com", [old], [old], { run: fakeRun([], { lineage: legacyChain("t1", 1, C1),
    logs: [{ call_id: "call_1", conversation: "elsewhere", at_ms: String(ms(at) + 1000) }],
    conversations: [{ turn_id: C1, conversation: "sub1" }] }) });
  assert.equal(out.get(P), null);
});

test("a legacy call outside a legacy turn's window is not walked for it", async () => {
  const at = "2026-11-05T01:00:00Z";
  const old = turn("root", P, at, { app_version: "0.163.0" });
  const seen = [];
  const out = await codexListSubagents("kim@x.com", [old], [old], { run: fakeRun(seen, {
    lineage: legacyChain("t1", 1, C1, "2026-11-05T05:00:00Z") }) });
  assert.equal(out.get(P), null);
  assert.equal(seen.length, 1, "only the scan ran");
});

test("a lineage read past its cap leaves the turn unknown, not a short count", async () => {
  const lineage = chain("t1", 1, P, C1, "sub1");
  const big = [...lineage, ...Array.from({ length: LIST_LINEAGE_SPAN_LIMIT }, (_, i) => span("t1", `z${i}`, "", "run_turn"))];
  const out = await codexListSubagents("kim@x.com", [turn("root", P, "2026-11-05T01:00:00Z")], [],
    { run: fakeRun([], { lineage: big, toolRows: tools(lineage) }) });
  assert.equal(out.get(P), null);
});

test("a turn ending near the read bound is unknown, as its detail withholds its spawn evidence", async () => {
  const toMs = ms("2026-11-05T02:00:00Z");
  // The list reads spans up to toMs + 24h; this turn ends 30 s before that bound.
  const clipped = turn("root", P, "2026-11-06T01:00:00Z", { end_ms: String(toMs + SPAN_SLACK_MS - 30000) });
  const fine = turn("root", Q, "2026-11-05T01:00:00Z");
  const out = await codexListSubagents("kim@x.com", [clipped, fine], [], { run: fakeRun([], { lineage: chain("t1", 1, P, C1, "sub1") }), toMs });
  assert.equal(out.get(P), null);
  assert.equal(out.get(Q), 0);
});

test("a chain under any agent tool counts, and an agent tool that started none is a zero", async () => {
  // resume_agent starts a turn of an existing agent; wait_agent starts none.
  const lineage = [...chain("t1", 1, P, C1, "sub1", { tool: "multi_agent_v1resume_agent" }),
    span("t2", "w1", "x", "multi_agent_v1wait_agent", { turn: Q, conversation: "root" })];
  const seen = [];
  const out = await codexListSubagents("kim@x.com", [turn("root", P, "2026-11-05T01:00:00Z"), turn("root", Q, "2026-11-05T02:00:00Z")], [],
    { run: fakeRun(seen, { lineage }) });
  assert.equal(out.get(P), 1);
  assert.equal(out.get(Q), 0);
  assert.match(seen[0].sql, /startsWith\(SpanName, 'multi_agent_v1'\)/);
});

test("a capped tool-span scan leaves every list turn without a found subagent unknown", async () => {
  const toolRows = Array.from({ length: LIST_TOOL_SPAN_LIMIT + 1 }, (_, i) =>
    span(`t${i}`, `g${i}`, "x", "multi_agent_v1send_input", { turn: Q }));
  const out = await codexListSubagents("kim@x.com", [turn("root", P, "2026-11-05T01:00:00Z")], [],
    { run: fakeRun([], { toolRows }) });
  assert.equal(out.get(P), null);
});

test("once the list budget is spent, turns that need a lineage read stay unknown", async () => {
  let clock = 0;
  const run = async (sql, params) => { clock += LIST_AGENT_BUDGET_MS; return fakeRun([], { lineage: chain("t1", 1, P, C1, "sub1") })(sql, params); };
  const out = await codexListSubagents("kim@x.com", [turn("root", P, "2026-11-05T01:00:00Z"), turn("root", Q, "2026-11-05T02:00:00Z")], [],
    { run, now: () => clock });
  assert.equal(out.get(P), null);
  // Q has no tool span at all: its zero needs no lineage read.
  assert.equal(out.get(Q), 0);
});

test("the task list fills Codex subagents and ranks them by that count", async () => {
  const both = ["claude", "codex"];
  const from = new Date("2026-11-05T00:00:00Z"), to = new Date("2026-11-06T00:00:00Z");
  const turns = [turn("root", P, "2026-11-05T01:00:00Z", { spawn_calls: "1", names_turn: 1 }),
    turn("other", Q, "2026-11-05T02:00:00Z", { llm_calls: "9", spawn_calls: "0", names_turn: 1 })];
  const lineage = chain("t1", 1, P, C1, "sub1");
  const run = async (sql, params) => {
    if ("r0From" in params || sql.includes("op.dispatch")) return fakeRun([], { lineage })(sql, params);
    if (sql.includes("GROUP BY turn_id")) return turns;
    return [];
  };
  const out = await userTasks(from, to, { userExact: "kim@x.com", client: "codex", sort: "subagents" }, both, run,
    DEFAULT_CODEX_PRICING, null);
  assert.deepEqual(out.tasks.map((t) => [t.id, t.subagents]), [[`codex:root:${P}`, 1], [`codex:other:${Q}`, 0]]);
});
