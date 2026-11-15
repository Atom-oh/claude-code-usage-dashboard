import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_DEPTH, AGENT_EXTRA_BUDGET_MS, AGENT_LIMIT, LEGACY_CALL_SLACK_MS, LINEAGE_SPAN_LIMIT, LINK_WINDOW_MS, SPAWN_SPANS, agentCount,
  codexCallLogSql, codexLineageSql, codexAgents, codexTurnConversationSql, containingTurn, foldAgents, legacyNeeds, linkWindow,
  resolveLegacy, walkLineage } from "./codexAgents.js";
import { codexTurnSql, codexCompletionSql, linkCompletions } from "./taskTraces.js";
import { DEFAULT_CODEX_PRICING, priceCodexUsage } from "./codexPricing.js";

const from = new Date("2026-11-05T00:00:00Z");
const to = new Date("2026-11-06T00:00:00Z");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ms = (iso) => Date.parse(iso);
const P = uuid(1), C1 = uuid(11), C2 = uuid(12), G1 = uuid(21);
const turn = (conversation, turnId, at, overrides = {}) => ({
  conversation_id: conversation, turn_id: turnId, in_bucket: 1, started_at: at,
  start_ms: String(ms(at)), end_ms: String(ms(at) + 10000), llm_calls: "2", models: ["openai.gpt-6-astra"], ...overrides,
});
let seq = 0;
const completion = (conversation, at) => ({
  identity: `id${seq++}`, conversation_id: conversation, timestamp_ms: String(ms(at) + 50), event_timestamp: at,
  model: "openai.gpt-6-astra", effort: "high", backend_tag: "",
  input_token_count: "100", cached_token_count: "40", cache_write_token_count: "10",
  output_token_count: "20", reasoning_token_count: "5",
});
const unitCost = priceCodexUsage({ input_tokens_total: 100, cache_read_tokens: 40, cache_write_tokens: 10,
  output_tokens: 20, reasoning_tokens: 5, model: "openai.gpt-6-astra", backend: "bedrock-mantle",
  context_tier: "short" }, DEFAULT_CODEX_PRICING).cost_usd;
const link = (parentTurn, child, conversation, overrides = {}) => ({
  parent_conversation: "root", parent_turn: parentTurn, tool_span: "collaborationspawn_agent",
  tool_span_id: `s-${child}`, child_turn: child, child_start_ms: "0", child_conversation: conversation, ...overrides,
});
const rootTask = { id: `codex:root:${P}`, llm_calls: 3, cost_usd: 1, cost_partial: false };

const span = (trace, id, parent, name, extra = {}) => ({ trace_id: trace, span_id: id, parent_id: parent, name,
  conversation: "", turn: "", start_ms: "0", ...extra });
// A subagent turn `child` (conversation `conv`) started by tool span `tool` of turn `parentTurn`.
const chain = (trace, tag, parentTurn, child, conv, { tool = "collaborationspawn_agent", parentConv = "root", at = "0" } = {}) => [
  span(trace, `g${tag}`, "x", tool, { turn: parentTurn, conversation: parentConv }),
  span(trace, `d${tag}`, `g${tag}`, "dispatch_tool_call_with_state"),
  span(trace, `i${tag}`, `d${tag}`, "op.dispatch.inter_agent_communication"),
  span(trace, `c${tag}`, `i${tag}`, "session_task.turn", { turn: child, start_ms: at }),
  span(trace, `r${tag}`, `c${tag}`, "run_turn", { turn: child, conversation: conv }),
];
// The same chain as Codex before 0.166 emits it: the tool span names no turn or conversation
// (only its call id), and run_turn carries no conversation.
const legacyChain = (trace, tag, child, { tool = "collaborationfollowup_task", at = "0" } = {}) => [
  span(trace, `g${tag}`, "x", tool, { call_id: `call_${tag}` }),
  span(trace, `d${tag}`, `g${tag}`, "dispatch_tool_call_with_state"),
  span(trace, `i${tag}`, `d${tag}`, "op.dispatch.inter_agent_communication"),
  span(trace, `c${tag}`, `i${tag}`, "session_task.turn", { turn: child, start_ms: at }),
  span(trace, `r${tag}`, `c${tag}`, "run_turn"),
];

test("lineage SQL reads the task's traces for the exact user with bound parameters", () => {
  const { sql, params } = codexLineageSql("kim@x.com", ["t1"], ms("2026-11-05T01:00:00Z"), ms("2026-11-05T02:00:00Z"));
  for (const name of ["session_task.turn", "op.dispatch.inter_agent_communication", "dispatch_tool_call_with_state", "run_turn"])
    assert.ok(sql.includes(`'${name}'`), name);
  assert.ok(sql.includes("startsWith(SpanName, 'collaboration')"));
  assert.ok(sql.includes("TraceId IN {traceIds:Array(String)}"));
  assert.ok(sql.includes("coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, ''), '') = {userExact:String}"));
  assert.ok(sql.includes(`LIMIT ${LINEAGE_SPAN_LIMIT + 1}`));
  assert.ok(!sql.includes("kim@x.com") && !sql.includes("t1"));
  assert.deepEqual(params, { spanFrom: "2026-11-05 00:50:00", spanTo: "2026-11-06 02:00:00", userExact: "kim@x.com", traceIds: ["t1"] });
});

test("the walk links subagent turns only through the complete parent-span chain", () => {
  const rows = [...chain("t", 1, P, C1, "sub1", { at: "2" }), ...chain("t", 2, C1, G1, "sub3", { parentConv: "sub1", at: "3" }),
    ...chain("t", 3, P, C2, "sub2", { tool: "collaborationfollowup_task", at: "1" })];
  // A turn span whose dispatch parent is missing (export gap) is not linked.
  rows.push(span("t", "lone", "missing", "session_task.turn", { turn: uuid(99) }));
  // The same span ids in another trace are a different chain.
  rows.push(span("u", "c1", "i1", "session_task.turn", { turn: uuid(98) }));
  const { parent, links, limited } = walkLineage(rows, P);
  assert.equal(parent, null);
  assert.equal(limited, false);
  assert.deepEqual(links.map(l => [l.child_turn, l.child_conversation, l.depth, l.tool_span]),
    [[C2, "sub2", 1, "collaborationfollowup_task"], [C1, "sub1", 1, "collaborationspawn_agent"], [G1, "sub3", 2, "collaborationspawn_agent"]]);
  const up = walkLineage(rows, G1).parent;
  assert.deepEqual([up.parent_turn, up.parent_conversation, up.tool_span], [C1, "sub1", "collaborationspawn_agent"]);
});

