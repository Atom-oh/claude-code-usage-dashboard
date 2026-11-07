// Per-user task list from traces (docs/superpowers/specs/2026-11-06-user-task-trace-design.md).
// A Claude task is one `interaction` span (its TraceId); its LLM calls are the trace's
// `llm_request` spans. A Codex task is one turn (conversation.id, turn id) of Codex spans;
// its tokens and cost come only from usage-bearing completion logs linked to the turn's
// span window (docs/reference/codex-observability.md). Only trace-enabled users emit spans,
// so every response is partial. The payload carries no request ids, prompts, commands,
// paths or raw attributes.
import { query as defaultQuery, toChDateTime } from "./clickhouse.js";
import { ValidationError } from "./http.js";
import { selectClients } from "./clients.js";
import { validateClientFilters } from "./clientMetrics.js";
import { GROUP_CTE, GROUP_EXPR } from "./grouping.js";
import { backendSql, resolveBackend } from "./backend.js";
import { computeCost, normalizeModelId } from "./pricing.js";
import { isNonAnthropicModel, requestListEstimate } from "./nonAnthropicCost.js";
import { createObservedTokens, addObservedTokens, finishObservedTokens } from "./observedTokens.js";
import { COMPLETION_TOKEN_KEYS, priceCodexCompletion } from "./codexInsightsLogs.js";
import { codexPrices } from "./priceCatalog.js";

export const TASK_LIMIT = 20;
// Subagent spans of a long task can start after the selected bucket ends (spec: ~12% of
// subagent llm_request spans had no interaction in the same 7-day window).
const SPAN_SLACK_MS = 24 * 3600000;
const SORTS = ["tokens", "duration"];
const TOKEN_FIELDS = ["input", "cache_read", "cache_write", "output"];
// Row guards: a user's turns/completions in one bucket stay far below these; hitting one
// marks Codex coverage "limited" rather than silently dropping evidence.
export const CODEX_TURN_LIMIT = 5000;
export const CODEX_COMPLETION_LIMIT = 50000;
const COMPLETION_SLACK_MS = 5000;
const EXACT_USER = "coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, ''), '') = {userExact:String}";

export function validateTaskQuery(raw, enabledClients) {
  const clients = selectClients(raw.client, enabledClients);
  const userExact = raw.userExact;
  if (typeof userExact !== "string" || userExact === "" || userExact.length > 256)
    throw new ValidationError("invalid filter", "userExact is required: a string of at most 256 characters");
  // Shared backend validation; group/project are handled here, not by the shared views.
  const { backend } = validateClientFilters({ client: raw.client, backend: raw.backend }, enabledClients);
  const group = raw.group ?? "";
  if (typeof group !== "string" || group.length > 256)
    throw new ValidationError("invalid filter", "group must be a string of at most 256 characters");
  // A channel group exists only for Claude sessions; it filters Claude tasks only.
  if (group && !clients.includes("claude"))
    throw new ValidationError("unsupported filter", "group applies only to Claude tasks");
  const sort = raw.sort ?? "tokens";
  if (!SORTS.includes(sort)) throw new ValidationError("invalid sort", "sort accepts tokens or duration");
  return { clients, userExact, backend, group, sort };
}

// Canonical cache key over the parameters the handler reads (validated, default sort folded).
export function taskCacheKey(query, enabledClients) {
  const { clients, userExact, backend, group, sort } = validateTaskQuery(query, enabledClients);
  const normalized = { from: query.from, to: query.to, client: clients.join(","), userExact, backend, group, sort };
  return new URLSearchParams(Object.entries(normalized)
    .filter(([, value]) => value !== undefined && value !== "").sort(([a], [b]) => a.localeCompare(b))).toString();
}

const tokenAttr = (key) => `toUInt64OrNull(SpanAttributes['${key}'])`;
// Claude per-call backend, as clientMetrics.js resolves it for Claude rows.
const claudeBackendSql = (modelExpr) =>
  `multiIf(${GROUP_EXPR} = 'enterprise', 'anthropic', ${backendSql(modelExpr, "''")})`;

