// Per-user task list from traces (docs/superpowers/specs/2026-11-06-user-task-trace-design.md).
// A Claude task is one `interaction` span (its TraceId); its LLM calls are the trace's
// `llm_request` spans. Only trace-enabled users emit spans, so every response is partial.
// The payload carries no request ids, prompts, commands, paths or raw attributes.
import { query as defaultQuery, toChDateTime } from "./clickhouse.js";
import { ValidationError } from "./http.js";
import { selectClients } from "./clients.js";
import { validateClientFilters } from "./clientMetrics.js";
import { GROUP_CTE, GROUP_EXPR } from "./grouping.js";
import { backendSql, resolveBackend } from "./backend.js";
import { computeCost, normalizeModelId } from "./pricing.js";
import { isNonAnthropicModel, requestListEstimate } from "./nonAnthropicCost.js";
import { createObservedTokens, addObservedTokens, finishObservedTokens } from "./observedTokens.js";

export const TASK_LIMIT = 20;
// Subagent spans of a long task can start after the selected bucket ends (spec: ~12% of
// subagent llm_request spans had no interaction in the same 7-day window).
const SPAN_SLACK_MS = 24 * 3600000;
const SORTS = ["tokens", "duration"];
const TOKEN_FIELDS = ["input", "cache_read", "cache_write", "output"];

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
      AND coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, ''), '') = {userExact:String}
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
    ${GROUP_EXPR} AS grp, s.llm_calls AS llm_calls, s.subagents AS subagents, s.calls AS calls
FROM interactions t
LEFT JOIN task_spans s ON t.TraceId = s.TraceId
LEFT JOIN session_group ug ON t.SessionId = ug.SessionId
WHERE 1 = 1 ${conds.map(c => `AND ${c}`).join("\n  ")}
ORDER BY ${order}
LIMIT ${TASK_LIMIT}`;
  return { sql, params };
}

// Reported cost per request; any() collapses duplicate log deliveries of one request.
export function claudeCostSql(from, to, requestIds) {
  return {
    sql: `SELECT LogAttributes['request_id'] AS request_id,
        any(toFloat64OrNull(LogAttributes['cost_usd'])) AS cost_usd
    FROM claude_code.otel_logs
    WHERE Timestamp >= {logFrom:DateTime} AND Timestamp < {logTo:DateTime}
      AND EventName IN ('api_request', 'claude_code.api_request')
      AND LogAttributes['request_id'] IN {requestIds:Array(String)}
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
    const backend = row.grp === "enterprise" ? "anthropic" : resolveBackend(model, "");
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

// Pure fold: SQL rows (one per interaction, per-call arrays) plus reported costs by request id.
export function foldClaudeTasks(taskRows, costRows, { sort = "tokens" } = {}) {
  const costs = new Map();
  for (const row of costRows) if (row.request_id) costs.set(row.request_id, row.cost_usd);
  return taskRows.map(row => foldTask(row, costs))
    .sort(sort === "duration" ? byDuration : byTokens).slice(0, TASK_LIMIT);
}

export async function userTasks(from, to, raw, enabledClients, run = defaultQuery) {
  const q = validateTaskQuery(raw, enabledClients);
  // Codex tasks are not part of this response yet.
  const coverage = { claude: "not_requested", codex: "not_requested" };
  let tasks = [];
  if (q.clients.includes("claude")) {
    const list = claudeTaskListSql(from, to, q);
    const rows = await run(list.sql, list.params);
    const ids = [...new Set(rows.flatMap(r => (Array.isArray(r.calls) ? r.calls : []).map(c => c[0]))
      .filter(Boolean))];
    let costRows = [];
    if (ids.length) {
      const cost = claudeCostSql(from, to, ids);
      costRows = await run(cost.sql, cost.params);
    }
    tasks = foldClaudeTasks(rows, costRows, { sort: q.sort });
    coverage.claude = tasks.length ? "observed" : "empty";
  }
  return { tasks, unattached_codex: null, coverage, partial: true };
}
