// Codex subagent counts for the task list: the shown page's Codex turns get the count the task
// detail reports (codexAgents.js agentCount), from the same parent-span lineage walk, without the
// detail's child turn and completion reads (the list shows no subagent calls or cost).
// One scan finds the agent tool spans (collaboration<tool>, multi_agent_v1<tool>) inside the page
// turns' own windows; each turn's own traces are then walked over its own window, like its detail.
// A count needs a walked link to a named subagent conversation. A zero needs the detail's evidence:
// a complete scan, no spawn/follow-up/send_input span and no walked link of the turn, a Codex version
// that names its turn on tool spans (0.166+), and a turn ending clear of the span read bound.
// Otherwise the count is unknown (null), never zero.
import { toChDateTime } from "./clickhouse.js";
import { EXACT_USER, SPAN_SLACK_MS, TURN_ID, count, chunkIds, namesTurnOnTools } from "./taskTraces.js";
import { AGENT_ID_LIMIT, LEGACY_CALL_SLACK_MS, LINEAGE_TRACE_LIMIT, LINK_TOOLS, TOOL_PREFIXES, codexCallLogSql,
  codexLineageSql, codexTurnConversationSql, legacyNeeds, resolveLegacy, walkLineage } from "./codexAgents.js";

// Time the page's subagent reads may take before the remaining counts stay unknown.
export const LIST_AGENT_BUDGET_MS = 3000;
// Agent tool spans read for one page; more leaves every count without a found link unknown.
export const LIST_TOOL_SPAN_LIMIT = 5000;

// Lineage spans read for one list turn (the detail reads up to LINEAGE_SPAN_LIMIT): a read stops at
// this many, so a turn of a very long trace stays unknown instead of slowing the list.
export const LIST_LINEAGE_SPAN_LIMIT = 5000;
// Page turns whose lineage is read at once.
export const LIST_AGENT_CONCURRENCY = 4;

const SECOND_MS = 1000;
// Spans naming their turn on Codex 0.166+ (one of each per turn).
const TURN_ROOTS = ["run_turn", "session_task.turn"];
// The detail's margin before the span read bound (taskTraceDetail.js codexSpawnEvidence).
const SPAWN_BOUND_MS = 60000;

// Overlapping windows merged, in start order.
function mergeRanges(ranges) {
  const out = [];
  for (const r of [...ranges].sort((a, b) => a.fromMs - b.fromMs)) {
    const last = out[out.length - 1];
    if (last && r.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, r.toMs);
    else out.push({ ...r });
  }
  return out;
}

// Agent tool spans (collaboration<tool>, multi_agent_v1<tool>) of the owner inside the given windows
// (whole seconds, end inclusive): every span the detail's walk can start a chain from; plus the
// turn spans of `turnIds`, the evidence that a turn's own spans were collected at all.
export function codexLinkToolSql(owner, turnIds, ranges) {
  const params = { userExact: owner, turnIds };
  const windows = ranges.map((r, i) => {
    params[`r${i}From`] = toChDateTime(new Date(Math.floor(r.fromMs / SECOND_MS) * SECOND_MS));
    params[`r${i}To`] = toChDateTime(new Date(Math.floor(r.toMs / SECOND_MS) * SECOND_MS + SECOND_MS));
    return `(Timestamp >= {r${i}From:DateTime} AND Timestamp < {r${i}To:DateTime})`;
  });
  return {
    sql: `SELECT TraceId AS trace_id, SpanId AS span_id, SpanName AS name,
    coalesce(nullIf(SpanAttributes['turn_id'], ''), SpanAttributes['turn.id']) AS turn,
    toString(toUnixTimestamp64Milli(Timestamp)) AS start_ms
FROM claude_code.otel_traces
PREWHERE (${windows.join(" OR ")})
  AND ${EXACT_USER}
WHERE ResourceAttributes['client'] = 'codex'
  AND (${TOOL_PREFIXES.map((p) => `startsWith(SpanName, '${p}')`).join(" OR ")}
    OR (SpanName IN (${TURN_ROOTS.map((n) => `'${n}'`).join(", ")}) AND turn IN {turnIds:Array(String)}))
LIMIT 1 BY TraceId, SpanId
LIMIT ${LIST_TOOL_SPAN_LIMIT + 1}`,
    params,
  };
}

