// Per-task trace detail (docs/superpowers/specs/2026-11-06-user-task-trace-design.md,
// "Task detail overlay"). One task of the list in taskTraces.js, with its spans laid out in
// agent lanes. Totals reuse the list's fold, so a detail equals its list row unless the span
// bound truncates it. Only allowlisted span attributes are selected, one key per column; the
// payload carries no request ids, prompts, commands, paths or raw attribute maps.
import { query as defaultQuery, toChDateTime } from "./clickhouse.js";
import { ValidationError, NotFoundError } from "./http.js";
import { GROUP_CTE, GROUP_EXPR } from "./grouping.js";
import { codexPrices } from "./priceCatalog.js";
import { EXACT_USER, TURN_ID, SPAN_SLACK_MS, COMPLETION_SLACK_MS, TOKEN_FIELDS, CODEX_TURN_LIMIT,
  CODEX_COMPLETION_LIMIT, count, modelLabel, tokenAttr, priceClaudeCall, claudeCostMap, foldTask,
  foldCodexTask, claudeCostSql, codexTurnSql, codexCompletionSql, linkCompletions } from "./taskTraces.js";

export const SPAN_ATTRIBUTE_ALLOWLIST = Object.freeze({
  llm: ["model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "ttft_ms",
    "attempt", "error_class", "status_code", "stop_reason", "query_source_safe", "effort", "speed"],
  tool: ["tool_name", "subagent_type", "skill_name", "anthropic.mcp.server.name", "bash_command_class",
    "success", "error_class"],
  wait: ["decision", "source"],
  codex: ["model", "tool_name", "aborted"],
});
// Newest spans returned per task; beyond it the detail is flagged truncated.
export const SPAN_BOUND = 5000;

const NUMERIC_ATTRS = new Set(["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens",
  "ttft_ms", "attempt", "status_code"]);
const BOOLEAN_ATTRS = new Set(["success", "aborted"]);
const CLAUDE_TOKEN_ATTRS = ["input_tokens", "cache_read_tokens", "cache_creation_tokens", "output_tokens"];
const CLAUDE_ATTRS = [...new Set([...SPAN_ATTRIBUTE_ALLOWLIST.llm, ...SPAN_ATTRIBUTE_ALLOWLIST.tool,
  ...SPAN_ATTRIBUTE_ALLOWLIST.wait])];
const BUILTIN_AGENTS = ["general-purpose", "Explore", "fork"];
const column = (key) => `a_${key.replace(/[^a-z0-9]/gi, "_")}`;
// Enumerated labels (tool names, classes, agent types, MCP servers) only: no spaces or
// slashes, so free text and paths cannot pass as a label.
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}$/;
const label = (value) => typeof value === "string" && LABEL.test(value) ? value : null;

const TRACE_ID = /^[0-9a-f]{32}$/;
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Task ids exactly as the list emits them: claude:<TraceId> (lowercase hex) and
// codex:<conversation id>:<turn id> (identifier characters, no colon; the turn id UUID-shaped,
// as only those turns are listed).
export function parseTaskId(id) {
  if (typeof id === "string" && id.length <= 300) {
    if (id.startsWith("claude:") && TRACE_ID.test(id.slice(7))) return { client: "claude", traceId: id.slice(7) };
    if (id.startsWith("codex:")) {
      const parts = id.slice(6).split(":");
      if (parts.length === 2 && IDENT.test(parts[0]) && TURN_ID.test(parts[1]))
        return { client: "codex", conversationId: parts[0], turnId: parts[1] };
    }
  }
  throw new ValidationError("invalid id", "id must be claude:<trace id> or codex:<conversation id>:<turn id>");
}

export function validateTaskDetailQuery(raw, enabledClients) {
  const task = parseTaskId(raw.id);
  if (!enabledClients.includes(task.client))
    throw new ValidationError("unsupported client", "the task's client is not enabled");
  const userExact = raw.userExact;
  if (typeof userExact !== "string" || userExact === "" || userExact.length > 256)
    throw new ValidationError("invalid filter", "userExact is required: a string of at most 256 characters");
  return { task, userExact, id: raw.id };
}