test("the walk stops at its depth and limit and flags what it did not follow", () => {
  const deep = [];
  let prev = P;
  for (let n = 0; n <= AGENT_DEPTH; n++) { const next = uuid(500 + n); deep.push(...chain("t", n, prev, next, `s${n}`)); prev = next; }
  const walked = walkLineage(deep, P);
  assert.equal(walked.links.length, AGENT_DEPTH);
  assert.equal(walked.limited, true);
  const wide = Array.from({ length: AGENT_LIMIT + 1 }, (_, n) => chain("t", n, P, uuid(1000 + n), `w${n}`)).flat();
  const cut = walkLineage(wide, P);
  assert.equal(cut.links.length, AGENT_LIMIT);
  assert.equal(cut.limited, true);
  assert.equal(walkLineage(chain("t", 1, P, C1, "sub1"), P).limited, false);
});

test("several conversations filter turns and completions with one array parameter", () => {
  const turns = codexTurnSql(from, to, { userExact: "a" }, { conversationIds: ["x", "y"] });
  assert.ok(turns.sql.includes("HAVING conversation_id IN {conversationIds:Array(String)}"));
  assert.deepEqual(turns.params.conversationIds, ["x", "y"]);
  const logs = codexCompletionSql(from, to, { userExact: "a" }, { conversationIds: ["x"] });
  assert.ok(logs.sql.includes("LogAttributes['conversation.id'] IN {conversationIds:Array(String)}"));
  // The single-conversation form is unchanged.
  assert.ok(codexTurnSql(from, to, { userExact: "a" }, { conversationId: "x" }).sql.includes("HAVING conversation_id = {conversationId:String}"));
});

test("fold prices each subagent turn from its own completions and totals the turn with them", () => {
  const { entries } = linkCompletions(
    [turn("sub1", C1, "2026-11-05T01:00:00Z"), turn("sub2", C2, "2026-11-05T01:00:00Z")],
    [completion("sub1", "2026-11-05T01:00:05Z"), completion("sub2", "2026-11-05T01:00:05Z"),
      completion("sub2", "2026-11-05T01:00:06Z")], { prices: DEFAULT_CODEX_PRICING });
  const out = foldAgents({ task: rootTask, entries, spawnSpanIds: [`s-${C1}`, `s-${C2}`, "s-lost"],
    links: [link(P, C1, "sub1", { depth: 1 }), link(P, C2, "sub2", { depth: 1, tool_span: "collaborationfollowup_task" })] });
  assert.equal(out.parent, null);
  assert.deepEqual(out.children.map(c => [c.id, c.parent_id, c.tool, c.llm_calls]),
    [[`codex:sub1:${C1}`, rootTask.id, "spawn_agent", 2], [`codex:sub2:${C2}`, rootTask.id, "followup_task", 2]]);
  assert.ok(Math.abs(out.children[1].cost_usd - 2 * unitCost) < 1e-12);
  assert.equal(out.subagents, 2);
  assert.equal(out.total.llm_calls, 7);
  assert.ok(Math.abs(out.total.cost_usd - (1 + 3 * unitCost)) < 1e-12);
  assert.equal(out.total.cost_partial, false);
  assert.deepEqual([out.spawn_calls, out.unlinked_calls], [3, 1]);
});

test("subagent turns come in tree order, each followed by its own subagent turns", () => {
  const out = foldAgents({ task: rootTask, links: [link(P, C1, "sub1", { depth: 1 }), link(P, C2, "sub2", { depth: 1 }),
    link(C1, G1, "sub3", { depth: 2 })] });
  assert.deepEqual(out.children.map(c => [c.id, c.depth]),
    [[`codex:sub1:${C1}`, 1], [`codex:sub3:${G1}`, 2], [`codex:sub2:${C2}`, 1]]);
});

test("a subagent turn without its own turn row is unknown, and the total says partial", () => {
  const out = foldAgents({ task: rootTask, links: [link(P, C1, "sub1", { depth: 1 })], spawnSpanIds: null });
  assert.deepEqual([out.children[0].llm_calls, out.children[0].cost_usd, out.children[0].cost_partial], [null, null, true]);
  assert.deepEqual([out.total.llm_calls, out.total.llm_calls_partial, out.total.cost_usd, out.total.cost_partial], [3, true, 1, true]);
  assert.deepEqual([out.spawn_calls, out.unlinked_calls], [null, null]);
});

test("the parent link of a subagent turn names its parent task and tool", () => {
  const out = foldAgents({ task: rootTask, parent: link(uuid(9), P, "x", { parent_conversation: "up" }) });
  assert.equal(out.parent.id, `codex:up:${uuid(9)}`);
  assert.equal(out.parent.tool, "spawn_agent");
  // Ids that are not identifier-shaped are not linked.
  assert.equal(foldAgents({ task: rootTask, parent: link(uuid(9), P, "x", { parent_conversation: "a b" }) }).parent, null);
});

test("a link window is the UTC hour containing a start, and unknown without one", () => {
  assert.deepEqual(linkWindow(ms("2026-11-05T01:30:00Z")),
    { from: "2026-11-05T01:00:00.000Z", to: "2026-11-05T02:00:00.000Z" });
  assert.equal(LINK_WINDOW_MS, 3600000);
  assert.equal(linkWindow(null), null);
  assert.equal(linkWindow(NaN), null);
});

test("each subagent turn links to the hour of its own start, even after the bucket ends", () => {
  const { entries } = linkCompletions([turn("sub1", C1, "2026-11-06T00:30:00Z")], [], { prices: DEFAULT_CODEX_PRICING });
  const out = foldAgents({ task: rootTask, entries, links: [link(P, C1, "sub1", { depth: 1 }),
    link(P, C2, "sub2", { depth: 1, child_start_ms: ms("2026-11-05T03:20:00Z") })] });
  assert.deepEqual(out.children[0].link, { from: "2026-11-06T00:00:00.000Z", to: "2026-11-06T01:00:00.000Z" });
  // Without its turn row the lineage span's start is used.
  assert.deepEqual(out.children[1].link, { from: "2026-11-05T03:00:00.000Z", to: "2026-11-05T04:00:00.000Z" });
});

test("the parent link carries the hour of the parent turn's start, before the bucket", () => {
  const parent = link(uuid(9), P, "x", { parent_conversation: "up" });
  const { entries } = linkCompletions([turn("up", uuid(9), "2026-11-04T23:10:00Z")], [], { prices: DEFAULT_CODEX_PRICING });
  const out = foldAgents({ task: rootTask, parent, entries });
  assert.equal(out.parent.started_at, "2026-11-04T23:10:00Z");
  assert.equal(out.parent.link.from, "2026-11-04T23:00:00.000Z");
  // Without the parent's turn row its start and link are unknown.
  const bare = foldAgents({ task: rootTask, parent });
  assert.deepEqual([bare.parent.started_at, bare.parent.link], [null, null]);
});