export function claudeTaskListSql(from, to, q) {
  const params = { from: toChDateTime(from), to: toChDateTime(to),
    spanTo: toChDateTime(new Date(to.getTime() + SPAN_SLACK_MS)), userExact: q.userExact };
  const conds = [];
  if (q.group) { conds.push(`${GROUP_EXPR} = {group:String}`); params.group = q.group; }
  if (q.backend) {
    // Backend evidence comes from the task's call models; a task without models is unknown.
    conds.push(`if(empty(s.raw_models), 'unknown' = {backend:String},
      arrayExists(m -> ${claudeBackendSql("m")} = {backend:String}, s.raw_models))`);
    params.backend = q.backend;
  }
  const order = q.sort === "duration"
    ? "t.duration_ms DESC, s.sort_tokens DESC, t.TraceId"
    : "s.sort_tokens DESC, t.duration_ms DESC, t.TraceId";
  const sql = `${GROUP_CTE}, interactions AS (
    SELECT TraceId, SessionId,
        formatDateTime(Timestamp, '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS started_at,
        intDiv(Duration, 1000000) AS duration_ms
    FROM claude_code.otel_traces
    WHERE SpanType = 'interaction'
      AND Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime}
      AND ${EXACT_USER}
    ORDER BY Timestamp
    LIMIT 1 BY TraceId
), task_spans AS (
    SELECT TraceId,
        countIf(SpanType = 'llm_request') AS llm_calls,
        uniqExactIf(AgentId, AgentId != '') AS subagents,
        sumIf(ifNull(input_tokens + cache_read_tokens + cache_creation_tokens + output_tokens, 0),
          SpanType = 'llm_request') AS sort_tokens,
        groupUniqArrayIf(Model, SpanType = 'llm_request' AND Model != '') AS raw_models,
        groupArrayIf([request_id, Model, ifNull(toString(input_tokens), ''),
          ifNull(toString(cache_read_tokens), ''), ifNull(toString(cache_creation_tokens), ''),
          ifNull(toString(output_tokens), '')], SpanType = 'llm_request') AS calls
    FROM (
        SELECT TraceId, SpanType, AgentId, Model,
            SpanAttributes['request_id'] AS request_id,
            ${tokenAttr("input_tokens")} AS input_tokens,
            ${tokenAttr("cache_read_tokens")} AS cache_read_tokens,
            ${tokenAttr("cache_creation_tokens")} AS cache_creation_tokens,
            ${tokenAttr("output_tokens")} AS output_tokens
        FROM claude_code.otel_traces
        WHERE Timestamp >= {from:DateTime} AND Timestamp < {spanTo:DateTime}
          AND TraceId IN (SELECT TraceId FROM interactions)
        LIMIT 1 BY TraceId, SpanId
    )
    GROUP BY TraceId
)
SELECT t.TraceId AS trace_id, t.started_at AS started_at, t.duration_ms AS duration_ms,
    ${GROUP_EXPR} AS session_grp, s.llm_calls AS llm_calls, s.subagents AS subagents, s.calls AS calls
FROM interactions t
LEFT JOIN task_spans s ON t.TraceId = s.TraceId
LEFT JOIN session_group ug ON t.SessionId = ug.SessionId
WHERE 1 = 1 ${conds.map(c => `AND ${c}`).join("\n  ")}
ORDER BY ${order}
LIMIT ${TASK_LIMIT}`;
  return { sql, params };
}

// Reported cost per request; duplicate log deliveries of one request collapse to a
// non-NULL report when any delivery carries one.
export function claudeCostSql(from, to, requestIds) {
  return {
    sql: `SELECT request_id, anyIf(reported, reported IS NOT NULL) AS cost_usd
    FROM (
        SELECT LogAttributes['request_id'] AS request_id,
            toFloat64OrNull(LogAttributes['cost_usd']) AS reported
        FROM claude_code.otel_logs
        WHERE Timestamp >= {logFrom:DateTime} AND Timestamp < {logTo:DateTime}
          AND EventName IN ('api_request', 'claude_code.api_request')
          AND LogAttributes['request_id'] IN {requestIds:Array(String)}
    )
    GROUP BY request_id`,
    params: { logFrom: toChDateTime(from), logTo: toChDateTime(new Date(to.getTime() + SPAN_SLACK_MS)),
      requestIds },
  };
}

