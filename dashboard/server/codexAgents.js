// Codex subagent lineage for a task detail. Codex runs a subagent as its own conversation,
// but the subagent's turn is traced under the parent turn's tool call, in the same TraceId:
//   session_task.turn (subagent turn)
//     <- op.dispatch.inter_agent_communication
//     <- dispatch_tool_call_with_state
//     <- collaboration<tool> (spawn_agent, followup_task, ...: carries the parent's
//        conversation.id and turn.id)
// The Codex CLI's multi_agent_v1<tool> spans (spawn_agent, send_input to an idle agent) start the
// turn through turn input instead:
//   session_task.turn <- codex.turn_input (the child's conversation.id and turn.id)
//     <- op.dispatch.turn_input <- dispatch_tool_call_with_state <- multi_agent_v1<tool>
// The subagent turn's run_turn span carries its conversation.id. No span or log attribute
// names the parent, so the link is that parent-span chain. It exists only when the traces were
// collected (Codex trace export, versions emitting collaboration spans): a missing link is
// unknown, never "no subagents". Calls are the subagent turns' model-call spans and costs their own
// completion logs, linked exactly like the task list; traces only establish the lineage.
// Codex before 0.166 puts no conversation.id or turn id on the collaboration<tool> and run_turn
// spans. Their tool span is resolved from its call_id: the codex.tool_result log of that call names
// the calling conversation, and the turn is that conversation's turn running at the call's time
// (a conversation runs one turn at a time). The child's conversation comes from its own turn spans.
import { toChDateTime } from "./clickhouse.js";
import { EXACT_USER, SPAN_SLACK_MS, CODEX_TURN_LIMIT, CODEX_COMPLETION_LIMIT, TURN_ID, TURN_SPAN, count,
  codexTurnSql, codexCompletionSql, linkCompletions, foldCodexTask } from "./taskTraces.js";

// Subagent levels followed below the task's turn, and subagent turns returned in all.
export const AGENT_DEPTH = 3;
export const AGENT_LIMIT = 50;
// Time from the detail's start after which no read beyond the lineage span read starts (legacy
// call-log, turn-conversation and turn reads, the communication fallback, and the subagent turn
// and completion reads that price the links). A detail loads within the dashboard's 25 s budget;
// the base Codex detail of the longest observed session takes about 20-22 s before any subagent
// read, so a detail past 12 s issues only the lineage read and returns its links unpriced and
// limited instead of exceeding the budget. A read batch started before the bound may run past it.
export const AGENT_EXTRA_BUDGET_MS = 12000;
// Traces of the task's spans read, and lineage spans read from them.
export const LINEAGE_TRACE_LIMIT = 200;
export const LINEAGE_SPAN_LIMIT = 50000;
// A parent's tool span precedes the subagent turn it starts by well under a second (observed
// at most 260 ms); the window opens this far before the task's turn to include it.
export const LINEAGE_LEAD_MS = 10 * 60 * 1000;
// Tool spans that start a subagent turn; their count is the denominator for unlinked calls.
export const SPAWN_SPANS = ["collaborationspawn_agent", "collaborationfollowup_task", "multi_agent_v1spawn_agent"];
// Tool spans that may start a subagent turn. send_input starts one only when the agent is idle,
// so it links when traced but is not a spawn call.
const LINK_TOOLS = [...SPAWN_SPANS, "multi_agent_v1send_input"];
const TOOL_PREFIXES = ["collaboration", "multi_agent_v1"];
const isTool = (name) => TOOL_PREFIXES.some((p) => (name ?? "").startsWith(p));
// A legacy call's log time may differ from its turn's span window by clock rounding.
export const LEGACY_CALL_SLACK_MS = 1000;

// The detail route serves a turn only from a range containing its start, so each link carries
// the UTC hour of its own target's start.
export const LINK_WINDOW_MS = 3600000;
export function linkWindow(startMs) {
  if (!Number.isFinite(startMs)) return null;
  const from = Math.floor(startMs / LINK_WINDOW_MS) * LINK_WINDOW_MS;
  return { from: new Date(from).toISOString(), to: new Date(from + LINK_WINDOW_MS).toISOString() };
}

const CHAIN = ["session_task.turn", "op.dispatch.inter_agent_communication", "op.dispatch.turn_input", "codex.turn_input",
  "dispatch_tool_call_with_state", "run_turn"];
