import { query, toChDateTime } from "./clickhouse.js";
import { ValidationError } from "./http.js";
import { selectClients } from "./clients.js";
import { priceCodexUsage, parseCodexPricing } from "./codexPricing.js";
import { GROUP_CTE, GROUP_EXPR } from "./grouping.js";
import { normalizeModelId } from "./pricing.js";
import * as queries from "./queries.js";
import { createObservedTokens, addObservedTokens, finishObservedTokens } from "./observedTokens.js";
import { CODEX_USAGE_KEYS, REJECTED_REQUEST_STATUSES, SETUP_METADATA_EVENTS, isRejectedRequestGroup } from "./codexRequests.js";

const ROW_LIMIT = 50000;
export const codexPrices = parseCodexPricing(process.env.CODEX_PRICING_JSON);
const TOKEN_KEYS = ["tokens", "input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens"];
const OP_KEYS = ["requests", "rejected_requests", "api_errors", "tool_calls", "tool_errors"];
const finite = (n) => ["number", "string"].includes(typeof n) && String(n).trim() !== ""
  && Number.isFinite(Number(n)) && Number(n) >= 0;
const round = (n) => Number.isFinite(n * 1e12) ? Math.round(n * 1e12) / 1e12 : null;
// by_model_time reason keys per client; missing_usage is always counted separately.
const UNPRICED_REASONS = {
  claude: ["report_missing", "report_zero_with_tokens"],
  codex: ["unknown_backend", "scope", "unknown_model", "invalid_usage"],
};

export function validateClientFilters(raw, enabledClients) {
  const clients = selectClients(raw.client, enabledClients);
  if (raw.group || raw.project)
    throw new ValidationError("unsupported filter", "use Claude detail pages for channel or project filters");
  const result = { clients };
  for (const name of ["user", "model"]) {
    const value = raw[name];
    if (value !== undefined && (typeof value !== "string" || value.length > 256))
      throw new ValidationError("invalid filter", `${name} must be a string of at most 256 characters`);
    result[name] = value?.trim() || "";
  }
  const backend = raw.backend;
  if (backend !== undefined && backend !== "" && backend !== "all"
      && !["bedrock-mantle", "bedrock-runtime", "anthropic", "unknown"].includes(backend))
    throw new ValidationError("invalid backend", "select a supported backend");
  result.backend = backend && backend !== "all" ? backend : "";
  return result;
}

function accumulator(meta, reasons = false) {
  return { ...meta, ...Object.fromEntries([...TOKEN_KEYS, ...OP_KEYS].map((k) => [k, 0])),
    cost_usd: 0, unpriced: 0, observed_records: 0,
    _sessions: new Set(), _users: new Set(), _backends: new Set(), _missingUsage: new Set(),
    _missing: new Set(), _hasCost: false, _observedTokens: createObservedTokens(),
    _reasons: reasons ? {} : null,
    _ops: false, _requestMs: 0, _requestN: 0, _ttftMs: 0, _ttftN: 0 };
}

function usageScope(row, model = row.model || "") {
  return JSON.stringify([row.client, row.session || ["unidentified", row.t], row.user || "",
    row.backend || "unknown", row.project || "", model]);
}

function claudeUsage(row) {
  const counts = ["input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens"];
  const valid = counts.every((k) => finite(row[k]));
  const tokens = valid ? counts.reduce((n, k) => n + Number(row[k]), 0) : null;
  const report = finite(row.reported_cost) ? Number(row.reported_cost) : null;
  // A positive client report remains usable even if token telemetry is partial.
  // Zero is usable only alongside known zero token usage.
  const cost = report !== null && (report > 0 || valid && tokens === 0) ? report : null;
  // A usable report has no reason. Counter rows carry cost_observed; rows without it count as observed.
  const unpriced_reason = cost !== null ? null
    : report === null || Number(row.cost_observed ?? 1) === 0 ? "report_missing" : "report_zero_with_tokens";
  return { ...row, tokens, observed_tokens: tokens, reasoning_tokens: null, cost_usd: cost,
    cost_basis: "client_reported", unpriced: cost === null, unpriced_reason, invalid: !valid };
}