// pageTurns: the page's Codex turn rows (codexTurnSql or rollupTurnSql shape); turnRows: every turn
// row of the list's read, which resolves a pre-0.166 call to its calling turn. Returns turn id ->
// subagent count, 0, or null (unknown).
export async function codexListSubagents(owner, pageTurns, turnRows, { run, toMs = null, now = Date.now, budgetMs = LIST_AGENT_BUDGET_MS }) {
  const started = now();
  const out = new Map(pageTurns.map((t) => [t.turn_id, null]));
  // A turn ending within a minute of the span read bound (toMs + SPAN_SLACK_MS) may continue past it:
  // its detail withholds its spawn evidence (taskTraceDetail.js codexSpawnEvidence), so it stays unknown.
  const clipped = (t) => toMs !== null && count(t.end_ms) + SPAWN_BOUND_MS > toMs + SPAN_SLACK_MS;
  const turns = pageTurns.filter((t) => TURN_ID.test(t.turn_id ?? "") && count(t.start_ms) !== null && count(t.end_ms) !== null
    && !clipped(t));
  if (!turns.length) return out;
  const scan = codexLinkToolSql(owner, turns.map((t) => t.turn_id), mergeRanges(turns.map((t) => ({
    fromMs: count(t.start_ms) - LEGACY_CALL_SLACK_MS, toMs: count(t.end_ms) + LEGACY_CALL_SLACK_MS }))));
  const scanned = await run(scan.sql, scan.params);
  const complete = scanned.length <= LIST_TOOL_SPAN_LIMIT;
  const tools = scanned.slice(0, LIST_TOOL_SPAN_LIMIT).filter((r) => TOOL_PREFIXES.some((p) => (r.name ?? "").startsWith(p)));
  const present = new Set(scanned.filter((r) => TURN_ROOTS.includes(r.name)).map((r) => r.turn));
  const namesTurn = (t) => Number(t.names_turn) > 0 || namesTurnOnTools(t.app_version);
  const withTool = new Set(tools.map((r) => r.turn).filter(Boolean));
  const withLink = new Set(tools.filter((r) => LINK_TOOLS.includes(r.name)).map((r) => r.turn).filter(Boolean));
  // A zero (the detail's known_zero): a version naming its turn on tool spans (so no legacy, unnamed
  // span is its own), a complete scan, no spawn/follow-up/send_input span, no spawn call counted for
  // the turn elsewhere (its rollup row), a span of the turn itself in the scan (no spans is unknown, as
  // in the detail) and no walked link. Without any agent tool span no walk is needed.
  const mayBeZero = (t) => complete && present.has(t.turn_id) && namesTurn(t) && !withLink.has(t.turn_id)
    && !(count(t.spawn_calls) > 0);
  for (const t of turns) if (mayBeZero(t) && !withTool.has(t.turn_id)) out.set(t.turn_id, 0);
  const legacy = tools.filter((r) => !r.turn);
  // A turn's lineage traces: its own tool spans', and those of unnamed (legacy) calls in its window.
  const tracesOf = (t) => {
    const from = count(t.start_ms) - LEGACY_CALL_SLACK_MS, to = count(t.end_ms) + LEGACY_CALL_SLACK_MS;
    return [...new Set([...tools.filter((r) => r.turn === t.turn_id),
      ...(namesTurn(t) ? [] : legacy.filter((r) => count(r.start_ms) >= from && count(r.start_ms) <= to))]
      .map((r) => r.trace_id).filter(Boolean))];
  };
  const walk = turns.map((t) => ({ t, traceIds: tracesOf(t) })).filter((w) => w.traceIds.length);
  const spent = () => now() - started >= budgetMs;
  // One turn at a time per worker, each over its own window (as its detail reads it). The walked
  // links, or null when a read reached a cap or the budget (unknown, never a short count).
  const linksOf = async ({ t, traceIds }) => {
    if (traceIds.length > LINEAGE_TRACE_LIMIT) return null;
    const startMs = count(t.start_ms), endMs = count(t.end_ms);
    const lineage = codexLineageSql(owner, traceIds, startMs, endMs, LIST_LINEAGE_SPAN_LIMIT);
    let rows = await run(lineage.sql, lineage.params);
    if (rows.length > LIST_LINEAGE_SPAN_LIMIT) return null;
    let conversations = new Map();
    const needs = legacyNeeds(rows);
    if (needs.callIds.length || needs.childTurns.length) {
      if (needs.callIds.length > AGENT_ID_LIMIT || needs.childTurns.length > AGENT_ID_LIMIT) return null;
      // Every chunk starts only while the budget lasts; a skipped one leaves the turn unknown.
      const readAll = async (ids, sqlOf) => {
        const got = [];
        for (const chunk of chunkIds(ids)) {
          if (spent()) return null;
          const s = sqlOf(chunk);
          got.push(...await run(s.sql, s.params));
        }
        return got;
      };
      const [logs, named] = await Promise.all([
        readAll(needs.callIds, (c) => codexCallLogSql(owner, c, startMs, endMs)),
        readAll(needs.childTurns, (c) => codexTurnConversationSql(owner, c, startMs, endMs)),
      ]);
      if (logs === null || named === null) return null;
      ({ rows, conversations } = resolveLegacy(rows, logs, named, turnRows));
    }
    // A call still without a turn may be this turn's (a caller outside the list's turns): unknown,
    // as the detail marks it limited.
    if (rows.some((r) => LINK_TOOLS.includes(r.name) && !r.turn)) return null;
    return walkLineage(rows, t.turn_id, conversations).links;
  };
  const queue = [...walk];
  const worker = async () => {
    for (let w = queue.shift(); w && !spent(); w = queue.shift()) {
      const links = await linksOf(w);
      if (links === null) continue;
      const subagents = new Set(links.map((l) => l.child_conversation).filter(Boolean)).size;
      if (subagents > 0) out.set(w.t.turn_id, subagents);
      else if (!links.length && mayBeZero(w.t)) out.set(w.t.turn_id, 0);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIST_AGENT_CONCURRENCY, walk.length) }, worker));
  return out;
}
