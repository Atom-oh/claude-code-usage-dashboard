// Codex subagent lineage for a task detail. Codex runs a subagent as its own conversation,
// but the subagent's turn is traced under the parent turn's tool call, in the same TraceId:
//   session_task.turn (subagent turn)
//     <- op.dispatch.inter_agent_communication
//     <- dispatch_tool_call_with_state
//     <- collaboration<tool> (spawn_agent, followup_task, ...: carries the parent's
//        conversation.id and turn.id)
// The subagent turn's run_turn span carries its conversation.id. No span or log attribute
// names the parent, so the link is that parent-span chain. It exists only when the traces were
// collected (Codex trace export, versions emitting collaboration spans): a missing link is
// unknown, never "no subagents". Calls and costs come from the subagents' own completion logs,
// linked exactly like the task list; traces only establish the lineage.
import { toChDateTime } from "./clickhouse.js";
import { EXACT_USER, SPAN_SLACK_MS, CODEX_TURN_LIMIT, CODEX_COMPLETION_LIMIT, TURN_ID, count,
  codexTurnSql, codexCompletionSql, linkCompletions, foldCodexTask } from "./taskTraces.js";

// Subagent levels followed below the task's turn, and subagent turns returned in all.
export const AGENT_DEPTH = 3;
export const AGENT_LIMIT = 50;
// Traces of the task's spans read, and lineage spans read from them.
export const LINEAGE_TRACE_LIMIT = 200;
export const LINEAGE_SPAN_LIMIT = 50000;
// A parent's tool span precedes the subagent turn it starts by well under a second (observed
// at most 260 ms); the window opens this far before the task's turn to include it.
export const LINEAGE_LEAD_MS = 10 * 60 * 1000;
// Tool spans that start a subagent turn; their count is the denominator for unlinked calls.
export const SPAWN_SPANS = ["collaborationspawn_agent", "collaborationfollowup_task"];

const CHAIN = ["session_task.turn", "op.dispatch.inter_agent_communication", "dispatch_tool_call_with_state", "run_turn"];
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOOL = /^collaboration([a-z][a-z0-9_]{0,63})$/;

// The lineage spans of the task's traces, from just before its turn to a day after it ends
// (subagents can outlive the turn that started them). Only names, ids and the two identity
// attributes leave the database.
export function codexLineageSql(owner, traceIds, startMs, endMs) {
  return {
    sql: `SELECT TraceId AS trace_id, SpanId AS span_id, ParentSpanId AS parent_id, SpanName AS name,
    SpanAttributes['conversation.id'] AS conversation,
    coalesce(nullIf(SpanAttributes['turn_id'], ''), SpanAttributes['turn.id']) AS turn,
    toString(toUnixTimestamp64Milli(Timestamp)) AS start_ms
FROM claude_code.otel_traces
PREWHERE Timestamp >= {spanFrom:DateTime} AND Timestamp < {spanTo:DateTime}
  AND ${EXACT_USER}
WHERE ResourceAttributes['client'] = 'codex'
  AND TraceId IN {traceIds:Array(String)}
  AND (SpanName IN (${CHAIN.map((n) => `'${n}'`).join(", ")}) OR startsWith(SpanName, 'collaboration'))
LIMIT 1 BY TraceId, SpanId
LIMIT ${LINEAGE_SPAN_LIMIT + 1}`,
    params: { spanFrom: toChDateTime(new Date(startMs - LINEAGE_LEAD_MS)),
      spanTo: toChDateTime(new Date(endMs + SPAN_SLACK_MS)), userExact: owner, traceIds },
  };
}

const toolName = (span) => TOOL.exec(span ?? "")?.[1] ?? null;
const taskId = (conversation, turn) => IDENT.test(conversation ?? "") && TURN_ID.test(turn ?? "")
  ? `codex:${conversation}:${turn}` : null;