test("a subagent task reads its parent's turns but not the parent's completions", async () => {
  const seen = [];
  const run = async (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes("op.dispatch")) return [...chain("t", 9, uuid(9), P, "self", { parentConv: "up" }), ...chain("t", 1, P, C1, "sub1")];
    if (sql.includes("GROUP BY turn_id")) return [turn("up", uuid(9), "2026-11-04T23:10:00Z"), turn("sub1", C1, "2026-11-05T01:00:00Z")];
    if (sql.includes("otel_logs")) return [];
    throw new Error("unexpected SQL");
  };
  const turnInfo = { turnId: P, startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:00:10Z"), traceIds: ["t"] };
  const out = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  assert.equal(out.parent.id, `codex:up:${uuid(9)}`);
  const turnReads = seen.filter(s => s.sql.includes("GROUP BY turn_id"));
  assert.equal(turnReads.length, 1);
  assert.ok(turnReads[0].params.conversationIds.includes("up"));
  assert.ok(turnReads[0].params.conversationIds.includes("sub1"));
  const logReads = seen.filter(s => !s.sql.includes("op.dispatch") && !s.sql.includes("GROUP BY turn_id") && s.sql.includes("otel_logs"));
  assert.equal(logReads.length, 1);
  assert.deepEqual(logReads[0].params.conversationIds, ["sub1"]);
});

test("zero linked subagents is unknown, not zero", () => {
  const out = foldAgents({ task: rootTask, spawnSpanIds: [] });
  assert.equal(out.subagents, 0);
  assert.equal(agentCount(out), null);
  assert.equal(agentCount({ subagents: 2 }), 2);
  assert.deepEqual(SPAWN_SPANS, ["collaborationspawn_agent", "collaborationfollowup_task", "multi_agent_v1spawn_agent"]);
});

test("one lineage read, then one read of every subagent conversation, all for the owner", async () => {
  const seen = [];
  const run = async (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes("op.dispatch")) return [...chain("t", 1, P, C1, "sub1"), ...chain("t", 2, C1, G1, "sub3", { parentConv: "sub1" })];
    if (sql.includes("GROUP BY turn_id")) return [turn("sub1", C1, "2026-11-05T01:00:00Z"), turn("sub3", G1, "2026-11-05T01:00:00Z")];
    if (sql.includes("otel_logs")) return [completion("sub3", "2026-11-05T01:00:05Z")];
    throw new Error("unexpected SQL");
  };
  const turnInfo = { turnId: P, startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:00:10Z"), traceIds: ["t"] };
  const out = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  assert.deepEqual(out.children.map(c => [c.id, c.parent_id, c.depth]),
    [[`codex:sub1:${C1}`, rootTask.id, 1], [`codex:sub3:${G1}`, `codex:sub1:${C1}`, 2]]);
  assert.equal(out.limited, false);
  assert.ok(Math.abs(out.children[1].cost_usd - unitCost) < 1e-12);
  assert.equal(out.children[0].cost_usd, null);
  assert.equal(seen.filter(s => s.sql.includes("op.dispatch")).length, 1);
  const reads = seen.filter(s => s.sql.includes("GROUP BY turn_id"));
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].params.conversationIds, ["sub1", "sub3"]);
  assert.ok(seen.every(s => s.params.userExact === "kim@x.com"));
});

test("without trace ids nothing is read and the result is unknown, and partial traces flag the result", async () => {
  const run = async () => { throw new Error("no read expected"); };
  const none = await codexAgents("a", { turnId: P, startMs: 0, endMs: 1, traceIds: [] }, rootTask, null, { from, to, run });
  assert.deepEqual([none.children.length, none.limited, agentCount(none)], [0, false, null]);
  const partial = await codexAgents("a", { turnId: P, startMs: 0, endMs: 1, traceIds: ["t"], tracesPartial: true }, rootTask, null,
    { from, to, run: async () => [] });
  assert.equal(partial.limited, true);
  assert.equal(partial.total.cost_partial, true);
});

test("legacy spans need their call logs and child conversations", () => {
  const rows = [...legacyChain("t", 1, C1), ...chain("t", 2, P, C2, "sub2")];
  assert.deepEqual(legacyNeeds(rows), { callIds: ["call_1"], childTurns: [C1] });
  assert.deepEqual(legacyNeeds(chain("t", 3, P, C2, "sub2")), { callIds: [], childTurns: [] });
  // A call id outside the id shape is never sent to the database.
  assert.deepEqual(legacyNeeds([span("t", "g", "x", "collaborationspawn_agent", { call_id: "a b" })]).callIds, []);
});

test("call log and turn-conversation SQL bind the owner, ids and lineage window", () => {
  const a = codexCallLogSql("kim@x.com", ["call_1"], ms("2026-11-05T01:00:00Z"), ms("2026-11-05T02:00:00Z"));
  assert.ok(a.sql.includes("EventName = 'codex.tool_result'") && a.sql.includes("{callIds:Array(String)}"));
  assert.ok(a.sql.includes("coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, ''), '') = {userExact:String}"));
  assert.ok(a.sql.includes("LIMIT 1 BY call_id") && !a.sql.includes("kim@x.com") && !a.sql.includes("call_1"));
  assert.deepEqual(a.params, { spanFrom: "2026-11-05 00:50:00", spanTo: "2026-11-06 02:00:00", userExact: "kim@x.com",
    callIds: ["call_1"] });
  const b = codexTurnConversationSql("kim@x.com", [C1], ms("2026-11-05T01:00:00Z"), ms("2026-11-05T02:00:00Z"));
  assert.ok(b.sql.includes("{turnIds:Array(String)}") && b.sql.includes("GROUP BY turn_id"));
  assert.ok(b.sql.includes("{userExact:String}") && !b.sql.includes(C1));
  assert.deepEqual(b.params, { spanFrom: "2026-11-05 00:50:00", spanTo: "2026-11-06 02:00:00", userExact: "kim@x.com",
    turnIds: [C1] });
});

test("the containing turn of a call is the latest turn of its conversation started by then", () => {
  const turns = [turn("up", uuid(7), "2026-11-05T00:00:00Z", { end_ms: String(ms("2026-11-05T02:00:00Z")) }),
    turn("up", uuid(8), "2026-11-05T01:00:00Z"), turn("other", uuid(9), "2026-11-05T00:30:00Z")];
  assert.equal(containingTurn(turns, "up", ms("2026-11-05T01:00:05Z")).turn_id, uuid(8));
  assert.equal(containingTurn(turns, "up", ms("2026-11-05T01:30:00Z")).turn_id, uuid(7));
  assert.equal(containingTurn(turns, "up", ms("2026-11-05T00:00:00Z") - LEGACY_CALL_SLACK_MS).turn_id, uuid(7));
  assert.equal(containingTurn(turns, "up", ms("2026-11-05T03:00:00Z")), null);
  assert.equal(containingTurn(turns, "nope", ms("2026-11-05T01:00:05Z")), null);
});