// Canonical cache key over every parameter the handler reads.
export function taskDetailCacheKey(query, enabledClients) {
  const { id, userExact } = validateTaskDetailQuery(query, enabledClients);
  const normalized = { from: query.from, to: query.to, id, userExact };
  return new URLSearchParams(Object.entries(normalized)
    .filter(([, value]) => value !== undefined && value !== "").sort(([a], [b]) => a.localeCompare(b))).toString();
}

// Header: the task's interaction span, which must start in [from, to) for the exact user
// (the list's ownership rule). Spans: every span of the TraceId in [from, to + 24h) (subagent
// spans can start hours later), deduplicated like the list, newest SPAN_BOUND plus a total.
export function claudeDetailSql(from, to, traceId, q) {
  const attrs = CLAUDE_ATTRS.map(k => k === "model" ? `Model AS ${column(k)}`
    : CLAUDE_TOKEN_ATTRS.includes(k) ? `${tokenAttr(k)} AS ${column(k)}`
      : `SpanAttributes['${k}'] AS ${column(k)}`);
  return {
    header: {
      sql: `${GROUP_CTE}
SELECT t.TraceId AS trace_id, t.started_at AS started_at, t.start_ms AS start_ms,
    t.duration_ms AS duration_ms, ${GROUP_EXPR} AS session_grp
FROM (
    SELECT TraceId, SessionId,
        formatDateTime(Timestamp, '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS started_at,
        toString(toUnixTimestamp64Milli(Timestamp)) AS start_ms,
        intDiv(Duration, 1000000) AS duration_ms
    FROM claude_code.otel_traces
    WHERE SpanType = 'interaction' AND TraceId = {traceId:String}
      AND Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime}
      AND ${EXACT_USER}
    ORDER BY Timestamp
    LIMIT 1
) t
LEFT JOIN session_group ug ON t.SessionId = ug.SessionId`,
      params: { from: toChDateTime(from), to: toChDateTime(to), traceId, userExact: q.userExact },
    },
    spans: {
      sql: `SELECT span_id, parent_id, span_type, span_name, start_ms, duration_ms, agent_id, request_id,
    ${CLAUDE_ATTRS.map(column).join(", ")},
    count() OVER () AS total_spans
FROM (
    SELECT TraceId, SpanId, SpanId AS span_id, ParentSpanId AS parent_id, SpanType AS span_type,
        SpanName AS span_name, Timestamp AS ts,
        toString(toUnixTimestamp64Milli(Timestamp)) AS start_ms,
        toString(intDiv(Duration, 1000000)) AS duration_ms,
        AgentId AS agent_id,
        SpanAttributes['request_id'] AS request_id,
        ${attrs.join(",\n        ")}
    FROM claude_code.otel_traces
    WHERE Timestamp >= {from:DateTime} AND Timestamp < {spanTo:DateTime}
      AND TraceId = {traceId:String}
    LIMIT 1 BY TraceId, SpanId
)
WHERE span_type != 'interaction'
ORDER BY ts DESC, span_id
LIMIT ${SPAN_BOUND}`,
      params: { from: toChDateTime(from), spanTo: toChDateTime(new Date(to.getTime() + SPAN_SLACK_MS)), traceId },
    },
  };
}