// Pure walk over lineage rows: the task turn's parent link, and its subagent turns breadth
// first (AGENT_DEPTH levels, AGENT_LIMIT turns). Links: { parent_turn, parent_conversation,
// tool_span, tool_span_id, child_turn, child_conversation, child_start_ms, depth }.
export function walkLineage(rows, turnId) {
  const key = (trace, span) => `${trace}/${span}`;
  const byId = new Map(rows.map((r) => [key(r.trace_id, r.span_id), r]));
  const parentOf = (r, name) => {
    const p = r.parent_id ? byId.get(key(r.trace_id, r.parent_id)) : null;
    return p && (name === "collaboration" ? p.name.startsWith("collaboration") && p.turn : p.name === name) ? p : null;
  };
  const conversationOf = new Map();
  for (const r of rows) if (r.name === "run_turn" && r.turn && r.conversation && !conversationOf.has(r.turn))
    conversationOf.set(r.turn, r.conversation);
  // Each subagent turn span with its complete chain to a collaboration tool span.
  const edges = [];
  for (const c of rows) {
    if (c.name !== "session_task.turn" || !c.turn) continue;
    const i = parentOf(c, "op.dispatch.inter_agent_communication");
    const d = i && parentOf(i, "dispatch_tool_call_with_state");
    const g = d && parentOf(d, "collaboration");
    if (!g || g.turn === c.turn) continue;
    edges.push({ parent_turn: g.turn, parent_conversation: g.conversation, tool_span: g.name, tool_span_id: g.span_id,
      child_turn: c.turn, child_conversation: conversationOf.get(c.turn) ?? "", child_start_ms: count(c.start_ms) });
  }
  edges.sort((a, b) => (a.child_start_ms ?? 0) - (b.child_start_ms ?? 0) || a.child_turn.localeCompare(b.child_turn));
  const parent = edges.find((e) => e.child_turn === turnId) ?? null;
  const links = [], seen = new Set([turnId]);
  let frontier = new Set([turnId]), depth = 0, limited = false;
  while (frontier.size && depth < AGENT_DEPTH && !limited) {
    depth += 1;
    const next = new Set();
    for (const e of edges) {
      if (!frontier.has(e.parent_turn) || seen.has(e.child_turn) || !TURN_ID.test(e.child_turn)) continue;
      if (links.length >= AGENT_LIMIT) { limited = true; break; }
      seen.add(e.child_turn);
      links.push({ ...e, depth });
      next.add(e.child_turn);
    }
    frontier = next;
  }
  // Subagents below the last level followed are not read: their presence is unknown.
  if (frontier.size && depth >= AGENT_DEPTH && edges.some((e) => frontier.has(e.parent_turn))) limited = true;
  return { parent, links, limited };
}

// Summed known values with a partial flag; all unknown is null.
function knownSum(values) {
  const known = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  return { value: known.length ? known.reduce((a, b) => a + b, 0) : null, partial: known.length < values.length };
}