function accumulate(target, row, usage, missingScope) {
  if (row.session) target._sessions.add(`${row.client}:${row.session}`);
  if (row.user) target._users.add(row.user);
  if (row.backend) target._backends.add(row.backend);
  const n = Number(row.count ?? 1);
  // Logs supply deduplicated event counts; Claude counter rows each contribute one.
  // This is an observation/empty-state signal, not a cross-client request count.
  target.observed_records += n;
  if (missingScope) target._missingUsage.add(missingScope);
  if (usage) {
    addObservedTokens(target._observedTokens, usage.observed_tokens,
      Number(usage.observed_tokens_overflow) === 1);
    for (const k of TOKEN_KEYS) {
      if (!finite(usage[k])) target._missing.add(k);
      else target[k] += Number(usage[k]);
    }
    if (!finite(usage.cost_usd)) {
      target.unpriced += n || 1;
      if (target._reasons) {
        target._reasons[usage.unpriced_reason] = (target._reasons[usage.unpriced_reason] || 0) + (n || 1);
      }
    } else {
      target._hasCost = true;
      target.cost_usd += Number(usage.cost_usd);
    }
  } else if (row.kind === "request") {
    target._ops = true;
    target.requests += n;
    target.rejected_requests += Number(row.rejected_count || 0);
    target.api_errors += Number(row.errors || 0);
    target._requestMs += Number(row.duration_ms || 0);
    target._requestN += Number(row.duration_count || 0);
  } else if (row.kind === "tool") {
    target._ops = true;
    target.tool_calls += n;
    target.tool_errors += Number(row.errors || 0);
  } else if (row.kind === "stream_error") {
    target._ops = true;
    target.api_errors += n;
  } else if (row.kind === "ttft") {
    target._ttftMs += Number(row.duration_ms || 0);
    target._ttftN += Number(row.duration_count || 0);
  }
}

function finish(target) {
  const { _sessions, _users, _backends, _missing, _missingUsage, _hasCost, _observedTokens, _reasons,
    _ops, _requestMs, _requestN, _ttftMs, _ttftN, ...out } = target;
  for (const k of _missing) out[k] = null;
  if (_missingUsage.size) {
    for (const k of TOKEN_KEYS) out[k] = null;
    out.unpriced += _missingUsage.size;
  }
  if (out.client === "claude" && !_ops) for (const k of OP_KEYS) out[k] = null;
  // Preserve known zero, but never turn a group containing only unknown costs
  // into free usage. Missing records remain visible through the partial flag.
  const costAvailable = _hasCost || out.unpriced === 0;
  const cost = costAvailable ? round(out.cost_usd) : null;
  return { ...out, ...finishObservedTokens(_observedTokens, {
    partial: out.tokens === null, emptyValue: out.tokens === 0 ? 0 : null,
  }), sessions: _sessions.size, users: _users.size,
    backend: out.backend || (_backends.size === 1 ? [..._backends][0] : _backends.size ? "mixed" : "unknown"),
    cost_usd: cost,
    cost_partial: out.unpriced > 0 || costAvailable && cost === null,
    request_rejections_only: out.client === "codex" && out.rejected_requests > 0
      && out.rejected_requests === out.observed_records && _missingUsage.size === 0,
    request_duration_ms: _requestN ? _requestMs / _requestN : null,
    ttft_ms: _ttftN ? _ttftMs / _ttftN : null,
    ...(_reasons ? { unpriced_reasons: {
      ...Object.fromEntries((UNPRICED_REASONS[out.client] || []).map((k) => [k, 0])),
      ..._reasons, missing_usage: _missingUsage.size } } : {}) };
}