// Spans naming a turn's conversation: run_turn, and codex.turn_input on the CLI path.
const NAMES_CONVERSATION = ["run_turn", "codex.turn_input"];
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOOL = /^(?:collaboration|multi_agent_v1)([a-z][a-z0-9_]{0,63})$/;
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;

const lineageWindow = (startMs, endMs) => ({ spanFrom: toChDateTime(new Date(startMs - LINEAGE_LEAD_MS)),
  spanTo: toChDateTime(new Date(endMs + SPAN_SLACK_MS)) });

// The lineage spans of the task's traces, from just before its turn to a day after it ends
// (subagents can outlive the turn that started them). Only names, ids and the two identity
// attributes leave the database.
export function codexLineageSql(owner, traceIds, startMs, endMs) {
  return {
    sql: `SELECT TraceId AS trace_id, SpanId AS span_id, ParentSpanId AS parent_id, SpanName AS name,
    SpanAttributes['conversation.id'] AS conversation,
    coalesce(nullIf(SpanAttributes['turn_id'], ''), SpanAttributes['turn.id']) AS turn,
    SpanAttributes['call_id'] AS call_id,
    toString(toUnixTimestamp64Milli(Timestamp)) AS start_ms
FROM claude_code.otel_traces
PREWHERE Timestamp >= {spanFrom:DateTime} AND Timestamp < {spanTo:DateTime}
  AND ${EXACT_USER}
WHERE ResourceAttributes['client'] = 'codex'
  AND TraceId IN {traceIds:Array(String)}
  AND (SpanName IN (${CHAIN.map((n) => `'${n}'`).join(", ")}) OR ${TOOL_PREFIXES.map((p) => `startsWith(SpanName, '${p}')`).join(" OR ")})
LIMIT 1 BY TraceId, SpanId
LIMIT ${LINEAGE_SPAN_LIMIT + 1}`,
    params: { ...lineageWindow(startMs, endMs), userExact: owner, traceIds },
  };
}

// What a lineage read still needs when Codex (before 0.166) left ids off its spans: the call ids of
// spawn/follow-up spans without a turn, and the subagent turns whose run_turn names no conversation.
export function legacyNeeds(rows) {
  const callIds = new Set(), named = new Set(), childTurns = new Set();
  const byId = new Map(rows.map((r) => [`${r.trace_id}/${r.span_id}`, r]));
  for (const r of rows) {
    if (LINK_TOOLS.includes(r.name) && !r.turn && CALL_ID.test(r.call_id ?? "")) callIds.add(r.call_id);
    if (NAMES_CONVERSATION.includes(r.name) && r.turn && r.conversation) named.add(r.turn);
  }
  for (const r of rows) {
    const p = r.parent_id ? byId.get(`${r.trace_id}/${r.parent_id}`) : null;
    if (r.name === "session_task.turn" && TURN_ID.test(r.turn ?? "") && !named.has(r.turn)
      && ["op.dispatch.inter_agent_communication", "codex.turn_input"].includes(p?.name)) childTurns.add(r.turn);
  }
  return { callIds: [...callIds].sort(), childTurns: [...childTurns].sort() };
}

// The calling conversation of each legacy call: its codex.tool_result log. Time is the source
// event.timestamp, else the collector Timestamp.
export function codexCallLogSql(owner, callIds, startMs, endMs) {
  return {
    sql: `SELECT LogAttributes['call_id'] AS call_id, LogAttributes['conversation.id'] AS conversation,
    toString(toUnixTimestamp64Milli(coalesce(parseDateTime64BestEffortOrNull(LogAttributes['event.timestamp'], 3),
      toDateTime64(Timestamp, 3)))) AS at_ms
FROM claude_code.otel_logs
PREWHERE Timestamp >= {spanFrom:DateTime} AND Timestamp < {spanTo:DateTime}
  AND EventName = 'codex.tool_result'
  AND ${EXACT_USER}
WHERE ResourceAttributes['client'] = 'codex'
  AND LogAttributes['event.name'] = 'codex.tool_result'
  AND LogAttributes['call_id'] IN {callIds:Array(String)}
  AND LogAttributes['conversation.id'] != ''
  AND coalesce(nullIf(ResourceAttributes['user.email'], ''), nullIf(ResourceAttributes['enduser.id'], ''), '') = {userExact:String}
ORDER BY Timestamp
LIMIT 1 BY call_id`,
    params: { ...lineageWindow(startMs, endMs), userExact: owner, callIds },
  };
}