const count = (value) => {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

// Per-call Claude cost rule (spec "Decided behaviour"; ADR-017 for non-Anthropic models).
export function claudeCallCost({ model, backend, tokens, reported }) {
  if (isNonAnthropicModel(model)) {
    // Claude Code prices unknown models at Opus rates; the report is never used for them.
    const cost = requestListEstimate({ model, input_tokens: tokens.input, cache_read_tokens: tokens.cache_read,
      cache_creation_tokens: tokens.cache_write, output_tokens: tokens.output });
    return { cost_usd: Number.isFinite(cost) ? cost : null, basis: "aws_list_estimate" };
  }
  const report = reported === null || reported === undefined || reported === "" ? NaN : Number(reported);
  const known = TOKEN_FIELDS.every(k => tokens[k] !== null && tokens[k] !== undefined);
  const positive = known && TOKEN_FIELDS.some(k => tokens[k] > 0);
  // A zero report beside positive usage is not a usable report (costEfficiency.js rule).
  if (Number.isFinite(report) && report >= 0 && !(report === 0 && positive))
    return { cost_usd: report, basis: "client_reported" };
  const cost = known ? computeCost(model, backend, { input: tokens.input, output: tokens.output,
    cacheRead: tokens.cache_read, cacheWrite: tokens.cache_write }) : null;
  return { cost_usd: Number.isFinite(cost) ? cost : null, basis: "computed" };
}

function foldTask(row, costs) {
  const sums = Object.fromEntries(TOKEN_FIELDS.map(k => [k, null]));
  const observed = createObservedTokens();
  let tokensPartial = false, cost = null, unknownCost = 0;
  const bases = new Set(), knownBases = new Set(), models = new Set();
  for (const raw of Array.isArray(row.calls) ? row.calls : []) {
    const [requestId, model = "", ...values] = raw;
    const tokens = Object.fromEntries(TOKEN_FIELDS.map((k, i) => [k, count(values[i])]));
    if (model) models.add(normalizeModelId(model));
    for (const k of TOKEN_FIELDS) {
      if (tokens[k] === null) { tokensPartial = true; continue; }
      const next = (sums[k] ?? 0) + tokens[k];
      if (Number.isSafeInteger(next)) sums[k] = next;
      else { sums[k] = null; tokensPartial = true; }
    }
    const known = TOKEN_FIELDS.every(k => tokens[k] !== null);
    const total = known ? TOKEN_FIELDS.reduce((a, k) => a + tokens[k], 0) : null;
    addObservedTokens(observed, total, known && !Number.isSafeInteger(total));
    const backend = row.session_grp === "enterprise" ? "anthropic" : resolveBackend(model, "");
    const { cost_usd, basis } = claudeCallCost({ model, backend, tokens,
      reported: requestId && costs.has(requestId) ? costs.get(requestId) : null });
    bases.add(basis);
    if (cost_usd === null) unknownCost++;
    else { knownBases.add(basis); cost = (cost ?? 0) + cost_usd; }
  }
  const shown = knownBases.size ? knownBases : bases;
  const duration = count(row.duration_ms);
  return {
    id: `claude:${row.trace_id}`, client: "claude", started_at: row.started_at,
    duration_ms: duration, duration_basis: "interaction_span",
    models: [...models].sort(), llm_calls: count(row.llm_calls) ?? 0, subagents: count(row.subagents) ?? 0,
    tokens: { ...sums, ...finishObservedTokens(observed, { partial: tokensPartial }) },
    cost_usd: Number.isFinite(cost) ? cost : null,
    cost_partial: unknownCost > 0 || (cost !== null && !Number.isFinite(cost)),
    cost_basis: shown.size === 0 ? null : shown.size === 1 ? [...shown][0] : "mixed",
  };
}

const byTokens = (a, b) => (b.tokens.observed_tokens ?? -1) - (a.tokens.observed_tokens ?? -1)
  || (b.duration_ms ?? -1) - (a.duration_ms ?? -1) || a.id.localeCompare(b.id);
const byDuration = (a, b) => (b.duration_ms ?? -1) - (a.duration_ms ?? -1)
  || (b.tokens.observed_tokens ?? -1) - (a.tokens.observed_tokens ?? -1) || a.id.localeCompare(b.id);

export const sortTasks = (tasks, sort = "tokens") =>
  [...tasks].sort(sort === "duration" ? byDuration : byTokens).slice(0, TASK_LIMIT);

// Pure fold: SQL rows (one per interaction, per-call arrays) plus reported costs by request id.
export function foldClaudeTasks(taskRows, costRows, { sort = "tokens" } = {}) {
  const costs = new Map();
  for (const row of costRows) if (row.request_id) costs.set(row.request_id, row.cost_usd);
  return sortTasks(taskRows.map(row => foldTask(row, costs)), sort);
}

const CODEX_STREAM_EVENTS = "('codex.sse_event', 'codex.websocket_event')";

// Codex turns of the exact user: Codex has no turn-root span, so a turn is every span
// carrying its turn id; window = min start .. max end. Spans carry no usage. Turns whose
// spans carry no conversation id return ''. Spans are read in [from - 24h, to + 24h), the
// same 24h bound used forward for long tasks, so a turn that started before `from` is seen
// from its true start and never re-listed here with a truncated window. Turns starting
// outside [from, to) come back with in_bucket = 0 as attachment context only: a completion
// they win belongs to that neighbouring bucket and is neither listed nor counted as
// unattached here. Bucket turns sort first so a capped result keeps them.
export function codexTurnSql(from, to, q) {
  return {
    sql: `SELECT turn_id,
        toUInt8(min(Timestamp) >= {from:DateTime} AND min(Timestamp) < {to:DateTime}) AS in_bucket,
        anyIf(conversation, conversation != '') AS conversation_id,
        formatDateTime(min(Timestamp), '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS started_at,
        min(span_start_ms) AS start_ms,
        max(span_start_ms + span_duration_ms) AS end_ms,
        countIf(SpanName = 'codex.sampling') AS llm_calls,
        groupUniqArrayIf(span_model, SpanName = 'codex.sampling' AND span_model != '') AS models
    FROM (
        SELECT Timestamp, SpanName,
            toUnixTimestamp64Milli(Timestamp) AS span_start_ms,
            intDiv(Duration, 1000000) AS span_duration_ms,
            coalesce(nullIf(SpanAttributes['turn_id'], ''), SpanAttributes['turn.id']) AS turn_id,
            SpanAttributes['conversation.id'] AS conversation,
            coalesce(nullIf(SpanAttributes['model'], ''), SpanAttributes['gen_ai.request.model']) AS span_model
        FROM claude_code.otel_traces
        WHERE Timestamp >= {spanFrom:DateTime} AND Timestamp < {spanTo:DateTime}
          AND ResourceAttributes['client'] = 'codex'
          AND ${EXACT_USER}
        LIMIT 1 BY TraceId, SpanId
    )
    WHERE turn_id != ''
    GROUP BY turn_id
    ORDER BY in_bucket DESC, start_ms ASC, turn_id ASC
    LIMIT ${CODEX_TURN_LIMIT + 1}`,
    params: { from: toChDateTime(from), to: toChDateTime(to),
      spanFrom: toChDateTime(new Date(from.getTime() - SPAN_SLACK_MS)),
      spanTo: toChDateTime(new Date(to.getTime() + SPAN_SLACK_MS)), userExact: q.userExact },
  };
}

// Usage-bearing completions of the exact user in [from, to + 24h). One unique event is a
// DISTINCT (Timestamp, sorted resource map, sorted log map), as logSelection() defines it;
// `identity` names that event so the fold attaches it at most once. Only allowlisted
// attributes leave the database.
export function codexCompletionSql(from, to, q) {
  const tokens = COMPLETION_TOKEN_KEYS.map(k => `a['${k}'] AS ${k}`).join(",\n        ");
  return {
    sql: `SELECT toString(cityHash64(toString(Timestamp), toString(r), toString(a))) AS identity,
        toString(toUnixTimestamp64Milli(Timestamp)) AS timestamp_ms,
        a['event.timestamp'] AS event_timestamp,
        a['conversation.id'] AS conversation_id,
        a['model'] AS model,
        a['model_reasoning_effort'] AS effort,
        r['backend'] AS backend_tag,
        ${tokens}
    FROM (
        SELECT DISTINCT Timestamp, mapSort(ResourceAttributes) AS r, mapSort(LogAttributes) AS a
        FROM claude_code.otel_logs
        WHERE Timestamp >= {logFrom:DateTime} AND Timestamp < {logTo:DateTime}
          AND startsWith(EventName, 'codex.')
          AND ${EXACT_USER}
          AND LogAttributes['event.name'] IN ${CODEX_STREAM_EVENTS}
          AND LogAttributes['event.kind'] = 'response.completed'
    )
    WHERE a['event.name'] IN ${CODEX_STREAM_EVENTS}
      AND a['event.kind'] = 'response.completed'
      AND arrayExists(k -> mapContains(a, k), [${COMPLETION_TOKEN_KEYS.map(k => `'${k}'`).join(", ")}])
      AND coalesce(nullIf(r['user.email'], ''), nullIf(r['enduser.id'], ''), '') = {userExact:String}
    ORDER BY timestamp_ms
    LIMIT ${CODEX_COMPLETION_LIMIT + 1}`,
    params: { logFrom: toChDateTime(from), logTo: toChDateTime(new Date(to.getTime() + SPAN_SLACK_MS)),
      userExact: q.userExact },
  };
}

// Model ids are shown as labels; anything outside an id shape is dropped.
const modelLabel = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9_.:/+-]{0,127}$/i.test(value)
  ? value : null;