// Codex: the conversation's turns and completions (the complete competitor set for the
// list's latest-start-wins linking) and the turn's spans in [from - 24h, to + 24h), the
// list's turn window. Spans that name another conversation are excluded; spans without a
// conversation id stay, as in the list's turn grouping.
export function codexDetailSql(from, to, q, conversationId, turnId) {
  return {
    turns: codexTurnSql(from, to, q, { conversationId }),
    completions: codexCompletionSql(from, to, q, { conversationId }),
    spans: {
      sql: `SELECT span_id, parent_id, span_name, start_ms, duration_ms,
    ${SPAN_ATTRIBUTE_ALLOWLIST.codex.map(column).join(", ")},
    count() OVER () AS total_spans
FROM (
    SELECT TraceId, SpanId, SpanId AS span_id, ParentSpanId AS parent_id, SpanName AS span_name,
        Timestamp AS ts,
        toString(toUnixTimestamp64Milli(Timestamp)) AS start_ms,
        toString(intDiv(Duration, 1000000)) AS duration_ms,
        coalesce(nullIf(SpanAttributes['model'], ''), SpanAttributes['gen_ai.request.model']) AS ${column("model")},
        SpanAttributes['tool_name'] AS ${column("tool_name")},
        SpanAttributes['aborted'] AS ${column("aborted")}
    FROM claude_code.otel_traces
    PREWHERE Timestamp >= {spanFrom:DateTime} AND Timestamp < {spanTo:DateTime}
      AND ${EXACT_USER}
    WHERE ResourceAttributes['client'] = 'codex'
      AND coalesce(nullIf(SpanAttributes['turn_id'], ''), SpanAttributes['turn.id']) = {turnId:String}
      AND SpanAttributes['conversation.id'] IN ('', {conversationId:String})
    LIMIT 1 BY TraceId, SpanId
)
ORDER BY ts DESC, span_id
LIMIT ${SPAN_BOUND}`,
      params: { spanFrom: toChDateTime(new Date(from.getTime() - SPAN_SLACK_MS)),
        spanTo: toChDateTime(new Date(to.getTime() + SPAN_SLACK_MS)), userExact: q.userExact, turnId, conversationId },
    },
  };
}

function attrValue(key, raw) {
  if (raw === null || raw === undefined || raw === "") return undefined;
  if (NUMERIC_ATTRS.has(key)) return count(raw) ?? undefined;
  if (BOOLEAN_ATTRS.has(key)) return raw === "true" || raw === true ? true : raw === "false" || raw === false ? false : undefined;
  if (key === "model") return modelLabel(raw) ?? undefined;
  return label(raw) ?? undefined;
}

function pickAttrs(row, keys) {
  const attrs = {};
  for (const key of keys) {
    const value = attrValue(key, row[column(key)]);
    if (value !== undefined) attrs[key] = value;
  }
  return attrs;
}

function spanTotal(rows) {
  const total = rows.length ? count(rows[0].total_spans) : 0;
  return Math.max(total ?? 0, rows.length);
}

const byStart = (a, b) => (a.start ?? 0) - (b.start ?? 0) || String(a.id).localeCompare(String(b.id));
const sumKnown = (values) => values.reduce((sum, v) => sum + v, 0);

// "Why expensive" rules from the task's own data; a rule whose inputs are unavailable is
// omitted. `calls` = [{ id, lane, start, context, cost }] in any order.
function whyRules({ task, calls, lanes, retries, waitMs }) {
  const why = [];
  const t = task.tokens;
  if (t && !t.tokens_partial && TOKEN_FIELDS.every(k => t[k] !== null)) {
    const total = sumKnown(TOKEN_FIELDS.map(k => t[k]));
    if (total > 0) why.push({ rule: "cache_read_share", value: t.cache_read / total });
  }
  const main = calls.filter(c => c.lane === "main").sort(byStart);
  if (main.length >= 2 && main[0].context !== null && main.at(-1).context !== null)
    why.push({ rule: "context_growth", value: { first: main[0].context, last: main.at(-1).context, calls: main.length } });
  const allCosts = calls.length > 0 && calls.every(c => c.cost !== null);
  const active = lanes.filter(l => l.llm_calls > 0);
  if (allCosts && active.length >= 2) {
    const total = sumKnown(active.map(l => l.cost_usd));
    const top = [...active].sort((a, b) => b.cost_usd - a.cost_usd)[0];
    if (total > 0 && Number.isFinite(total)) why.push({ rule: "top_lane_share", value: { lane: top.id, share: top.cost_usd / total } });
  }
  if (allCosts) {
    const top = [...calls].sort((a, b) => b.cost - a.cost || byStart(a, b))[0];
    why.push({ rule: "most_expensive_call", value: { span: top.id, cost_usd: top.cost } });
  }
  if (retries !== null) why.push({ rule: "retries", value: retries });
  if (waitMs !== null) why.push({ rule: "permission_wait", value: waitMs });
  return why;
}