export function foldClientMetrics(records, clients, prices = codexPrices, { modelTime = false } = {}) {
  // Idle observations have their own bound; they cannot evict usage records
  // from the existing active-row budget.
  const idleRows = records.filter(row => row.client === "claude" && Number(row.timeline_only) === 1).length;
  if (records.length - idleRows > ROW_LIMIT || idleRows > ROW_LIMIT)
    throw new ValidationError("too much client data", "narrow the requested date range");
  const totals = accumulator({});
  const byClient = new Map(clients.map((client) => [client, accumulator({ client,
    cost_basis: client === "claude" ? "client_reported" : "aws_list_estimate" })]));
  const groups = { by_model: new Map(), by_user: new Map(), by_project: new Map(), timeseries: new Map(),
    ...(modelTime ? { by_model_time: new Map() } : {}) };
  const tools = new Map();
  const quality = { unpriced: 0, invalid: 0, missing_identity: 0, missing_usage: 0 };
  // Availability spans the requested range: request/completion exports can straddle
  // buckets. A different session/model/backend/user/project cannot fill the gap.
  const usageScopes = new Set();
  const usageSessions = new Set();
  const requiringUsage = new Set(), requiringSessions = new Set();
  for (const row of records) {
    if (row.client !== "codex") continue;
    if (!isRejectedRequestGroup(row)) {
      requiringUsage.add(usageScope(row));
      if (row.session) requiringSessions.add(usageScope(row, null));
    }
    if (row.kind !== "usage") continue;
    usageScopes.add(usageScope(row));
    if (row.session) usageSessions.add(usageScope(row, null));
  }
  const missingUsage = new Set();
  // by_model_time keeps a row only when usage (Claude counters, Codex usage-bearing completions)
  // or a Codex missing-usage scope backs it. Operational rows attach but never create a known $0;
  // idle uncertainty stays in timeseries.
  const backedModelTime = new Set();
  for (const row of records) {
    if (!byClient.has(row.client)) continue;
    // Repeated, unchanged Claude counters prove an observed zero for this bucket.
    // They do not make idle sessions/users active or add model/quality records.
    if (row.client === "claude" && Number(row.timeline_only) === 1) {
      const meta = { client: row.client, t: row.t };
      const key = JSON.stringify(meta);
      const zero = groups.timeseries.get(key) || accumulator({ ...meta, cost_basis: "client_reported" });
      zero.timeline_observed = true;
      zero._missing.add("reasoning_tokens");
      if (Number(row.token_observed) === 1) addObservedTokens(zero._observedTokens, 0);
      if (Number(row.token_observed) !== 1 || Number(row.token_missing) > 0) {
        for (const field of TOKEN_KEYS) zero._missing.add(field);
      }
      zero._hasCost ||= Number(row.cost_observed) === 1;
      zero.unpriced += Number(row.cost_missing) || (Number(row.cost_observed) === 1 ? 0 : 1);
      groups.timeseries.set(key, zero);
      continue;
    }
    const scope = usageScope(row);
    const missingScope = row.client === "codex"
      && (!isRejectedRequestGroup(row) || requiringUsage.has(scope)
        || (row.session && !row.model && requiringSessions.has(usageScope(row, null))))
      && !usageScopes.has(scope)
      && !(row.session && !row.model && usageSessions.has(usageScope(row, null))) ? scope : null;
    if (missingScope) missingUsage.add(missingScope);
    const usage = row.kind === "usage" ? (row.client === "codex" ? priceCodexUsage(row, prices) : claudeUsage(row)) : null;
    if (usage) {
      quality.unpriced += usage.unpriced ? Number(row.count || 1) : 0;
      quality.invalid += usage.invalid ? Number(row.invalid || row.count || 1) : 0;
      quality.missing_identity += row.user ? 0 : Number(row.count || 1);
    }
    accumulate(totals, row, usage, missingScope);
    accumulate(byClient.get(row.client), row, usage, missingScope);
    const dimensions = {
      by_model: { client: row.client, backend: row.backend || "unknown", model: row.model || "" },
      by_user: { client: row.client, user: row.user || "" },
      timeseries: { client: row.client, t: row.t },
    };
    if (row.client === "codex") dimensions.by_project = { client: row.client, project: row.project || "" };
    if (modelTime) dimensions.by_model_time = { client: row.client, t: row.t, model: row.model || "", backend: row.backend || "unknown" };
    for (const [key, meta] of Object.entries(dimensions)) {
      const id = JSON.stringify(meta);
      if (key === "by_model_time" && (row.kind === "usage" || missingScope)) backedModelTime.add(id);
      if (!groups[key].has(id)) groups[key].set(id, accumulator({ ...meta,
        cost_basis: row.client === "claude" ? "client_reported" : "aws_list_estimate" }, key === "by_model_time"));
      accumulate(groups[key].get(id), row, usage, missingScope);
    }
    if (row.kind === "tool") {
      const key = JSON.stringify([row.client, row.tool]);
      const tool = tools.get(key) || { client: row.client, tool: row.tool || "(unknown)",
        calls: 0, errors: 0, duration_ms: 0 };
      tool.calls += Number(row.count || 0);
      tool.errors += Number(row.errors || 0);
      tool.duration_ms = tool.duration_ms === null || Number(row.duration_count || 0) < Number(row.count || 0)
        ? null : tool.duration_ms + Number(row.duration_ms || 0);
      tools.set(key, tool);
    }
  }
  const by_client = [...byClient.values()].map(finish);
  const total = finish(totals);
  quality.missing_usage = missingUsage.size;
  quality.unpriced += missingUsage.size;
  // These are distinct emitted identity strings, not a verified employee directory.
  for (const k of OP_KEYS) if (by_client.some((r) => r[k] === null)) total[k] = null;
  for (const k of ["request_duration_ms", "ttft_ms"]) if (by_client.some((r) => r[k] === null)) total[k] = null;
  return { clients, observed_records: total.observed_records, totals: total, by_client,
    by_model: [...groups.by_model.values()].map(finish).sort((a, b) => (b.observed_tokens || 0) - (a.observed_tokens || 0)),
    by_user: [...groups.by_user.values()].map(finish).sort((a, b) => (b.observed_tokens || 0) - (a.observed_tokens || 0)),
    by_project: [...groups.by_project.values()].map(finish).sort((a, b) => (b.observed_tokens || 0) - (a.observed_tokens || 0)),
    timeseries: [...groups.timeseries.values()].map(finish).sort((a, b) => String(a.t).localeCompare(String(b.t)) || a.client.localeCompare(b.client)),
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls), quality,
    ...(modelTime ? { by_model_time: [...groups.by_model_time].filter(([id]) => backedModelTime.has(id))
      .map(([, group]) => finish(group)).sort((a, b) => String(a.t).localeCompare(String(b.t)) || a.client.localeCompare(b.client) || a.model.localeCompare(b.model) || a.backend.localeCompare(b.backend)) } : {}) };
}