// Event time of a completion: the source event.timestamp, else the collector Timestamp
// (Codex 0.154 emits zero timeUnixNano, so Timestamp can be the later observed time).
function completionTime(row) {
  const source = typeof row.event_timestamp === "string" && row.event_timestamp !== ""
    ? Date.parse(row.event_timestamp) : NaN;
  if (Number.isFinite(source)) return source;
  const observed = count(row.timestamp_ms);
  return observed === null ? null : observed;
}

function foldCodexTask(turn, linked) {
  const sums = Object.fromEntries(TOKEN_FIELDS.map(k => [k, null]));
  const observed = createObservedTokens();
  let tokensPartial = false, cost = null, unknownCost = 0;
  const models = new Set((Array.isArray(turn.models) ? turn.models : []).map(modelLabel).filter(Boolean));
  for (const { row, usage } of linked) {
    const model = modelLabel(row.model);
    if (model) models.add(model);
    // Input includes cache reads/writes and output includes reasoning (ADR-014): the
    // components below are the uncached remainder plus each cache subset, never re-added.
    const parts = { input: usage.input_tokens, cache_read: usage.cache_read_tokens,
      cache_write: usage.cache_write_tokens, output: usage.output_tokens };
    for (const k of TOKEN_FIELDS) {
      if (parts[k] === null || parts[k] === undefined) { tokensPartial = true; continue; }
      const next = (sums[k] ?? 0) + parts[k];
      if (Number.isSafeInteger(next)) sums[k] = next;
      else { sums[k] = null; tokensPartial = true; }
    }
    addObservedTokens(observed, usage.observed_tokens);
    if (usage.cost_usd === null) unknownCost++;
    else cost = (cost ?? 0) + usage.cost_usd;
  }
  const start = count(turn.start_ms), end = count(turn.end_ms);
  return {
    id: `codex:${turn.conversation_id}:${turn.turn_id}`, client: "codex", started_at: turn.started_at,
    duration_ms: start !== null && end !== null && end >= start ? end - start : null,
    duration_basis: "observed_span_window",
    models: [...models].sort(), llm_calls: count(turn.llm_calls) ?? 0,
    // No Codex attribute links a child thread to its parent turn: unknown, not zero.
    subagents: null,
    tokens: { ...sums, ...finishObservedTokens(observed, { partial: tokensPartial }) },
    cost_usd: Number.isFinite(cost) ? cost : null,
    cost_partial: unknownCost > 0 || (cost !== null && !Number.isFinite(cost)),
    cost_basis: "linked_estimate",
  };
}

