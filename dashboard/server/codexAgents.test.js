import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_DEPTH, AGENT_LIMIT, LINEAGE_SPAN_LIMIT, SPAWN_SPANS, agentCount, codexLineageSql, codexAgents, foldAgents,
  walkLineage } from "./codexAgents.js";
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
  assert.deepEqual(out.parent, { id: `codex:up:${uuid(9)}`, tool: "spawn_agent" });
  // Ids that are not identifier-shaped are not linked.
  assert.equal(foldAgents({ task: rootTask, parent: link(uuid(9), P, "x", { parent_conversation: "a b" }) }).parent, null);
});

test("zero linked subagents is unknown, not zero", () => {
  const out = foldAgents({ task: rootTask, spawnSpanIds: [] });
  assert.equal(out.subagents, 0);
  assert.equal(agentCount(out), null);
  assert.equal(agentCount({ subagents: 2 }), 2);
  assert.deepEqual(SPAWN_SPANS, ["collaborationspawn_agent", "collaborationfollowup_task"]);
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