const CLAUDE_KIND = { llm_request: "llm", tool: "tool", "tool.execution": "tool", "tool.blocked_on_user": "wait" };

// One bar per Claude tool call: a `tool.execution` span whose parent `tool` span is in the
// rows folds into that bar (its allowlisted attrs fill keys the tool span lacks, its duration
// becomes `execution_ms`); children of a folded execution span hang off the tool bar. An
// execution span without its tool span (bound or export gap) is drawn as the tool bar.
function foldedExecutions(rows, byId) {
  const folded = new Map();
  for (const r of rows)
    if (r.span_type === "tool.execution" && byId.get(r.parent_id)?.span_type === "tool") folded.set(r.span_id, r.parent_id);
  return folded;
}

// Subagent type when the spawning Agent span lacks subagent_type: the api_request log's
// agent.name for the lane's calls, else the call's query source (agent.builtin.<type>).
function laneTypeFallback(laneRows, agentNames) {
  for (const r of laneRows) {
    const name = label(agentNames.get(r.request_id));
    if (name) return name;
  }
  for (const r of laneRows) {
    const source = r[column("query_source_safe")];
    const builtin = typeof source === "string" && source.startsWith("agent.builtin.") ? label(source.slice(14)) : null;
    if (builtin) return builtin;
  }
  return null;
}

function foldClaudeDetail(head, rows, costRows) {
  const costs = claudeCostMap(costRows);
  const agentNames = new Map(costRows.filter(r => r.request_id && r.agent_name).map(r => [r.request_id, r.agent_name]));
  const t0 = count(head.start_ms);
  const total = spanTotal(rows);
  const truncated = total > rows.length;
  const byId = new Map(rows.map(r => [r.span_id, r]));
  const folded = foldedExecutions(rows, byId);
  const execOf = new Map([...folded].map(([exec, tool]) => [tool, byId.get(exec)]));
  // The drawn bar standing for a span id (a folded execution span is drawn as its tool).
  const drawn = (id) => folded.get(id) ?? id;
  const ordered = rows.map(r => ({ r, start: count(r.start_ms), id: r.span_id })).sort(byStart);
  const spans = [], calls = [], rawCalls = [], agents = new Set();
  let waitMs = 0, attempts = 0;
  for (const { r, start } of ordered) {
    if (r.agent_id) agents.add(r.agent_id);
    const kind = CLAUDE_KIND[r.span_type];
    if (!kind || folded.has(r.span_id)) continue;
    const lane = r.agent_id || "main";
    const parentId = r.parent_id && byId.has(r.parent_id) ? drawn(r.parent_id) : null;
    const span = { id: r.span_id, parent: parentId, lane, kind,
      name: label(r.span_name) ?? r.span_type, start_ms: start !== null && t0 !== null ? start - t0 : null,
      duration_ms: count(r.duration_ms), attrs: pickAttrs(r, SPAN_ATTRIBUTE_ALLOWLIST[kind]) };
    const exec = execOf.get(r.span_id);
    if (exec) {
      span.attrs = { ...pickAttrs(exec, SPAN_ATTRIBUTE_ALLOWLIST.tool), ...span.attrs };
      span.execution_ms = count(exec.duration_ms);
    }
    if (kind === "llm") {
      const raw = [r.request_id ?? "", r[column("model")] ?? "", ...CLAUDE_TOKEN_ATTRS.map(k => r[column(k)])];
      const priced = priceClaudeCall(raw, head.session_grp, costs);
      Object.assign(span, { tokens: priced.tokens, cost_usd: priced.cost_usd, cost_basis: priced.basis });
      rawCalls.push(raw);
      const tk = priced.tokens;
      const context = [tk.input, tk.cache_read, tk.cache_write].every(v => v !== null)
        ? tk.input + tk.cache_read + tk.cache_write : null;
      calls.push({ id: span.id, lane, start, context, cost: priced.cost_usd });
      if (span.attrs.attempt === undefined) attempts = null;
      else if (attempts !== null) attempts += span.attrs.attempt > 1 ? 1 : 0;
    }
    if (kind === "wait") waitMs = waitMs === null || span.duration_ms === null ? null : waitMs + span.duration_ms;
    spans.push(span);
  }
  // Retries are known only when every call carries `attempt`; partial evidence is unavailable.
  const retries = rawCalls.length && attempts !== null ? attempts : null;
  let task = foldTask({ trace_id: head.trace_id, started_at: head.started_at, duration_ms: head.duration_ms,
    session_grp: head.session_grp, llm_calls: rawCalls.length, subagents: agents.size, calls: rawCalls }, costs);
  // Lanes: main first, then agents by first span. A subagent lane is spawned by the parent of
  // its first llm_request (the tool.execution span), reported as the drawn tool bar; its type
  // comes from that span or its parent tool span (subagent_type), else laneTypeFallback.
  const laneIds = ["main", ...new Set(spans.filter(s => s.lane !== "main").map(s => s.lane))];
  const lanes = laneIds.map(id => {
    const own = calls.filter(c => c.lane === id);
    const known = own.filter(c => c.cost !== null);
    let spawnedBy = null, type = null;
    if (id !== "main") {
      const first = spans.find(s => s.lane === id && s.kind === "llm");
      const parent = first && byId.get(byId.get(first.id).parent_id);
      if (parent) {
        spawnedBy = drawn(parent.span_id);
        type = label(parent[column("subagent_type")]) ?? label(byId.get(parent.parent_id)?.[column("subagent_type")]);
      }
      type ??= laneTypeFallback(rows.filter(r => r.agent_id === id && r.span_type === "llm_request"), agentNames);
    }
    const lane = { id, label: id === "main" ? "main" : type, kind: id === "main" ? "main"
      : BUILTIN_AGENTS.includes(type) ? type : "custom", spawned_by: spawnedBy,
    llm_calls: own.length, cost_usd: own.length === 0 ? 0 : known.length ? sumKnown(known.map(c => c.cost)) : null,
    cost_partial: known.length < own.length };
    return truncated ? { ...lane, llm_calls: null, cost_usd: null, cost_partial: true } : lane;
  });
  if (truncated) {
    // The newest SPAN_BOUND spans cannot produce whole-task totals or the task's model set:
    // withhold them.
    task = { ...task, models: null, llm_calls: null, subagents: null, tokens: null, cost_usd: null,
      cost_partial: true, cost_basis: null };
    return { task, lanes, spans, truncated, span_total: total, why: [] };
  }
  return { task, lanes, spans, truncated, span_total: total,
    why: whyRules({ task, calls, lanes, retries, waitMs }) };
}