// Links each unique completion to the turn of its conversation whose [start, end + slack]
// contains its event time (latest start when several), at most once. Only bucket turns
// (in_bucket) become tasks; a completion won by a context turn belongs to that turn's
// bucket. Unattached counts only unlinked completions inside [from, to); later ones were
// read for attachment only. With a backend
// filter, a turn needs a linked completion on that backend (a turn without one is "unknown").
export function attachCompletions(turns, completions, { slackMs = COMPLETION_SLACK_MS,
  prices = codexPrices(), from = null, to = null, backend = "" } = {}) {
  const byConversation = new Map();
  let skippedTurns = 0;
  for (const turn of turns) {
    const start = count(turn.start_ms), end = count(turn.end_ms);
    // Rows without the flag (pure callers) are bucket turns.
    const inBucket = turn.in_bucket === undefined || Number(turn.in_bucket) === 1;
    if (!turn.conversation_id || !turn.turn_id || start === null || end === null) {
      if (inBucket) skippedTurns++;
      continue;
    }
    const list = byConversation.get(turn.conversation_id) ?? [];
    list.push({ turn, start, end, inBucket, linked: [] });
    byConversation.set(turn.conversation_id, list);
  }
  const seen = new Set();
  const lost = { completions: 0, cost: null, unknown: 0 };
  for (const row of completions) {
    if (row.identity) {
      if (seen.has(row.identity)) continue;
      seen.add(row.identity);
    }
    const time = completionTime(row);
    const usage = priceCodexCompletion(row, row.backend_tag, prices);
    let best = null;
    if (time !== null) for (const entry of byConversation.get(row.conversation_id) ?? []) {
      if (time < entry.start || time > entry.end + slackMs) continue;
      if (!best || entry.start > best.start || (entry.start === best.start && entry.turn.turn_id > best.turn.turn_id))
        best = entry;
    }
    if (best) { best.linked.push({ row, usage }); continue; }
    const inBucket = time !== null && (from === null || time >= from.getTime()) && (to === null || time < to.getTime());
    if (!inBucket || (backend && usage.backend !== backend)) continue;
    lost.completions++;
    if (usage.cost_usd === null) lost.unknown++;
    else lost.cost = (lost.cost ?? 0) + usage.cost_usd;
  }
  const tasks = [];
  for (const entries of byConversation.values()) for (const entry of entries) {
    if (!entry.inBucket) continue;
    if (backend && !(entry.linked.length ? entry.linked.some(l => l.usage.backend === backend) : backend === "unknown"))
      continue;
    tasks.push(foldCodexTask(entry.turn, entry.linked));
  }
  const lostCost = lost.completions === 0 ? 0 : lost.cost;
  return {
    tasks,
    unattached: { completions: lost.completions, cost_usd: Number.isFinite(lostCost) ? lostCost : null,
      cost_partial: lost.unknown > 0 || (lostCost !== null && !Number.isFinite(lostCost)) },
    skipped_turns: skippedTurns,
  };
}