// Streaming delta events: bulk scope evidence only (no usage keys, never priced).
const CODEX_DELTA_EVENT = "EventName IN ('codex.sse_event', 'codex.websocket_event') AND endsWith(LogAttributes['event.kind'], '.delta')";

export function buildCodexQuery(from, to, filters = {}, prices = codexPrices, client = "codex") {
  const isCodex = client === "codex";
  const params = { from: toChDateTime(from), to: toChDateTime(to),
    clientUser: filters.user || "", clientModel: (isCodex ? filters.model : normalizeModelId(filters.model || "")) || "",
    clientBackend: filters.backend || "",
    clientBucketSeconds: to - from <= 4 * 3600000 ? 60 : 3600 };
  const cases = Object.entries(prices).map(([model, rate], i) => {
    params[`priceModel${i}`] = model;
    params[`priceLimit${i}`] = rate.short_context_limit;
    return `base_model = {priceModel${i}:String}, {priceLimit${i}:UInt64}`;
  });
  const threshold = cases.length ? `multiIf(${cases.join(", ")}, 0)` : "0";
  const prefix = isCodex ? "codex." : "";
  const eventNames = ["api_request", "api_error", "tool_result", "tool_decision", "turn_ttft"]
    .flatMap((name) => isCodex ? [`codex.${name}`] : [name, `claude_code.${name}`]);
  if (isCodex) eventNames.unshift("codex.sse_event", "codex.websocket_event");
  const tokenFields = [
    ["input_token_count", "in_n", "input_tokens_total"],
    ["cached_token_count", "read_n", "cache_read_tokens"],
    ["cache_write_token_count", "write_n", "cache_write_tokens"],
    ["output_token_count", "out_n", "output_tokens"],
    ["reasoning_token_count", "reason_n", "reasoning_tokens"],
  ];
  const tokenValues = tokenFields.map(([key, n]) => `
      toFloat64OrZero(a['${key}']) AS ${n},
      (mapContains(a, '${key}') AND isNotNull(toFloat64OrNull(a['${key}']))
        AND isFinite(${n}) AND ${n} >= 0 AND floor(${n}) = ${n}
        AND ${n} <= 9007199254740991) AS ${n}_valid`).join(",");
  const tokenSums = tokenFields.map(([, n, field]) => {
    const subsetValid = n === "read_n" || n === "write_n" ? " AND NOT cache_invalid"
      : n === "reason_n" ? " AND NOT reasoning_invalid" : "";
    return `if(countIf(kind = 'usage' AND NOT (${n}_valid${subsetValid})) > 0,
      NULL, sum(${n})) AS ${field}`;
  }).join(",\n    ");
  // Separate malformed usage before token sums; otherwise one bad response
  // erases the valid responses' priceable components in the same SQL group.
  const validUsage = `${tokenFields.map(([, n]) => `${n}_valid`).join(" AND ")}
    AND NOT cache_invalid AND NOT reasoning_invalid`;
  // Pair validity is independent of cache/reasoning metadata and model rates.
  // Keep known pairs apart from unknown pairs even inside malformed usage.
  const validPair = "in_n_valid AND out_n_valid AND in_n + out_n <= 9007199254740991";
  const session = isCodex ? "a['conversation.id']" : "SessionId";
  const backend = isCodex ? "if(r['backend'] IN ('bedrock-runtime','bedrock-mantle'), r['backend'], 'unknown')"
    : `multiIf(${GROUP_EXPR} = 'bedrock', 'bedrock-runtime', ${GROUP_EXPR} = 'enterprise', 'anthropic', 'unknown')`;
  const user = "coalesce(nullIf(ResourceAttributes['user.email'], ''), nullIf(ResourceAttributes['enduser.id'], ''), '')";
  const modelMatch = "positionCaseInsensitive(model, {clientModel:String}) > 0";
  // Coarse attribution only for model-less rows: evidence must share the selected
  // client's session/user/backend/project and range. Never replace an emitted model.
  const modelSessions = filters.model ? `model_sessions AS (
    SELECT session, user, backend, project FROM unique_events WHERE session != '' AND ${modelMatch}
    ${isCodex ? `AND event_name IN (${eventNames.map(name => `'${name}'`).join(",")})` : ""}
    ${isCodex ? "" : `UNION ALL
    SELECT SessionId, ${user}, ${backend}, ResourceAttributes['project.name']
    FROM claude_code.otel_metrics_sum LEFT JOIN session_group ug USING (SessionId)
    WHERE TimeUnix >= {from:DateTime} AND TimeUnix < {to:DateTime} AND SessionId != ''
      AND MetricName IN ('claude_code.token.usage', 'claude_code.cost.usage')
      AND positionCaseInsensitive(${queries.normModel("Model")}, {clientModel:String}) > 0`}
  ),` : "";
  const sql = `${isCodex ? "WITH" : `${GROUP_CTE},`}
  unique_events AS (
    SELECT DISTINCT Timestamp, mapSort(ResourceAttributes) AS r, mapSort(LogAttributes) AS a,
      ${session} AS session,
      ${user} AS user,
      ${isCodex ? "a['model']" : queries.normModel("a['model']")} AS model,
      ${backend} AS backend, r['project.name'] AS project,
      ${isCodex ? "EventName" : "replaceRegexpOne(EventName, '^claude_code\\\\.', '')"} AS event_name
    FROM claude_code.otel_logs
    ${isCodex ? "" : "LEFT JOIN session_group ug USING (SessionId)"}
    WHERE Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime}
      AND ${isCodex ? `startsWith(EventName, 'codex.') AND NOT (${CODEX_DELTA_EVENT})`
        : `EventName IN (${eventNames.map((name) => `'${name}'`).join(", ")})`}${isCodex ? `
    -- Stream deltas are ~99% of Codex log rows and only ever act as scope evidence, whose
    -- presence (not count) feeds requires_usage; the final SELECT drops those rows. One row per
    -- scope keeps that evidence without a full-row DISTINCT over millions of maps.
    UNION ALL
    SELECT min(Timestamp), any(mapSort(ResourceAttributes)), any(mapSort(LogAttributes)),
      LogAttributes['conversation.id'] AS session, ${user} AS user, LogAttributes['model'] AS model,
      ${backend.replaceAll("r['", "ResourceAttributes['")} AS backend,
      ResourceAttributes['project.name'] AS project, EventName AS event_name
    FROM claude_code.otel_logs
    WHERE Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime} AND ${CODEX_DELTA_EVENT}
    GROUP BY session, user, model, backend, project, event_name` : ""}
  ), ${modelSessions} typed AS (
    SELECT *,
      replaceRegexpOne(model, '^(us|global)\\\\.', '') AS base_model,
      multiIf(event_name IN ('codex.sse_event','codex.websocket_event')
          AND a['event.kind'] = 'response.completed'
          AND arrayExists(k -> mapContains(a, k),
            ['input_token_count','output_token_count','cached_token_count','cache_write_token_count','reasoning_token_count']), 'usage',
        event_name IN ('codex.sse_event','codex.websocket_event')
          AND a['event.kind'] = 'response.completed', 'completion',
        event_name IN ('codex.sse_event','codex.websocket_event')
          AND a['event.kind'] = 'response.failed', 'stream_error',
        event_name IN ('codex.sse_event','codex.websocket_event'), 'scope_evidence',
        event_name IN ('${prefix}api_request','${prefix}api_error'), 'request',
        event_name = '${prefix}tool_result', 'tool',
        event_name = '${prefix}tool_decision', 'approval',
        event_name = '${prefix}turn_ttft', 'ttft',
        ${isCodex ? `(event_name NOT IN (${SETUP_METADATA_EVENTS.map(name => `'${name}'`).join(",")})
          OR arrayExists(k -> mapContains(a,k), [${CODEX_USAGE_KEYS.map(key => `'${key}'`).join(",")}])),
          'scope_evidence',` : ""} '') AS kind,
      ${tokenValues},
      (in_n_valid AND read_n_valid AND write_n_valid AND read_n + write_n > in_n) AS cache_invalid,
      (out_n_valid AND reason_n_valid AND reason_n > out_n) AS reasoning_invalid
    FROM unique_events
    WHERE ({clientUser:String} = '' OR positionCaseInsensitive(user, {clientUser:String}) > 0)
      ${filters.model ? `AND (${modelMatch} OR (model = '' AND
        (session, user, backend, project) IN (SELECT * FROM model_sessions)))` : ""}
      AND ({clientBackend:String} = '' OR backend = {clientBackend:String})
  ), grouped AS (
  SELECT if(kind = 'scope_evidence', '',
    formatDateTime(greatest(toStartOfInterval(Timestamp, INTERVAL {clientBucketSeconds:UInt32} SECOND), {from:DateTime}),
      '%Y-%m-%dT%H:%i:%SZ', 'UTC')) AS t,
    session, user, model, backend, project, kind, if(kind = 'scope_evidence', '', a['tool_name']) AS tool,
    if(kind != 'scope_evidence' AND in_n > ${threshold}, 'long', 'short') AS context_tier,
    (kind != 'usage' OR (${validUsage})) AS usage_valid,
    (kind != 'usage' OR (${validPair})) AS token_pair_valid,
    (kind = 'usage' AND token_pair_valid
      AND sum(in_n) + sum(out_n) > 9007199254740991) AS observed_tokens_overflow,
    count() AS count,
    countIf(kind = 'request'
      AND trimBoth(a['http.response.status_code']) IN (${REJECTED_REQUEST_STATUSES.map(s => `'${s}'`).join(",")})
      AND NOT arrayExists(k -> mapContains(a,k), [${CODEX_USAGE_KEYS.map(k => `'${k}'`).join(",")}])) AS rejected_count,
    ${tokenSums},
    countIf(kind = 'usage' AND NOT (${validUsage})) AS invalid,
    countIf(event_name = '${prefix}api_error' OR toInt32OrZero(trimBoth(a['http.response.status_code'])) >= 400
      OR a['success'] = 'false' OR a['error'] != '') AS errors,
    sumIf(toFloat64OrZero(a['duration_ms']), isFinite(toFloat64OrZero(a['duration_ms'])) AND toFloat64OrZero(a['duration_ms']) >= 0) AS duration_ms,
    countIf(isNotNull(toFloat64OrNull(a['duration_ms'])) AND isFinite(toFloat64OrZero(a['duration_ms']))
      AND toFloat64OrZero(a['duration_ms']) >= 0) AS duration_count
  FROM typed WHERE kind != ''
  GROUP BY t, session, user, model, backend, project, kind, tool, context_tier, usage_valid, token_pair_valid
  ), covered AS (
    -- Window only compacted scopes/groups, never raw diagnostic volume. Keep
    -- evidence in this table read and remove markers after evaluating coverage.
    SELECT *,
      (max(NOT (kind = 'request' AND rejected_count = count)) OVER
        (PARTITION BY session, user, backend, project, model)
       OR max(model = '' AND NOT (kind = 'request' AND rejected_count = count)) OVER
        (PARTITION BY session, user, backend, project)
       OR (model = '' AND max(NOT (kind = 'request' AND rejected_count = count)) OVER
        (PARTITION BY session, user, backend, project))) AS requires_usage
    FROM grouped
  )
  SELECT * FROM covered WHERE kind != 'scope_evidence'
  ORDER BY t LIMIT ${ROW_LIMIT + 1}`;
  return { sql, params };
}