test("a synthetic turn id covering the call never wins its containing turn over the UUID turn", () => {
  // `auto-compact-N` ids repeat across conversations, so their merged window identifies no turn.
  const turns = [turn("root", P, "2026-11-05T01:00:00Z", { end_ms: String(ms("2026-11-05T01:10:00Z")) }),
    turn("root", "auto-compact-1", "2026-11-05T01:00:30Z", { end_ms: String(ms("2026-11-05T01:05:00Z")) })];
  assert.equal(containingTurn(turns, "root", ms("2026-11-05T01:00:40Z")).turn_id, P);
  assert.equal(containingTurn([turns[1]], "root", ms("2026-11-05T01:00:40Z")), null);
});

test("a legacy spawn call inside a synthetic turn's window stays this UUID turn's call", async () => {
  const run = legacyRun([], { rows: legacyChain("t", 1, C1, { tool: "collaborationspawn_agent" }),
    logs: [{ call_id: "call_1", conversation: "root", at_ms: String(ms("2026-11-05T01:00:40Z")) }],
    conversations: [{ turn_id: C1, conversation: "sub1" }],
    turns: [turn("root", P, "2026-11-05T01:00:00Z", { end_ms: String(ms("2026-11-05T01:10:00Z")) }),
      turn("root", "auto-compact-1", "2026-11-05T01:00:30Z", { end_ms: String(ms("2026-11-05T01:05:00Z")) }),
      turn("sub1", C1, "2026-11-05T01:00:41Z")],
    completions: [completion("sub1", "2026-11-05T01:00:45Z")] });
  const turnInfo = { turnId: P, conversationId: "root", startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:10:00Z"),
    traceIds: ["t"] };
  const out = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  assert.deepEqual(out.children.map(c => [c.id, c.parent_id, c.tool]), [[`codex:sub1:${C1}`, rootTask.id, "spawn_agent"]]);
  assert.deepEqual([out.spawn_calls, out.unlinked_calls, out.limited], [1, 0, false]);
  // The subagent's own detail keeps its parent link to the UUID turn.
  const child = await codexAgents("kim@x.com", { turnId: C1, conversationId: "sub1", startMs: ms("2026-11-05T01:00:41Z"),
    endMs: ms("2026-11-05T01:00:51Z"), traceIds: ["t"] }, { id: `codex:sub1:${C1}`, llm_calls: 2, cost_usd: 1, cost_partial: false },
  [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  assert.equal(child.parent.id, `codex:root:${P}`);
});

test("resolved legacy spans link like 0.166 spans, and unresolved ones stay unlinked", () => {
  const rows = [...legacyChain("t", 1, C1), ...legacyChain("t", 2, C2), ...chain("t", 3, P, G1, "sub3")];
  const turns = [turn("root", P, "2026-11-05T01:00:00Z")];
  const logs = [{ call_id: "call_1", conversation: "root", at_ms: String(ms("2026-11-05T01:00:01Z")) },
    { call_id: "call_2", conversation: "root", at_ms: String(ms("2026-11-05T05:00:00Z")) }];
  const resolved = resolveLegacy(rows, logs, [{ turn_id: C1, conversation: "sub1" }], turns);
  const { links } = walkLineage(resolved.rows, P, resolved.conversations);
  assert.deepEqual(links.map(l => [l.child_turn, l.child_conversation, l.parent_conversation]).sort(),
    [[C1, "sub1", "root"], [G1, "sub3", "root"]].sort());
  assert.equal(walkLineage(resolved.rows, C1, resolved.conversations).parent.parent_turn, P);
  // The input rows are not changed.
  assert.equal(rows[0].turn, "");
});

// A run() for one legacy chain: lineage rows, the call log, the child conversation lookup, turns
// and completions, recording every read.
const legacyRun = (seen, { rows, logs, conversations, turns, completions = [] }) => async (sql, params) => {
  seen.push({ sql, params });
  if (sql.includes("op.dispatch")) return rows;
  if (sql.includes("codex.tool_result")) return logs;
  if (sql.includes("{turnIds:Array(String)}")) return conversations;
  if (sql.includes("GROUP BY turn_id")) return turns.filter(t => params.conversationIds.includes(t.conversation_id));
  if (sql.includes("otel_logs")) return completions;
  throw new Error("unexpected SQL");
};

test("a legacy turn links its subagents through call logs with one turn read", async () => {
  const seen = [];
  const run = legacyRun(seen, { rows: legacyChain("t", 1, C1),
    logs: [{ call_id: "call_1", conversation: "root", at_ms: String(ms("2026-11-05T01:00:01Z")) }],
    conversations: [{ turn_id: C1, conversation: "sub1" }],
    turns: [turn("root", P, "2026-11-05T01:00:00Z"), turn("sub1", C1, "2026-11-05T01:00:02Z")],
    completions: [completion("sub1", "2026-11-05T01:00:05Z")] });
  const turnInfo = { turnId: P, startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:00:10Z"), traceIds: ["t"] };
  const out = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  assert.deepEqual(out.children.map(c => [c.id, c.depth, c.tool]), [[`codex:sub1:${C1}`, 1, "followup_task"]]);
  assert.deepEqual([out.spawn_calls, out.unlinked_calls, out.subagents], [1, 0, 1]);
  assert.ok(Math.abs(out.children[0].cost_usd - unitCost) < 1e-12);
  const turnReads = seen.filter(s => s.sql.includes("GROUP BY turn_id") && !s.sql.includes("{turnIds"));
  assert.equal(turnReads.length, 1);
  assert.deepEqual(turnReads[0].params.conversationIds, ["root", "sub1"]);
  assert.deepEqual(seen.find(s => s.sql.includes("codex.tool_result")).params.callIds, ["call_1"]);
  assert.ok(seen.every(s => s.params.userExact === "kim@x.com"));
});

test("a legacy call with no running turn of its conversation leaves the result incomplete", async () => {
  const run = legacyRun([], { rows: legacyChain("t", 1, C1),
    logs: [{ call_id: "call_1", conversation: "root", at_ms: String(ms("2026-11-05T09:00:00Z")) }],
    conversations: [{ turn_id: C1, conversation: "sub1" }],
    turns: [turn("root", P, "2026-11-05T01:00:00Z"), turn("sub1", C1, "2026-11-05T01:00:02Z")] });
  const turnInfo = { turnId: P, startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:00:10Z"), traceIds: ["t"] };
  const out = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  // The call belongs to no known turn, so it is not this turn's call; the result says it is incomplete.
  assert.deepEqual([out.children.length, out.spawn_calls, out.unlinked_calls, agentCount(out)], [0, 0, 0, null]);
  assert.deepEqual([out.limited, out.total.cost_partial], [true, true]);
});

test("a legacy subagent turn gets its parent link from its call log", async () => {
  const run = legacyRun([], { rows: legacyChain("t", 1, C1),
    logs: [{ call_id: "call_1", conversation: "root", at_ms: String(ms("2026-11-05T01:00:01Z")) }],
    conversations: [{ turn_id: C1, conversation: "sub1" }],
    turns: [turn("root", P, "2026-11-05T01:00:00Z"), turn("sub1", C1, "2026-11-05T01:00:02Z")] });
  const task = { id: `codex:sub1:${C1}`, llm_calls: 2, cost_usd: 1, cost_partial: false };
  const turnInfo = { turnId: C1, startMs: ms("2026-11-05T01:00:02Z"), endMs: ms("2026-11-05T01:00:12Z"), traceIds: ["t"] };
  const out = await codexAgents("kim@x.com", turnInfo, task, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  assert.deepEqual([out.parent.id, out.parent.tool, out.parent.started_at], [`codex:root:${P}`, "followup_task", "2026-11-05T01:00:00Z"]);
  assert.deepEqual([out.children.length, out.spawn_calls], [0, 0]);
});

test("a 0.166 detail issues no legacy reads", async () => {
  const seen = [];
  const run = legacyRun(seen, { rows: chain("t", 1, P, C1, "sub1"), logs: [], conversations: [],
    turns: [turn("sub1", C1, "2026-11-05T01:00:00Z")] });
  const turnInfo = { turnId: P, startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:00:10Z"), traceIds: ["t"] };
  const out = await codexAgents("kim@x.com", turnInfo, rootTask, ["g1"], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  assert.equal(out.children.length, 1);
  assert.ok(!seen.some(s => s.sql.includes("codex.tool_result") || s.sql.includes("{turnIds:Array(String)}")));
  assert.equal(seen.filter(s => s.sql.includes("GROUP BY turn_id")).length, 1);
});

test("subagent turn and completion reads cover the lineage window, not the whole page range", async () => {
  const seen = [];
  const run = legacyRun(seen, { rows: chain("t", 1, P, C1, "sub1"), logs: [], conversations: [],
    turns: [turn("sub1", C1, "2026-11-05T01:00:00Z")] });
  const turnInfo = { turnId: P, startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:00:10Z"), traceIds: ["t"] };
  const wide = { from: new Date("2026-10-06T00:00:00Z"), to: new Date("2026-11-06T00:00:00Z") };
  await codexAgents("kim@x.com", turnInfo, rootTask, [], { ...wide, run, prices: DEFAULT_CODEX_PRICING });
  const turns = seen.find(s => s.sql.includes("GROUP BY turn_id"));
  assert.deepEqual([turns.params.spanFrom, turns.params.spanTo], ["2026-11-04 00:50:00", "2026-11-07 01:00:10"]);
  const completions = seen.find(s => s.sql.includes("otel_logs"));
  assert.deepEqual([completions.params.logFrom, completions.params.logTo], ["2026-11-05 00:50:00", "2026-11-07 01:00:10"]);
});

test("a subagent turn ending within a day of the reads' bound has partial calls and cost and limits the result", async () => {
  // Reads end 24h after the lineage window (the task's end + 24h): 2026-11-07 01:00:10.
  const readTo = ms("2026-11-07T01:00:10Z");
  const fold = async (endMs) => {
    const run = legacyRun([], { rows: chain("t", 1, P, C1, "sub1"), logs: [], conversations: [],
      turns: [turn("sub1", C1, "2026-11-05T01:00:02Z", { end_ms: String(endMs) })],
      completions: [completion("sub1", "2026-11-05T01:00:05Z")] });
    const turnInfo = { turnId: P, startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:00:10Z"), traceIds: ["t"] };
    return codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  };
  const clipped = await fold(readTo - 10000);
  assert.deepEqual([clipped.children[0].llm_calls, clipped.children[0].llm_calls_partial, clipped.children[0].cost_partial],
    [2, true, true]);
  assert.deepEqual([clipped.limited, clipped.total.llm_calls_partial, clipped.total.cost_partial], [true, true, true]);
  // A subagent turn that ended a day before the bound was read whole.
  const whole = await fold(readTo - 24 * 3600000 - 1);
  assert.deepEqual([whole.children[0].llm_calls_partial, whole.children[0].cost_partial, whole.limited], [false, false, false]);
});

test("only the subagent turn ending near the reads' bound is partial; its siblings stay whole", () => {
  const readToMs = ms("2026-11-07T01:00:10Z");
  const entry = (conversation, turnId, endMs) => ({ turn: turn(conversation, turnId, "2026-11-05T01:00:02Z", { end_ms: String(endMs) }),
    linked: [] });
  const out = foldAgents({ task: rootTask, spawnSpanIds: [], readToMs,
    links: [link(P, C1, "sub1", { depth: 1 }), link(P, C2, "sub2", { depth: 1 })],
    entries: [entry("sub1", C1, readToMs - 10000), entry("sub2", C2, ms("2026-11-05T01:00:20Z"))] });
  const flags = Object.fromEntries(out.children.map(c => [c.id, [c.llm_calls_partial, c.cost_partial]]));
  assert.deepEqual(flags, { [`codex:sub1:${C1}`]: [true, true], [`codex:sub2:${C2}`]: [false, false] });
  assert.deepEqual([out.limited, out.total.llm_calls_partial, out.total.cost_partial], [true, true, true]);
  // A result limited for another reason still marks every child partial.
  const other = foldAgents({ task: rootTask, spawnSpanIds: [], readToMs, limited: true,
    links: [link(P, C2, "sub2", { depth: 1 })], entries: [entry("sub2", C2, ms("2026-11-05T01:00:20Z"))] });
  assert.deepEqual([other.children[0].llm_calls_partial, other.children[0].cost_partial], [true, true]);
});

// The Codex CLI's multi_agent_v1 tools start a subagent turn through turn input:
//   multi_agent_v1<tool> <- dispatch_tool_call_with_state <- op.dispatch.turn_input
//   <- codex.turn_input (child conversation and turn) <- session_task.turn
const turnInputChain = (trace, tag, parentTurn, child, conv, { tool = "multi_agent_v1spawn_agent", at = "0" } = {}) => [
  span(trace, `g${tag}`, "x", tool, { turn: parentTurn, conversation: "root" }),
  span(trace, `d${tag}`, `g${tag}`, "dispatch_tool_call_with_state"),
  span(trace, `o${tag}`, `d${tag}`, "op.dispatch.turn_input"),
  span(trace, `t${tag}`, `o${tag}`, "codex.turn_input", { turn: child, conversation: conv }),
  span(trace, `c${tag}`, `t${tag}`, "session_task.turn", { turn: child, start_ms: at }),
];

test("lineage reads the multi_agent_v1 tools and the turn-input chain", () => {
  const { sql } = codexLineageSql("kim@x.com", ["t1"], ms("2026-11-05T01:00:00Z"), ms("2026-11-05T02:00:00Z"));
  for (const name of ["op.dispatch.turn_input", "codex.turn_input"]) assert.ok(sql.includes(`'${name}'`), name);
  assert.ok(sql.includes("startsWith(SpanName, 'multi_agent_v1')"));
});

test("the walk links multi_agent_v1 spawn and send_input turns through turn input", () => {
  const rows = [...turnInputChain("t", 1, P, C1, "sub1", { at: "1" }),
    ...turnInputChain("t", 2, P, C2, "sub1", { tool: "multi_agent_v1send_input", at: "2" }),
    // A send_input that only queued input starts no turn: no link.
    span("t", "g3", "x", "multi_agent_v1send_input", { turn: P, conversation: "root" })];
  const { links } = walkLineage(rows, P);
  assert.deepEqual(links.map(l => [l.child_turn, l.child_conversation, l.tool_span]),
    [[C1, "sub1", "multi_agent_v1spawn_agent"], [C2, "sub1", "multi_agent_v1send_input"]]);
  const folded = foldAgents({ task: rootTask, links: links.map(l => ({ ...l, depth: 1 })), spawnSpanIds: ["g1"] });
  assert.deepEqual(folded.children.map(c => c.tool), ["spawn_agent", "send_input"]);
  assert.deepEqual([folded.spawn_calls, folded.unlinked_calls], [1, 0]);
});

test("legacy multi_agent_v1 calls are resolved by call id like collaboration calls", () => {
  const rows = [
    span("t", "g1", "x", "multi_agent_v1spawn_agent", { call_id: "exec-1" }),
    span("t", "d1", "g1", "dispatch_tool_call_with_state"),
    span("t", "o1", "d1", "op.dispatch.turn_input"),
    span("t", "t1", "o1", "codex.turn_input"),
    span("t", "c1", "t1", "session_task.turn", { turn: C1 }),
    span("t", "g2", "x", "multi_agent_v1send_input", { call_id: "exec-2" }),
  ];
  assert.deepEqual(legacyNeeds(rows), { callIds: ["exec-1", "exec-2"], childTurns: [C1] });
  const resolved = resolveLegacy(rows, [{ call_id: "exec-1", conversation: "root", at_ms: String(ms("2026-11-05T01:00:01Z")) }],
    [{ turn_id: C1, conversation: "sub1" }], [turn("root", P, "2026-11-05T01:00:00Z")]);
  assert.deepEqual(walkLineage(resolved.rows, P, resolved.conversations).links.map(l => [l.child_turn, l.child_conversation]),
    [[C1, "sub1"]]);
});

test("a 0.166 turn without spawn calls has a known zero", async () => {
  const known = foldAgents({ task: rootTask, spawnSpanIds: [], namesTurn: true });
  assert.equal(known.known_zero, true);
  assert.equal(agentCount(known), 0);
  const run = async () => [];
  const turnInfo = { turnId: P, startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:00:10Z"), traceIds: ["t"], namesTurn: true };
  const out = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  assert.deepEqual([out.known_zero, agentCount(out)], [true, 0]);
});

test("a legacy or truncated turn without links stays unknown", async () => {
  for (const args of [
    { spawnSpanIds: [], namesTurn: false },
    { spawnSpanIds: null, namesTurn: true },
    { spawnSpanIds: [], namesTurn: true, limited: true },
    { spawnSpanIds: ["s1"], namesTurn: true },
    { spawnSpanIds: [] }]) {
    const out = foldAgents({ task: rootTask, ...args });
    assert.deepEqual([out.known_zero, agentCount(out)], [false, null], JSON.stringify(args));
  }
  const run = async () => [];
  const turnInfo = { turnId: P, startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:00:10Z"), traceIds: ["t"], tracesPartial: true, namesTurn: true };
  const out = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  assert.deepEqual([out.known_zero, agentCount(out)], [false, null]);
});

const T0 = ms("2026-11-05T01:00:00Z"), T1 = ms("2026-11-05T01:00:10Z");
// A run() for a 0.166+ detail: lineage rows, then the subagent turns and completions.
const spanRun = (seen, { rows = [], turns = [], completions = [] }) => async (sql, params) => {
  seen.push({ sql, params });
  if (sql.includes("op.dispatch")) return rows;
  if (sql.includes("GROUP BY turn_id")) return turns.filter(t => params.conversationIds.includes(t.conversation_id));
  if (sql.includes("otel_logs")) return completions;
  throw new Error("unexpected SQL");
};
const spanTurn = { turnId: P, conversationId: "root", startMs: T0, endMs: T1, traceIds: ["t"], namesTurn: true };

test("an unlinked send_input call of the turn blocks a known zero", async () => {
  // send_input is no spawn call, but it may have started a subagent turn the traces did not link.
  const fold = foldAgents({ task: rootTask, spawnSpanIds: [], namesTurn: true, toolSpanIds: ["g9"] });
  assert.deepEqual([fold.known_zero, agentCount(fold)], [false, null]);
  const seen = [];
  const run = spanRun(seen, { rows: [span("t", "g9", "x", "multi_agent_v1send_input", { turn: P, conversation: "root" })] });
  const out = await codexAgents("kim@x.com", spanTurn, rootTask, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  assert.deepEqual([out.subagents, out.spawn_calls, out.known_zero, agentCount(out)], [0, 0, false, null]);
  // A send_input span of another turn does not block this turn's zero.
  const other = spanRun([], { rows: [span("t", "g9", "x", "multi_agent_v1send_input", { turn: C2, conversation: "other" })] });
  const zero = await codexAgents("kim@x.com", spanTurn, rootTask, [], { from, to, run: other, prices: DEFAULT_CODEX_PRICING });
  assert.deepEqual([zero.known_zero, agentCount(zero)], [true, 0]);
});

test("a traced parent without traced children is a known zero only from the turn's own spans", async () => {
  // P was started by C2 (traced); P itself has no spawn span, so its zero rests on span evidence.
  const rows = chain("t", 1, C2, P, "root", { parentConv: "up" });
  const seen = [];
  const run = spanRun(seen, { rows, turns: [turn("up", C2, "2026-11-05T00:59:00Z", { end_ms: String(ms("2026-11-05T01:30:00Z")) })] });
  const out = await codexAgents("kim@x.com", spanTurn, rootTask, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  assert.deepEqual([out.parent.id, out.parent.tool, out.children.length, out.known_zero, agentCount(out)],
    [`codex:up:${C2}`, "spawn_agent", 0, true, 0]);
  // The lineage read and the parent's turn read: nothing else is read.
  assert.equal(seen.length, 2);
  // A spawn span of the turn the traces did not link, or truncated spans, leave it unknown.
  for (const spawnSpanIds of [["g9"], null]) {
    const none = await codexAgents("kim@x.com", spanTurn, rootTask, spawnSpanIds, { from, to, run: spanRun([], { rows }), prices: DEFAULT_CODEX_PRICING });
    assert.deepEqual([none.known_zero, agentCount(none)], [false, null], JSON.stringify(spawnSpanIds));
  }
});

// A clock that jumps past the extra-read budget when a read matching `at` runs (no real sleeps).
const budgetRun = (inner, at) => {
  let t = 1000;
  const seen = [];
  const run = async (sql, params) => {
    seen.push(sql);
    const out = await inner(sql, params);
    if (at(sql)) t = 1000 + AGENT_EXTRA_BUDGET_MS;
    return out;
  };
  return { run, seen, now: () => t, detailStart: 1000 };
};
const isLineage = (sql) => sql.includes("op.dispatch");

test("the extra-read budget is 12 s from the detail's start", () => {
  assert.equal(AGENT_EXTRA_BUDGET_MS, 12000);
});

test("a budget spent before legacy resolution keeps the traced links without costs, limited", async () => {
  const rows = [...chain("t", 2, P, C2, "sub2"), ...legacyChain("t", 1, C1)];
  const inner = legacyRun([], { rows, logs: [{ call_id: "call_1", conversation: "root", at_ms: String(ms("2026-11-05T01:00:01Z")) }],
    conversations: [{ turn_id: C1, conversation: "sub1" }],
    turns: [turn("root", P, "2026-11-05T01:00:00Z"), turn("sub1", C1, "2026-11-05T01:00:02Z"), turn("sub2", C2, "2026-11-05T01:00:02Z")] });
  const b = budgetRun(inner, isLineage);
  const turnInfo = { turnId: P, conversationId: "root", startMs: T0, endMs: T1, traceIds: ["t"], namesTurn: true };
  const out = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run: b.run, prices: DEFAULT_CODEX_PRICING,
    detailStart: b.detailStart, now: b.now });
  assert.equal(b.seen.length, 1);
  assert.deepEqual(out.children.map(c => [c.id, c.cost_usd, c.cost_partial]), [[`codex:sub2:${C2}`, null, true]]);
  assert.deepEqual([out.limited, out.total.cost_partial, out.known_zero], [true, true, false]);
  // Spent after the call-log reads: no turn read, the legacy call stays unresolved.
  const mid = budgetRun(inner, (sql) => sql.includes("codex.tool_result"));
  const half = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run: mid.run, prices: DEFAULT_CODEX_PRICING,
    detailStart: mid.detailStart, now: mid.now });
  assert.equal(mid.seen.filter(s => s.includes("GROUP BY turn_id") && !s.includes("{turnIds")).length, 0);
  assert.deepEqual([half.children.map(c => c.id), half.limited, half.known_zero], [[`codex:sub2:${C2}`], true, false]);
});

test("a budget spent before pricing lists the links without costs, limited", async () => {
  const inner = legacyRun([], { rows: chain("t", 1, P, C1, "sub1"), logs: [], conversations: [],
    turns: [turn("sub1", C1, "2026-11-05T01:00:02Z")], completions: [completion("sub1", "2026-11-05T01:00:05Z")] });
  const b = budgetRun(inner, isLineage);
  const out = await codexAgents("kim@x.com", spanTurn, rootTask, ["g1"], { from, to, run: b.run, prices: DEFAULT_CODEX_PRICING,
    detailStart: b.detailStart, now: b.now });
  assert.equal(b.seen.length, 1);
  assert.deepEqual(out.children.map(c => [c.id, c.llm_calls, c.cost_usd, c.cost_partial]), [[`codex:sub1:${C1}`, null, null, true]]);
  assert.deepEqual([out.subagents, out.limited, out.total.cost_partial, out.unlinked_calls], [1, true, true, 0]);
});

test("a budget not spent leaves results and reads unchanged", async () => {
  const cases = [
    () => legacyRun([], { rows: [...chain("t", 2, P, C2, "sub2"), ...legacyChain("t", 1, C1)],
      logs: [{ call_id: "call_1", conversation: "root", at_ms: String(ms("2026-11-05T01:00:01Z")) }],
      conversations: [{ turn_id: C1, conversation: "sub1" }],
      turns: [turn("root", P, "2026-11-05T01:00:00Z"), turn("sub1", C1, "2026-11-05T01:00:02Z"), turn("sub2", C2, "2026-11-05T01:00:02Z")],
      completions: [completion("sub1", "2026-11-05T01:00:05Z")] }),
    () => spanRun([], { rows: chain("t", 1, P, C1, "sub1"), turns: [turn("sub1", C1, "2026-11-05T01:00:03Z")],
      completions: [completion("sub1", "2026-11-05T01:00:05Z")] }),
  ];
  for (const make of cases) {
    const plain = [], timed = [];
    const count = (seen, inner) => async (sql, params) => { seen.push(sql); return inner(sql, params); };
    const base = await codexAgents("kim@x.com", spanTurn, rootTask, [], { from, to, run: count(plain, make()), prices: DEFAULT_CODEX_PRICING });
    // Just under the budget at every read.
    const out = await codexAgents("kim@x.com", spanTurn, rootTask, [], { from, to, run: count(timed, make()), prices: DEFAULT_CODEX_PRICING,
      detailStart: 0, now: () => AGENT_EXTRA_BUDGET_MS - 1 });
    assert.deepEqual(out, base);
    assert.deepEqual(timed, plain);
    assert.ok(plain.length > 2);
  }
});


// Bound id arrays: ClickHouse rejects an HTTP form field over 128 KiB, so every id array a subagent
// read binds is chunked below the base's COST_ID_PARAM_BYTES and capped per kind at AGENT_ID_LIMIT.
const encodedBytes = (ids) => encodeURIComponent(JSON.stringify(ids)).length;
const longId = (prefix, i) => `${prefix}${String(i).padStart(5, "0")}_${"x".repeat(110)}`;

test("chunkIds splits ids below the form-field budget and keeps a small list whole", async () => {
  const { chunkIds, COST_ID_PARAM_BYTES } = await import("./taskTraces.js");
  assert.equal(typeof chunkIds, "function");
  const small = ["a", "b", "c"];
  assert.deepEqual(chunkIds(small), [small]);
  assert.deepEqual(chunkIds([]), []);
  const ids = Array.from({ length: 20000 }, (_, i) => `call_${i}_${"y".repeat(20)}`);
  const chunks = chunkIds(ids);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(encodedBytes(c) <= COST_ID_PARAM_BYTES);
  assert.deepEqual(chunks.flat(), ids);
});

test("a legacy call-id list over the form-field budget is read in chunks with the unchunked result", async () => {
  const { COST_ID_PARAM_BYTES } = await import("./taskTraces.js");
  const n = 1500;
  const calls = Array.from({ length: n }, (_, i) => span("t", `h${i}`, "x", "collaborationfollowup_task", { call_id: longId("call_", i) }));
  // call_Z sorts after every long id: its log is read by the last chunk.
  const rows = [...calls, ...legacyChain("t", "Z", C1)];
  const at = String(ms("2026-11-05T01:00:01Z"));
  const seen = [];
  const base = legacyRun(seen, { rows, logs: [], conversations: [{ turn_id: C1, conversation: "sub1" }],
    turns: [turn("root", P, "2026-11-05T01:00:00Z"), turn("sub1", C1, "2026-11-05T01:00:02Z")],
    completions: [completion("sub1", "2026-11-05T01:00:05Z")] });
  const run = async (sql, params) => sql.includes("codex.tool_result")
    ? (seen.push({ sql, params }), params.callIds.map((id) => ({ call_id: id, conversation: "root", at_ms: at })))
    : base(sql, params);
  const turnInfo = { turnId: P, startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:00:10Z"), traceIds: ["t"] };
  const out = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  const callReads = seen.filter(s => s.sql.includes("codex.tool_result"));
  assert.ok(callReads.length > 1, String(callReads.length));
  for (const s of callReads) assert.ok(encodedBytes(s.params.callIds) <= COST_ID_PARAM_BYTES);
  assert.deepEqual(callReads.flatMap(s => s.params.callIds), [...calls.map(c => c.call_id), "call_Z"].sort());
  assert.deepEqual(out.children.map(c => c.id), [`codex:sub1:${C1}`]);
  assert.deepEqual([out.limited, out.spawn_calls, out.unlinked_calls], [false, n + 1, n]);
  assert.equal(seen.filter(s => s.sql.includes("GROUP BY turn_id") && !s.sql.includes("{turnIds")).length, 1);
});

test("legacy call ids over AGENT_ID_LIMIT are capped, each chunk under the budget, and the result limited", async () => {
  const { AGENT_ID_LIMIT } = await import("./codexAgents.js");
  const { COST_ID_PARAM_BYTES } = await import("./taskTraces.js");
  assert.ok(Number.isSafeInteger(AGENT_ID_LIMIT));
  const rows = Array.from({ length: 20000 }, (_, i) => span("t", `h${i}`, "x", "collaborationfollowup_task", { call_id: longId("call_", i) }));
  const seen = [];
  const run = legacyRun(seen, { rows, logs: [], conversations: [], turns: [] });
  const turnInfo = { turnId: P, startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:00:10Z"), traceIds: ["t"] };
  const out = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  const callReads = seen.filter(s => s.sql.includes("codex.tool_result"));
  assert.ok(callReads.length > 1 && callReads.length <= 4, String(callReads.length));
  for (const s of callReads) assert.ok(encodedBytes(s.params.callIds) <= COST_ID_PARAM_BYTES);
  assert.equal(callReads.flatMap(s => s.params.callIds).length, AGENT_ID_LIMIT);
  assert.deepEqual([out.limited, out.total.cost_partial, out.known_zero], [true, true, false]);
});

test("unnamed legacy child turns over AGENT_ID_LIMIT set limited; exactly the limit does not", async () => {
  const { AGENT_ID_LIMIT } = await import("./codexAgents.js");
  assert.ok(Number.isSafeInteger(AGENT_ID_LIMIT));
  // Subagent turns of another turn (not this one's links) whose run_turn names no conversation.
  const other = uuid(9999);
  const make = (n) => Array.from({ length: n }, (_, i) => [
    span("t", `g${i}`, "x", "collaborationspawn_agent", { turn: other, conversation: "elsewhere" }),
    span("t", `d${i}`, `g${i}`, "dispatch_tool_call_with_state"),
    span("t", `i${i}`, `d${i}`, "op.dispatch.inter_agent_communication"),
    span("t", `c${i}`, `i${i}`, "session_task.turn", { turn: uuid(20000 + i) }),
  ]).flat();
  const turnInfo = { turnId: P, startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:00:10Z"), traceIds: ["t"] };
  const outcome = async (n) => {
    const seen = [];
    const base = legacyRun(seen, { rows: make(n), logs: [], conversations: [], turns: [] });
    const out = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run: base, prices: DEFAULT_CODEX_PRICING });
    return { limited: out.limited, read: seen.filter(s => s.sql.includes("{turnIds")).flatMap(s => s.params.turnIds).length };
  };
  assert.deepEqual(await outcome(AGENT_ID_LIMIT), { limited: false, read: AGENT_ID_LIMIT });
  assert.deepEqual(await outcome(AGENT_ID_LIMIT + 1), { limited: true, read: AGENT_ID_LIMIT });
});

test("a budget spent after the first id chunk starts no further chunk, limited", async () => {
  const rows = Array.from({ length: 1500 }, (_, i) => span("t", `h${i}`, "x", "collaborationfollowup_task", { call_id: longId("call_", i) }));
  const inner = legacyRun([], { rows, logs: [], conversations: [], turns: [] });
  const b = budgetRun(inner, (sql) => sql.includes("codex.tool_result"));
  const turnInfo = { turnId: P, startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:00:10Z"), traceIds: ["t"] };
  const out = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run: b.run, prices: DEFAULT_CODEX_PRICING,
    detailStart: b.detailStart, now: b.now });
  assert.equal(b.seen.filter(s => s.includes("codex.tool_result")).length, 1);
  assert.deepEqual([out.limited, out.known_zero], [true, false]);
});


test("the legacy turn read covers many long conversation ids in chunks", async () => {
  const { COST_ID_PARAM_BYTES } = await import("./taskTraces.js");
  // run_turn spans naming 1000 long conversations join the legacy turn read's candidates.
  const named = Array.from({ length: 1000 }, (_, i) => span("t", `n${i}`, "x", "run_turn", { turn: uuid(30000 + i), conversation: longId("conv", i) }));
  const seen = [];
  const run = legacyRun(seen, { rows: [...legacyChain("t", 1, C1), ...named],
    logs: [{ call_id: "call_1", conversation: "root", at_ms: String(ms("2026-11-05T01:00:01Z")) }],
    conversations: [{ turn_id: C1, conversation: "sub1" }],
    turns: [turn("root", P, "2026-11-05T01:00:00Z"), turn("sub1", C1, "2026-11-05T01:00:02Z")],
    completions: [completion("sub1", "2026-11-05T01:00:05Z")] });
  const turnInfo = { turnId: P, conversationId: "root", startMs: T0, endMs: T1, traceIds: ["t"] };
  const out = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  const turnReads = seen.filter(s => s.sql.includes("GROUP BY turn_id") && !s.sql.includes("{turnIds"));
  assert.ok(turnReads.length > 1, String(turnReads.length));
  for (const s of turnReads) assert.ok(encodedBytes(s.params.conversationIds) <= COST_ID_PARAM_BYTES);
  assert.deepEqual(turnReads.flatMap(s => s.params.conversationIds).sort(), ["root", "sub1", ...named.map(r => r.conversation)].sort());
  assert.deepEqual([out.children.map(c => c.id), out.limited], [[`codex:sub1:${C1}`], false]);
  assert.ok(Math.abs(out.children[0].cost_usd - unitCost) < 1e-12);
});