// The conversation of each legacy subagent turn, from its own turn spans that carry one.
export function codexTurnConversationSql(owner, turnIds, startMs, endMs) {
  return {
    sql: `SELECT turn_id, any(conversation) AS conversation
FROM (
    SELECT coalesce(nullIf(SpanAttributes['turn_id'], ''), SpanAttributes['turn.id']) AS turn_id,
        SpanAttributes['conversation.id'] AS conversation
    FROM claude_code.otel_traces
    PREWHERE Timestamp >= {spanFrom:DateTime} AND Timestamp < {spanTo:DateTime}
      AND ${EXACT_USER}
    WHERE ResourceAttributes['client'] = 'codex'
      AND ${TURN_SPAN}
      AND SpanAttributes['conversation.id'] != ''
)
WHERE turn_id IN {turnIds:Array(String)}
GROUP BY turn_id`,
    params: { ...lineageWindow(startMs, endMs), userExact: owner, turnIds },
  };
}

// The turn of `conversation` running at atMs (turn rows as codexTurnSql returns them): the latest
// one started by then, else (within the slack) the earliest. None is null: the call stays unlinked.
export function containingTurn(turns, conversation, atMs) {
  if (!Number.isFinite(atMs)) return null;
  const within = turns.filter((t) => t.conversation_id === conversation
    && count(t.start_ms) !== null && count(t.end_ms) !== null
    && count(t.start_ms) - LEGACY_CALL_SLACK_MS <= atMs && atMs <= count(t.end_ms) + LEGACY_CALL_SLACK_MS);
  const started = within.filter((t) => count(t.start_ms) <= atMs);
  const pick = (list, latest) => list.reduce((a, b) => (latest ? count(b.start_ms) > count(a.start_ms)
    : count(b.start_ms) < count(a.start_ms)) ? b : a);
  return started.length ? pick(started, true) : within.length ? pick(within, false) : null;
}

// Lineage rows with each legacy spawn/follow-up span given its calling conversation and turn, plus
// the legacy subagent turns' conversations. Input rows are not changed.
export function resolveLegacy(rows, callLogs, turnConversations, turns) {
  const logs = new Map(callLogs.filter((l) => CALL_ID.test(l.call_id ?? "") && IDENT.test(l.conversation ?? ""))
    .map((l) => [l.call_id, l]));
  const resolved = rows.map((r) => {
    const log = LINK_TOOLS.includes(r.name) && !r.turn ? logs.get(r.call_id) : null;
    const owner = log ? containingTurn(turns, log.conversation, count(log.at_ms)) : null;
    return owner ? { ...r, turn: owner.turn_id, conversation: log.conversation } : r;
  });
  const conversations = new Map(turnConversations
    .filter((t) => TURN_ID.test(t.turn_id ?? "") && IDENT.test(t.conversation ?? ""))
    .map((t) => [t.turn_id, t.conversation]));
  return { rows: resolved, conversations };
}

// A log-linked edge has no tool span: its tool_span is `communication:<kind>`.
const COMMUNICATION = /^communication:(spawn|followup)$/;
const toolName = (span) => TOOL.exec(span ?? "")?.[1] ?? COMMUNICATION.exec(span ?? "")?.[1] ?? null;
const taskId = (conversation, turn) => IDENT.test(conversation ?? "") && TURN_ID.test(turn ?? "")
  ? `codex:${conversation}:${turn}` : null;