// Pure fold. links: walkLineage links; entries: linkCompletions entries of the subagent
// conversations; task: the detail's own folded task; spawnSpanIds: the task's own SPAWN_SPANS
// span ids (null when the detail's spans were truncated).
export function foldAgents({ task, parent = null, links = [], entries = [], limited = false, spawnSpanIds = null }) {
  const parentId = parent ? taskId(parent.parent_conversation, parent.parent_turn) : null;
  const byTurn = new Map(entries.map((e) => [e.turn.turn_id, e]));
  const idOfTurn = new Map(links.map((l) => [l.child_turn, taskId(l.child_conversation, l.child_turn)]));
  const children = links.map((l) => {
    const entry = byTurn.get(l.child_turn);
    const folded = entry && entry.turn.conversation_id === l.child_conversation ? foldCodexTask(entry.turn, entry.linked) : null;
    return {
      id: idOfTurn.get(l.child_turn) ?? null,
      parent_id: l.depth === 1 ? task.id : idOfTurn.get(l.parent_turn) ?? null,
      depth: l.depth,
      tool: toolName(l.tool_span),
      started_at: folded?.started_at ?? null,
      duration_ms: folded?.duration_ms ?? null,
      models: folded?.models ?? [],
      llm_calls: folded ? folded.llm_calls : null,
      cost_usd: folded ? folded.cost_usd : null,
      cost_partial: folded ? folded.cost_partial || limited : true,
    };
  });
  // Tree order: each subagent turn directly followed by its own subagent turns (siblings keep
  // their start order), so an indented row always sits under the turn that started it.
  const kids = new Map();
  for (const c of children) kids.set(c.parent_id, [...(kids.get(c.parent_id) ?? []), c]);
  const ordered = [];
  const visit = (id) => { for (const c of kids.get(id) ?? []) { ordered.push(c); if (c.id) visit(c.id); } };
  visit(task.id);
  // Rows whose parent id is unknown (no identifier) keep their place at the end.
  for (const c of children) if (!ordered.includes(c)) ordered.push(c);
  const conversations = new Set(links.map((l) => l.child_conversation).filter(Boolean));
  const calls = knownSum([task.llm_calls, ...children.map((c) => c.llm_calls)]);
  const cost = knownSum([task.cost_usd, ...children.map((c) => c.cost_usd)]);
  const linkedSpawns = new Set(links.filter((l) => l.depth === 1).map((l) => l.tool_span_id));
  return {
    parent: parentId ? { id: parentId, tool: toolName(parent.tool_span) } : null,
    children: ordered,
    subagents: conversations.size,
    // Spawn/follow-up calls of this turn whose subagent turn was not found in the traces.
    spawn_calls: spawnSpanIds === null ? null : spawnSpanIds.length,
    unlinked_calls: spawnSpanIds === null ? null : spawnSpanIds.filter((id) => !linkedSpawns.has(id)).length,
    limited,
    total: { llm_calls: calls.value, llm_calls_partial: calls.partial || limited,
      cost_usd: cost.value, cost_partial: cost.partial || limited || Boolean(task.cost_partial)
        || children.some((c) => c.cost_partial) },
  };
}

// turn: { turnId, startMs, endMs, traceIds, tracesPartial } of the detail's own turn and spans.
// One lineage read over the turn's traces, then one turn and one completion read over every
// subagent conversation found.
export async function codexAgents(owner, turn, task, spawnSpanIds, { from, to, run, prices }) {
  const traceIds = turn.traceIds.slice(0, LINEAGE_TRACE_LIMIT);
  let limited = Boolean(turn.tracesPartial) || turn.traceIds.length > traceIds.length;
  if (!traceIds.length || turn.startMs === null || turn.endMs === null)
    return foldAgents({ task, limited, spawnSpanIds });
  const lineage = codexLineageSql(owner, traceIds, turn.startMs, turn.endMs);
  const rows = await run(lineage.sql, lineage.params);
  if (rows.length > LINEAGE_SPAN_LIMIT) limited = true;
  const walked = walkLineage(rows.slice(0, LINEAGE_SPAN_LIMIT), turn.turnId);
  limited ||= walked.limited;
  const conversationIds = [...new Set(walked.links.map((l) => l.child_conversation).filter((c) => IDENT.test(c ?? "")))];
  let entries = [];
  if (conversationIds.length) {
    const q = { userExact: owner };
    const turnsSql = codexTurnSql(from, to, q, { conversationIds });
    const completionsSql = codexCompletionSql(from, to, q, { conversationIds });
    const [turns, completions] = await Promise.all([run(turnsSql.sql, turnsSql.params),
      run(completionsSql.sql, completionsSql.params)]);
    if (turns.length > CODEX_TURN_LIMIT || completions.length > CODEX_COMPLETION_LIMIT) limited = true;
    entries = linkCompletions(turns.slice(0, CODEX_TURN_LIMIT), completions.slice(0, CODEX_COMPLETION_LIMIT),
      { prices }).entries;
  }
  return foldAgents({ task, parent: walked.parent, links: walked.links, entries, limited, spawnSpanIds });
}

// A linked count only: zero links are unknown (no trace, older Codex), never "no subagents".
export const agentCount = (agents) => (agents && agents.subagents > 0 ? agents.subagents : null);