async function claudeTasks(from, to, q, run) {
  const list = claudeTaskListSql(from, to, q);
  const rows = await run(list.sql, list.params);
  const ids = [...new Set(rows.flatMap(r => (Array.isArray(r.calls) ? r.calls : []).map(c => c[0]))
    .filter(Boolean))];
  let costRows = [];
  if (ids.length) {
    const cost = claudeCostSql(from, to, ids);
    costRows = await run(cost.sql, cost.params);
  }
  return foldClaudeTasks(rows, costRows, { sort: q.sort });
}

async function codexTasks(from, to, q, run, prices) {
  const turnQuery = codexTurnSql(from, to, q), completionQuery = codexCompletionSql(from, to, q);
  const [turns, completions] = await Promise.all([run(turnQuery.sql, turnQuery.params),
    run(completionQuery.sql, completionQuery.params)]);
  const limited = turns.length > CODEX_TURN_LIMIT || completions.length > CODEX_COMPLETION_LIMIT;
  const out = attachCompletions(turns.slice(0, CODEX_TURN_LIMIT), completions.slice(0, CODEX_COMPLETION_LIMIT),
    { prices, from, to, backend: q.backend });
  return { ...out, limited };
}

export async function userTasks(from, to, raw, enabledClients, run = defaultQuery, prices = codexPrices()) {
  const q = validateTaskQuery(raw, enabledClients);
  const coverage = { claude: "not_requested", codex: "not_requested" };
  let tasks = [], unattached = null;
  const [claude, codex] = await Promise.all([
    q.clients.includes("claude") ? claudeTasks(from, to, q, run) : null,
    q.clients.includes("codex") ? codexTasks(from, to, q, run, prices) : null,
  ]);
  if (claude) {
    tasks = claude;
    coverage.claude = claude.length ? "observed" : "empty";
  }
  if (codex) {
    tasks = sortTasks([...tasks, ...codex.tasks], q.sort);
    coverage.codex = codex.limited ? "limited" : codex.tasks.length ? "observed" : "empty";
    unattached = { ...codex.unattached, cost_partial: codex.unattached.cost_partial || codex.limited,
      turns_without_conversation: codex.skipped_turns };
  }
  return { tasks, unattached_codex: unattached, coverage, partial: true };
}