// Pure walk over lineage rows: the task turn's parent link, and its subagent turns breadth
// first (AGENT_DEPTH levels, AGENT_LIMIT turns). Links: { parent_turn, parent_conversation,
// tool_span, tool_span_id, child_turn, child_conversation, child_start_ms, depth }. `conversations`
// (turn id -> conversation) names a child turn's conversation when no run_turn span does.
export function walkLineage(rows, turnId, conversations = new Map()) {
  const key = (trace, span) => `${trace}/${span}`;
  const byId = new Map(rows.map((r) => [key(r.trace_id, r.span_id), r]));
  const parentOf = (r, name) => {
    const p = r.parent_id ? byId.get(key(r.trace_id, r.parent_id)) : null;
    return p && (name === "tool" ? isTool(p.name) && p.turn : p.name === name) ? p : null;
  };
  // The dispatch op above a subagent turn: inter-agent communication, or turn input (via codex.turn_input).
  const dispatchOf = (c) => parentOf(c, "op.dispatch.inter_agent_communication")
    ?? (() => { const t = parentOf(c, "codex.turn_input"); return t && parentOf(t, "op.dispatch.turn_input"); })();
  const conversationOf = new Map();
  for (const r of rows) if (NAMES_CONVERSATION.includes(r.name) && r.turn && r.conversation && !conversationOf.has(r.turn))
    conversationOf.set(r.turn, r.conversation);
  // Each subagent turn span with its complete chain to a tool span.
  const edges = [];
  for (const c of rows) {
    if (c.name !== "session_task.turn" || !c.turn) continue;
    const i = dispatchOf(c);
    const d = i && parentOf(i, "dispatch_tool_call_with_state");
    const g = d && parentOf(d, "tool");
    if (!g || g.turn === c.turn) continue;
    edges.push({ parent_turn: g.turn, parent_conversation: g.conversation, tool_span: g.name, tool_span_id: g.span_id,
      child_turn: c.turn, child_conversation: conversationOf.get(c.turn) ?? conversations.get(c.turn) ?? "", child_start_ms: count(c.start_ms) });
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

// Codex 0.167.1 and later log codex.agent_communication when a thread sends to another (thread ids
// are conversation ids). Without traces it is the only lineage: a spawn/followup send starts the
// receiver's next turn within this long.
export const COMMUNICATION_CHILD_MS = 60000;
export const COMMUNICATION_LIMIT = 1000;

// The spawn/follow-up sends to or from `conversationId` around the turn's window. A send is a log
// row of the owner; only kind, the two thread ids and the time leave the database.
export function codexCommunicationSql(owner, conversationId, startMs, endMs) {
  return {
    sql: `SELECT LogAttributes['kind'] AS kind, LogAttributes['sender_thread_id'] AS sender,
    LogAttributes['receiver_thread_id'] AS receiver,
    toString(toUnixTimestamp64Milli(Timestamp)) AS at_ms
FROM claude_code.otel_logs
PREWHERE Timestamp >= {spanFrom:DateTime} AND Timestamp < {spanTo:DateTime}
  AND EventName = 'codex.agent_communication'
  AND ${EXACT_USER}
WHERE LogAttributes['kind'] IN ('spawn', 'followup')
  AND LogAttributes['state'] = 'send'
  AND (LogAttributes['sender_thread_id'] = {conversationId:String} OR LogAttributes['receiver_thread_id'] = {conversationId:String})
  AND coalesce(nullIf(ResourceAttributes['user.email'], ''), nullIf(ResourceAttributes['enduser.id'], ''), '') = {userExact:String}
ORDER BY Timestamp
LIMIT ${COMMUNICATION_LIMIT + 1}`,
    params: { spanFrom: toChDateTime(new Date(startMs - COMMUNICATION_CHILD_MS)),
      spanTo: toChDateTime(new Date(endMs + COMMUNICATION_CHILD_MS + 1000)), userExact: owner, conversationId },
  };
}

// walkLineage-shaped parent and links from communication sends (rows of codexCommunicationSql) and
// turn rows of the conversations involved (the task's own included). A send's child is the
// receiver's first turn starting in [t, t + COMMUNICATION_CHILD_MS]; the parent is the send to this
// conversation up to that long before the turn, with the sender's turn running at the send.
// `limited`: more eligible children than AGENT_LIMIT were found and the rest are not returned.
export function communicationLinks(sends, turns, { conversationId, turnId, startMs, endMs }) {
  const valid = sends.filter((x) => IDENT.test(x.sender ?? "") && IDENT.test(x.receiver ?? "")
    && x.sender !== x.receiver && /^(spawn|followup)$/.test(x.kind ?? "") && Number.isFinite(count(x.at_ms)))
    .map((x) => ({ ...x, t: count(x.at_ms) })).sort((a, b) => a.t - b.t);
  const starts = (t) => count(t.start_ms);
  const links = [], seen = new Set([turnId]);
  let limited = false;
  for (const x of valid) {
    if (x.sender !== conversationId || x.t < startMs || x.t > endMs) continue;
    const child = turns.filter((t) => t.conversation_id === x.receiver && TURN_ID.test(t.turn_id ?? "") && starts(t) !== null
      && starts(t) >= x.t && starts(t) <= x.t + COMMUNICATION_CHILD_MS)
      .reduce((a, b) => (!a || starts(b) < starts(a) ? b : a), null);
    if (!child || seen.has(child.turn_id)) continue;
    if (links.length >= AGENT_LIMIT) { limited = true; break; }
    seen.add(child.turn_id);
    links.push({ parent_turn: turnId, parent_conversation: conversationId, tool_span: `communication:${x.kind}`,
      tool_span_id: null, child_turn: child.turn_id, child_conversation: x.receiver, child_start_ms: starts(child), depth: 1 });
  }
  let parent = null;
  for (const x of valid.filter((v) => v.receiver === conversationId && v.t >= startMs - COMMUNICATION_CHILD_MS && v.t <= startMs).reverse()) {
    // This turn must be the conversation's first to start after the send.
    if (turns.some((t) => t.conversation_id === conversationId && t.turn_id !== turnId && starts(t) !== null
      && starts(t) >= x.t && starts(t) <= startMs)) continue;
    const owner = containingTurn(turns, x.sender, x.t);
    if (!owner || !TURN_ID.test(owner.turn_id ?? "")) continue;
    parent = { parent_turn: owner.turn_id, parent_conversation: x.sender, tool_span: `communication:${x.kind}`, tool_span_id: null,
      child_turn: turnId, child_conversation: conversationId, child_start_ms: startMs, depth: 1 };
    break;
  }
  return { parent, links, limited };
}

// Summed known values with a partial flag; all unknown is null.
function knownSum(values) {
  const known = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  return { value: known.length ? known.reduce((a, b) => a + b, 0) : null, partial: known.length < values.length };
}

// Pure fold. links: walkLineage links; entries: linkCompletions entries of the subagent
// conversations; task: the detail's own folded task; spawnSpanIds: the task's own SPAWN_SPANS
// span ids (null when the detail's spans were truncated); toolSpanIds: the turn's own lineage spans
// of any tool that may start a subagent turn (spawn, follow-up, send_input).
export function foldAgents({ task, parent = null, links = [], entries = [], limited = false, spawnSpanIds = null, namesTurn = false, linksSource = null, sendsSeen = false, toolSpanIds = [] }) {
  const parentId = parent ? taskId(parent.parent_conversation, parent.parent_turn) : null;
  const byTurn = new Map(entries.map((e) => [e.turn.turn_id, e]));
  const idOfTurn = new Map(links.map((l) => [l.child_turn, taskId(l.child_conversation, l.child_turn)]));
  const children = links.map((l) => {
    const entry = byTurn.get(l.child_turn);
    const folded = entry && entry.turn.conversation_id === l.child_conversation ? foldCodexTask(entry.turn, entry.linked) : null;
    const start = folded ? count(entry.turn.start_ms) : l.child_start_ms;
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
      link: linkWindow(start),
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
  let parentOut = null;
  if (parentId) {
    const entry = byTurn.get(parent.parent_turn);
    const found = entry && entry.turn.conversation_id === parent.parent_conversation;
    parentOut = { id: parentId, tool: toolName(parent.tool_span),
      started_at: found ? entry.turn.started_at ?? null : null,
      link: found ? linkWindow(count(entry.turn.start_ms)) : null };
  }
  return {
    parent: parentOut,
    links_source: linksSource,
    children: ordered,
    subagents: conversations.size,
    // Spawn/follow-up calls of this turn whose subagent turn was not found in the traces.
    spawn_calls: spawnSpanIds === null ? null : spawnSpanIds.length,
    unlinked_calls: spawnSpanIds === null ? null : spawnSpanIds.filter((id) => !linkedSpawns.has(id)).length,
    limited,
    // Positive evidence of no subagent calls: spans read complete, no call, and a version that
    // names its turn on tool spans (a missing call there is a real absence, not a missing tag),
    // no unlinked tool span of the turn (a send_input may have started a turn the traces missed)
    // and no communication send of the turn's conversation in its window.
    known_zero: spawnSpanIds !== null && spawnSpanIds.length === 0 && !limited && links.length === 0 && Boolean(namesTurn)
      && toolSpanIds.every((id) => linkedSpawns.has(id)) && !sendsSeen,
    total: { llm_calls: calls.value, llm_calls_partial: calls.partial || limited,
      cost_usd: cost.value, cost_partial: cost.partial || limited || Boolean(task.cost_partial)
        || children.some((c) => c.cost_partial) },
  };
}

// turn: { turnId, conversationId, startMs, endMs, traceIds, tracesPartial, namesTurn } of the detail's own turn and spans.
// A parent turn that started over a day before the lineage window shows its clipped start.
// One lineage read over the turn's traces, then one turn and one completion read over every
// subagent conversation found. `detailStart` (ms of `now()`, default: this call) starts the
// AGENT_EXTRA_BUDGET_MS clock; a read skipped once it is spent leaves the result limited (no
// known zero, partial cost) with the links the walk already found.
export async function codexAgents(owner, turn, task, spawnSpanIds, { run, prices, detailStart = null, now = Date.now }) {
  const started = detailStart ?? now();
  let spent = false;
  // May an optional read start? Once the budget is spent it stays spent, and the result is limited.
  const extra = () => {
    spent ||= now() - started >= AGENT_EXTRA_BUDGET_MS;
    if (spent) limited = true;
    return !spent;
  };
  const traceIds = turn.traceIds.slice(0, LINEAGE_TRACE_LIMIT);
  let limited = Boolean(turn.tracesPartial) || turn.traceIds.length > traceIds.length;
  if (!traceIds.length || turn.startMs === null || turn.endMs === null)
    return foldAgents({ task, limited, spawnSpanIds });
  const lineage = codexLineageSql(owner, traceIds, turn.startMs, turn.endMs);
  const lineageRows = await run(lineage.sql, lineage.params);
  if (lineageRows.length > LINEAGE_SPAN_LIMIT) limited = true;
  let rows = lineageRows.slice(0, LINEAGE_SPAN_LIMIT);
  const q = { userExact: owner };
  // Subagent turns start inside the lineage window, so their turns (with the competitors that could
  // win their completions, read 24h either side) and completions are read for that window only,
  // not the page's whole range.
  const lineageFrom = new Date(turn.startMs - LINEAGE_LEAD_MS), lineageTo = new Date(turn.endMs + SPAN_SLACK_MS);
  // Before Codex 0.166: resolve the spans that name no turn or conversation, reading the turns of
  // every conversation involved once, before the walk.
  let conversations = new Map(), turnRows = [];
  const read = new Set();
  const needs = legacyNeeds(rows);
  if ((needs.callIds.length || needs.childTurns.length) && extra()) {
    const callSql = needs.callIds.length ? codexCallLogSql(owner, needs.callIds, turn.startMs, turn.endMs) : null;
    const convSql = needs.childTurns.length ? codexTurnConversationSql(owner, needs.childTurns, turn.startMs, turn.endMs) : null;
    const [callLogs, turnConversations] = await Promise.all([callSql ? run(callSql.sql, callSql.params) : [],
      convSql ? run(convSql.sql, convSql.params) : []]);
    const candidates = [...new Set([...callLogs.map((l) => l.conversation), ...turnConversations.map((t) => t.conversation),
      ...rows.filter((r) => NAMES_CONVERSATION.includes(r.name)).map((r) => r.conversation)])].filter((c) => IDENT.test(c ?? "")).sort();
    if (candidates.length && extra()) {
      const s = codexTurnSql(lineageFrom, lineageTo, q, { conversationIds: candidates });
      const got = await run(s.sql, s.params);
      if (got.length > CODEX_TURN_LIMIT) limited = true;
      turnRows = got.slice(0, CODEX_TURN_LIMIT);
      for (const c of candidates) read.add(c);
    }
    ({ rows, conversations } = resolveLegacy(rows, callLogs, turnConversations, turnRows));
    // A legacy call left without a turn may be this turn's: the result is incomplete.
    if (rows.some((r) => LINK_TOOLS.includes(r.name) && !r.turn)) limited = true;
    if (spawnSpanIds !== null) spawnSpanIds = [...new Set([...spawnSpanIds,
      ...rows.filter((r) => SPAWN_SPANS.includes(r.name) && r.turn === turn.turnId).map((r) => r.span_id)])];
  }
  let walked = walkLineage(rows, turn.turnId, conversations);
  limited ||= walked.limited;
  let linksSource = walked.parent || walked.links.length ? "trace" : null, sendsSeen = false;
  // No traced child: the communication logs may still name the turn's subagents (and, without a
  // traced parent, its parent), and a send of the turn rules out a known zero. One log read, then
  // one owner-filtered turn read of the conversations they name. A traced child adds no reads.
  if (!walked.links.length && IDENT.test(turn.conversationId ?? "") && extra()) {
    const s = codexCommunicationSql(owner, turn.conversationId, turn.startMs, turn.endMs);
    const got = await run(s.sql, s.params);
    if (got.length > COMMUNICATION_LIMIT) limited = true;
    const sends = got.slice(0, COMMUNICATION_LIMIT);
    sendsSeen = sends.some((x) => x.sender === turn.conversationId && count(x.at_ms) >= turn.startMs && count(x.at_ms) <= turn.endMs);
    const others = [...new Set(sends.flatMap((x) => [x.sender, x.receiver]).filter((c) => IDENT.test(c ?? "")))].sort();
    const wanted = [...new Set([turn.conversationId, ...others])].filter((c) => !read.has(c));
    if (sends.length && wanted.length && extra()) {
      const t = codexTurnSql(lineageFrom, lineageTo, q, { conversationIds: wanted });
      const rowsRead = await run(t.sql, t.params);
      if (rowsRead.length > CODEX_TURN_LIMIT) limited = true;
      turnRows = [...turnRows, ...rowsRead.slice(0, CODEX_TURN_LIMIT)];
      for (const c of wanted) read.add(c);
    }
    const found = communicationLinks(sends, turnRows, { conversationId: turn.conversationId, turnId: turn.turnId,
      startMs: turn.startMs, endMs: turn.endMs });
    limited ||= found.limited;
    // A traced parent stays; the log's parent is used only when the trace has none.
    const parent = walked.parent ?? found.parent;
    if (found.links.length || parent !== walked.parent) { walked = { ...walked, parent, links: found.links }; linksSource = "log"; }
  }
  const conversationIds = [...new Set(walked.links.map((l) => l.child_conversation).filter((c) => IDENT.test(c ?? "")))];
  const parentConversation = walked.parent && IDENT.test(walked.parent.parent_conversation ?? "")
    ? walked.parent.parent_conversation : null;
  const turnIds = [...new Set([...conversationIds, ...(parentConversation ? [parentConversation] : [])])];
  const missing = turnIds.filter((c) => !read.has(c));
  let entries = [];
  if (turnIds.length && extra()) {
    const turnsSql = missing.length ? codexTurnSql(lineageFrom, lineageTo, q, { conversationIds: missing }) : null;
    const completionsSql = conversationIds.length ? codexCompletionSql(lineageFrom, lineageTo, q, { conversationIds }) : null;
    const [turns, completions] = await Promise.all([turnsSql ? run(turnsSql.sql, turnsSql.params) : [],
      completionsSql ? run(completionsSql.sql, completionsSql.params) : []]);
    if (turns.length > CODEX_TURN_LIMIT || completions.length > CODEX_COMPLETION_LIMIT) limited = true;
    const wanted = new Set(turnIds);
    const allTurns = [...turnRows.filter((t) => wanted.has(t.conversation_id)), ...turns.slice(0, CODEX_TURN_LIMIT)];
    entries = linkCompletions(allTurns, completions.slice(0, CODEX_COMPLETION_LIMIT), { prices }).entries;
  }
  const toolSpanIds = rows.filter((r) => LINK_TOOLS.includes(r.name) && r.turn === turn.turnId).map((r) => r.span_id);
  return foldAgents({ task, parent: walked.parent, links: walked.links, entries, limited, spawnSpanIds, namesTurn: turn.namesTurn,
    linksSource, sendsSeen, toolSpanIds });
}

// A linked count, or a zero only with positive evidence (`known_zero`); otherwise unknown (no
// trace, older Codex), never "no subagents".
export const agentCount = (agents) => (agents && agents.known_zero ? 0 : agents && agents.subagents > 0 ? agents.subagents : null);