export async function clientOverview(from, to, raw, enabledClients) {
  const filters = validateClientFilters(raw, enabledClients);
  const requestedTo = to;
  if (filters.clients.includes("claude")) {
    const resolved = queries.range(from, to, to - from <= 4 * 3600000);
    to = new Date(resolved.to.replace(" ", "T") + "Z");
  }
  const jobs = [];
  for (const client of filters.clients) {
    if (client === "claude") {
      jobs.push(queries.clientClaudeRows(from, to, filters)
        .then((rows) => rows.map((row) => ({ ...row, client, kind: "usage" }))));
    }
    const { sql, params } = buildCodexQuery(from, to, filters, codexPrices, client);
    jobs.push(query(sql, params).then((rows) => {
      if (rows.length > ROW_LIMIT) throw new ValidationError("too much client data", "narrow the requested date range");
      return rows.map((row) => ({ ...row, client }));
    }));
  }
  const lists = await Promise.all(jobs);
  // The route validates modelTime; only the literal "1" enables the dimension.
  const modelTime = raw.modelTime === "1";
  return { ...foldClientMetrics(lists.flat(), filters.clients, codexPrices, { modelTime }),
    effective_range: { from: from.toISOString(), to: to.toISOString(), requested_to: requestedTo.toISOString() },
    bucket_hours: to - from <= 4 * 3600000 ? 1 / 60 : 1 };
}