const sumField = (values) => values.every(v => v !== null && v !== undefined) ? sumKnown(values) : null;

function foldCodexDetail({ turn, linked, limited = false }, rows) {
  let task = foldCodexTask(turn, linked);
  if (limited) task = { ...task, cost_partial: true };
  const t0 = count(turn.start_ms);
  const total = spanTotal(rows);
  const ordered = rows.map(r => ({ r, start: count(r.start_ms), id: r.span_id })).sort(byStart);
  const ids = new Set(rows.map(r => r.span_id));
  const spans = ordered.map(({ r, start }) => ({ id: r.span_id, parent: r.parent_id && ids.has(r.parent_id) ? r.parent_id : null,
    lane: "main", kind: r.span_name === "codex.sampling" ? "llm" : "tool", name: label(r.span_name) ?? "unknown",
    start_ms: start !== null && t0 !== null ? start - t0 : null, duration_ms: count(r.duration_ms),
    attrs: pickAttrs(r, SPAN_ATTRIBUTE_ALLOWLIST.codex), _start: start }));
  // Each linked completion goes to the latest-starting sampling span whose
  // [start, end + slack] contains its event time (the turn rule, one level down).
  const assigned = new Map();
  const calls = [];
  for (const entry of [...linked].sort((a, b) => (a.time ?? 0) - (b.time ?? 0))) {
    let best = null;
    if (entry.time !== null && entry.time !== undefined) for (const s of spans) {
      if (s.kind !== "llm" || s._start === null || s.duration_ms === null) continue;
      if (entry.time < s._start || entry.time > s._start + s.duration_ms + COMPLETION_SLACK_MS) continue;
      if (!best || s._start > best._start || (s._start === best._start && s.id > best.id)) best = s;
    }
    if (best) assigned.set(best.id, [...(assigned.get(best.id) ?? []), entry]);
    const u = entry.usage;
    calls.push({ id: best?.id ?? null, lane: "main", start: entry.time,
      context: u.invalid ? null : count(u.input_tokens_total), cost: u.cost_usd ?? null });
  }
  let withSpan = 0;
  for (const span of spans) {
    delete span._start;
    const entries = assigned.get(span.id);
    if (!entries) continue;
    withSpan += entries.length;
    const parts = entries.map(({ usage }) => ({ input: usage.input_tokens, cache_read: usage.cache_read_tokens,
      cache_write: usage.cache_write_tokens, output: usage.output_tokens }));
    span.tokens = Object.fromEntries(TOKEN_FIELDS.map(k => [k, sumField(parts.map(p => p[k]))]));
    span.cost_usd = sumField(entries.map(e => e.usage.cost_usd));
    span.cost_basis = "linked_estimate";
    // Completion-log fields of the first linked completion; count shows any extra links.
    const first = entries[0].row;
    span.completion = { model: modelLabel(first.model), effort: label(first.effort), ttft_ms: count(first.ttft_ms),
      duration_ms: count(first.duration_ms), count: entries.length };
  }
  task = { ...task, completions_without_span: linked.length - withSpan };
  const lanes = [{ id: "main", label: "main", kind: "main", spawned_by: null, llm_calls: task.llm_calls,
    cost_usd: task.cost_usd, cost_partial: task.cost_partial }];
  // Codex totals come from the turn aggregate and linked completions, not from the bounded
  // span list, so truncation does not withhold them. Codex has no retry or permission-wait
  // evidence: those rules are omitted.
  return { task, lanes, spans, truncated: total > rows.length, span_total: total,
    why: whyRules({ task, calls, lanes, retries: null, waitMs: null }) };
}

// Pure fold. Claude: task = { client: "claude", ...interaction header row }, evidence = cost
// rows. Codex: task = { client: "codex", turn, linked, limited } from linkCompletions.
export function foldTaskDetail(task, spanRows, evidence = []) {
  return task.client === "codex" ? foldCodexDetail(task, spanRows) : foldClaudeDetail(task, spanRows, evidence);
}

export async function userTaskDetail(from, to, raw, enabledClients, run = defaultQuery, prices = codexPrices()) {
  const { task, userExact } = validateTaskDetailQuery(raw, enabledClients);
  const q = { userExact };
  if (task.client === "claude") {
    const sql = claudeDetailSql(from, to, task.traceId, q);
    // Ownership first: no span query runs for a task of another user.
    const [head] = await run(sql.header.sql, sql.header.params);
    if (!head) throw new NotFoundError();
    const rows = await run(sql.spans.sql, sql.spans.params);
    const ids = [...new Set(rows.filter(r => r.span_type === "llm_request").map(r => r.request_id).filter(Boolean))];
    let costRows = [];
    if (ids.length) {
      const cost = claudeCostSql(from, to, ids);
      costRows = await run(cost.sql, cost.params);
    }
    return foldTaskDetail({ client: "claude", ...head }, rows, costRows);
  }
  const sql = codexDetailSql(from, to, q, task.conversationId, task.turnId);
  const [turns, completions] = await Promise.all([run(sql.turns.sql, sql.turns.params),
    run(sql.completions.sql, sql.completions.params)]);
  const limited = turns.length > CODEX_TURN_LIMIT || completions.length > CODEX_COMPLETION_LIMIT;
  const { entries } = linkCompletions(turns.slice(0, CODEX_TURN_LIMIT), completions.slice(0, CODEX_COMPLETION_LIMIT),
    { prices });
  const entry = entries.find(e => e.inBucket && e.turn.turn_id === task.turnId
    && e.turn.conversation_id === task.conversationId);
  if (!entry) throw new NotFoundError();
  const rows = await run(sql.spans.sql, sql.spans.params);
  return foldTaskDetail({ client: "codex", turn: entry.turn, linked: entry.linked, limited }, rows);
}
