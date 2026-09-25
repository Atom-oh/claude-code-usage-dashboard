import { toChDateTime } from "./clickhouse.js";
import { ValidationError } from "./http.js";
import { codexModel, parseCodexPricing, priceCodexUsage } from "./codexPricing.js";
import { createObservedTokens, addObservedTokens, finishObservedTokens } from "./observedTokens.js";
import { CODEX_USAGE_KEYS, isRejectedRequestEvent, isSetupMetadataEvent as setupMetadata } from "./codexRequests.js";
import { resolveBackend, backendSql } from "./backend.js";

const ROW_LIMIT = 50000;
const pricesDefault = parseCodexPricing(process.env.CODEX_PRICING_JSON);
const TOKEN_FIELDS = { input_token_count: "input_tokens_total", cached_token_count: "cache_read_tokens",
  cache_write_token_count: "cache_write_tokens", output_token_count: "output_tokens",
  reasoning_token_count: "reasoning_tokens" };
// Keep coarse model attribution aligned with clientMetrics' selected log evidence.
const OVERVIEW_EVENTS = ["sse_event", "websocket_event", "api_request", "api_error",
  "tool_result", "tool_decision", "turn_ttft"].map((name) => `codex.${name}`);

const DETAIL_ATTRIBUTES = [...CODEX_USAGE_KEYS, "event.name", "event.kind", "conversation.id", "model",
  "model_reasoning_effort", "attempt", "duration_ms", "error.message", "error", "success",
  "http.response.status_code", "prompt_length", "tool_name", "decision", "source", "app.version",
  "provider_name", "reasoning_effort", "sandbox_policy", "approval_policy", "startup.phase", "stream.models"];
const DETAIL_RESOURCES = ["user.email", "enduser.id", "backend", "project.name", "service.version"];
const sqlStrings = (values) => `[${values.map((v) => `'${v}'`).join(",")}]`;

export function logSelection(from, to, filters = {}, distinct = true) {
  const params = { from: toChDateTime(from), to: toChDateTime(to),
    clientUser: filters.user || "", clientModel: filters.model || "", clientBackend: filters.backend || "" };
  const modelMatch = "positionCaseInsensitive(model, {clientModel:String}) > 0";
  const sql = `WITH unique_events AS (
    SELECT ${distinct ? "DISTINCT " : ""}Timestamp, mapSort(ResourceAttributes) AS r, mapSort(LogAttributes) AS a,
      a['conversation.id'] AS session,
      coalesce(nullIf(r['user.email'], ''), nullIf(r['enduser.id'], ''), '') AS user,
      a['model'] AS model,
      ${backendSql("a['model']", "r['backend']")} AS backend,
      r['project.name'] AS project
    FROM claude_code.otel_logs
    WHERE Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime}
      AND startsWith(EventName, 'codex.')
  )${filters.model ? `, model_sessions AS (
    SELECT session, user, project FROM unique_events
    WHERE session != '' AND ${modelMatch}
      AND a['event.name'] IN (${OVERVIEW_EVENTS.map((name) => `'${name}'`).join(", ")})
  )` : ""}
  SELECT toString(toTimeZone(Timestamp, 'UTC')) AS timestamp, r AS resource, a AS attributes
  FROM unique_events
  WHERE ({clientUser:String} = '' OR positionCaseInsensitive(user, {clientUser:String}) > 0)
    AND ({clientBackend:String} = '' OR backend = {clientBackend:String})
    ${filters.model ? `AND (${modelMatch} OR (model = '' AND
      (session, user, project) IN (SELECT * FROM model_sessions)))` : ""}`;
  return { sql, params };
}

export function buildCodexInsightsLogQuery(from, to, filters = {}, { detailsOnly = false } = {}) {
  // The detail statement itself groups full event identities and stream scopes.
  // Its scope evidence and priced rows therefore share one table read/snapshot.
  const selection = logSelection(from, to, filters, !detailsOnly);
  if (!detailsOnly) return { ...selection, sql: `${selection.sql} ORDER BY timestamp LIMIT ${ROW_LIMIT + 1}` };
  return { params: selection.params, sql: `WITH selected AS (${selection.sql}),
    detail_source AS (
      SELECT *, attributes['conversation.id'] AS session,
        (attributes['event.name'] IN ('codex.sse_event','codex.websocket_event')
          AND attributes['event.kind'] NOT IN ('response.completed','response.failed')) AS is_bulk,
        if(is_bulk, '', timestamp) AS identity_time,
        if(is_bulk, map('user.email',coalesce(nullIf(resource['user.email'],''),resource['enduser.id']),
          'backend',${backendSql("''", "resource['backend']")},
          'project.name',resource['project.name']),resource) AS identity_resource,
        if(is_bulk, map('conversation.id',session),attributes) AS identity_attributes
      FROM selected WHERE startsWith(attributes['event.name'],'codex.')
    )
    SELECT is_bulk AS is_scope, max(timestamp) AS timestamp,
      mapFilter((k,v) -> has(${sqlStrings(DETAIL_RESOURCES)},k),identity_resource) AS resource,
      mapApply((k,v) -> (k,if(k IN ('error','error.message'),if(v='','','present'),v)),
        mapFilter((k,v) -> has(${sqlStrings(DETAIL_ATTRIBUTES)},k),
          if(is_bulk, map('conversation.id',identity_attributes['conversation.id'],
            'stream.models',toJSONString(groupUniqArray(detail_source.attributes['model']))),identity_attributes))) AS attributes
    FROM detail_source WHERE NOT is_bulk OR session != ''
    GROUP BY is_bulk, identity_time, identity_resource, identity_attributes
    ORDER BY timestamp LIMIT ${ROW_LIMIT + 1}` };
}

export function buildCodexLogSummaryQuery(from, to, filters = {}) {
  const selection = logSelection(from, to, filters);
  const measured = "event IN ('codex.sse_event','codex.websocket_event') AND isNotNull(latency_value) AND isFinite(latency_value) AND latency_value >= 0";
  return { params: selection.params, sql: `WITH selected AS (${selection.sql}),
    summary_events AS (
      SELECT timestamp, attributes['event.name'] AS event,
        toFloat64OrNull(trimBoth(attributes['duration_ms'])) AS latency_value
      FROM selected WHERE startsWith(attributes['event.name'], 'codex.')
    )
    SELECT grouping(event) AS is_total, event, count() AS records, max(timestamp) AS last_seen,
      countIf(${measured}) AS duration_count,
      avgOrNullIf(latency_value, ${measured}) AS average_ms,
      quantilesExactWeightedIf(0.5, 0.95)(ifNull(latency_value, 0), toUInt64(1), ${measured}) AS percentiles,
      maxOrNullIf(latency_value, ${measured}) AS max_ms
    FROM summary_events GROUP BY GROUPING SETS ((), (event))
    ORDER BY is_total DESC, event LIMIT ${ROW_LIMIT + 1}` };
}

export function foldCodexLogSummary(rows) {
  if (rows.length > ROW_LIMIT) throw new ValidationError("too much Codex log data", "too many event categories");
  if (!rows.length) return { coverage: { status: "empty", records: 0, last_seen: null }, events: [], latency: [] };
  const total = rows.find((row) => Number(row.is_total) === 1);
  const records = count(total?.records);
  if (records === null) throw new Error("Invalid Codex log summary");
  const events = [], latency = [];
  for (const row of rows.filter((r) => Number(r.is_total) === 0)) {
    const n = count(row.records);
    if (n === null) throw new Error("Invalid Codex event count");
    events.push({ event: row.event, count: n });
    const samples = count(row.duration_count);
    if (samples === null) throw new Error("Invalid Codex stream duration count");
    if (["codex.sse_event", "codex.websocket_event"].includes(row.event) && samples > 0) {
      latency.push({ name: row.event.slice(6), count: samples, average_ms: number(row.average_ms),
        p50_ms: number(row.percentiles?.[0]), p95_ms: number(row.percentiles?.[1]), max_ms: number(row.max_ms) });
    }
  }
  const stamp = records ? new Date(String(total.last_seen).replace(" ", "T").replace(/(?<!Z)$/, "Z")) : null;
  return { coverage: { status: records ? "observed" : "empty", records,
    last_seen: stamp && Number.isFinite(+stamp) ? stamp.toISOString() : null },
    events: events.sort(byName("event")), latency: latency.sort(byName("name")) };
}

function number(value) {
  if (!["string", "number"].includes(typeof value) || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
const count = (value) => Number.isSafeInteger(number(value)) ? number(value) : null;
const text = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9_.+ -]{0,127}$/i.test(value)
  ? value : "unknown";
const flag = (value) => value === "true" || value === true ? true
  : value === "false" || value === false ? false : null;
const ratio = (n, d) => n !== null && d > 0 ? n / d : null;
const rounded = (n) => n !== null && Number.isFinite(n * 1e12) ? Math.round(n * 1e12) / 1e12 : null;
const sortedMap = (map) => Object.entries(map || {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
const byName = (key) => (a, b) => a[key].localeCompare(b[key]);
const SANDBOX_POLICIES = new Set(["read-only", "workspace-write", "danger-full-access", "external-sandbox"]);
const APPROVAL_POLICIES = new Set(["never", "untrusted", "unless-trusted", "on-request", "on-failure", "reject"]);

function policyName(raw, allowed) {
  if (allowed.has(raw)) return raw;
  if (typeof raw !== "string" || raw.length > 4096) return "unknown";
  try {
    const value = JSON.parse(raw);
    const name = typeof value === "string" ? value : value?.type || value?.name
      || (value && Object.keys(value).length === 1 ? Object.keys(value)[0] : null);
    return allowed.has(name) ? name : "unknown";
  } catch { return "unknown"; }
}

function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  // Exact empirical nearest-rank percentiles, never percentiles of bucket means.
  const quantile = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  return { count: sorted.length,
    average_ms: sorted.length ? sorted.reduce((sum, n) => sum + n / sorted.length, 0) : null,
    p50_ms: quantile(0.5), p95_ms: quantile(0.95), max_ms: sorted.at(-1) ?? null };
}

function scope(row, includeModel = true, model = row.attributes.model) {
  const a = row.attributes, r = row.resource;
  const identity = [a["conversation.id"] || ["unidentified", row.timestamp],
    r["user.email"] || r["enduser.id"] || "", r["project.name"] || ""];
  return JSON.stringify(includeModel
    ? [...identity, resolveBackend(a.model, r.backend), model || ""] : identity);
}
const stream = (event) => ["codex.sse_event", "codex.websocket_event"].includes(event);
const completed = (row) => stream(row.attributes["event.name"])
  && row.attributes["event.kind"] === "response.completed";
const hasUsage = (row) => completed(row)
  && Object.keys(TOKEN_FIELDS).some((key) => Object.hasOwn(row.attributes, key));

function usageTotals() {
  return { requests: 0, tokens: 0, cost_usd: 0, hasCost: false, unpriced: 0,
    input: 0, read: 0, write: 0, output: 0, reasoning: 0, observedTokens: createObservedTokens() };
}

function addUsage(target, usage) {
  target.requests++;
  addObservedTokens(target.observedTokens, usage.observed_tokens);
  target.unpriced += Number(usage.unpriced);
  if (Number.isFinite(usage.cost_usd)) {
    target.hasCost = true;
    const sum = target.cost_usd === null ? null : target.cost_usd + usage.cost_usd;
    target.cost_usd = Number.isFinite(sum) ? sum : null;
  }
  for (const [key, value] of Object.entries({ tokens: usage.tokens,
    input: usage.input_tokens_total, read: usage.cache_read_tokens, write: usage.cache_write_tokens,
    output: usage.output_tokens, reasoning: usage.reasoning_tokens })) {
    const sum = target[key] === null || value === null ? null : target[key] + value;
    target[key] = Number.isSafeInteger(sum) ? sum : null;
  }
}
function fractions(total) {
  return { cache_hit_rate: ratio(total.read, total.input), cache_write_share: ratio(total.write, total.input),
    reasoning_share: ratio(total.reasoning, total.output) };
}

function requestFailed(event, a) {
  if (event === "codex.api_error" || a["error.message"] || a.error || flag(a.success) === false) return true;
  const status = count(a["http.response.status_code"]);
  if (status >= 100 && status <= 599) return status >= 400;
  return flag(a.success) === true ? false : null;
}

const APPROVED = new Set(["approved", "approved_for_session", "approved_with_amendment",
  "approved_mcp_policy_amendment", "approved_with_network_policy_allow"]);
const DENIED = new Set(["denied", "denied_with_network_policy_deny"]);

export function foldCodexInsightsLogs(rows, prices = pricesDefault, { summary, deduplicated = false } = {}) {
  if (rows.length > ROW_LIMIT)
    throw new ValidationError("too much Codex log data", "narrow the requested date range");
  const unique = new Map();
  const selected = [], streamScopes = [], sessions = new Set();
  const requiringUsage = new Set(), unmodelledEvidence = new Set();
  const rejectedSessions = new Set(), requiringSessions = new Set();
  for (const row of rows) {
    if (deduplicated && Number(row.is_scope) === 1) {
      if (typeof row.attributes?.["conversation.id"] !== "string" || !row.attributes["conversation.id"])
        throw new Error("Invalid Codex detail stream scope");
      streamScopes.push(scope(row, false));
      requiringSessions.add(scope(row, false));
      const models = row.attributes["stream.models"] === undefined
        ? [row.attributes.model || ""] : JSON.parse(row.attributes["stream.models"]);
      if (!Array.isArray(models) || !models.length || models.some(model => typeof model !== "string"))
        throw new Error("Invalid Codex detail stream models");
      for (const model of models) {
        if (model) requiringUsage.add(scope(row, true, model));
        else unmodelledEvidence.add(scope(row, false));
      }
      sessions.add(row.attributes["conversation.id"]);
      continue;
    }
    if (!row.attributes?.["event.name"]?.startsWith("codex.")) continue;
    if (deduplicated) { selected.push({ ...row, resource: row.resource || {} }); continue; }
    const key = JSON.stringify([row.timestamp, sortedMap(row.resource), sortedMap(row.attributes)]);
    if (!unique.has(key)) unique.set(key, { ...row, resource: row.resource || {} });
  }
  const records = deduplicated ? selected : [...unique.values()];
  const usageScopes = new Set(), usageSessions = new Set();
  let missingSession = false;
  for (const row of records) {
    if (row.attributes["conversation.id"]) sessions.add(row.attributes["conversation.id"]);
    if (isRejectedRequestEvent(row.attributes)) {
      if (row.attributes["conversation.id"]) rejectedSessions.add(scope(row, false));
    } else if (!setupMetadata(row.attributes)) {
      requiringUsage.add(scope(row));
      requiringSessions.add(scope(row, false));
      if (!row.attributes.model) unmodelledEvidence.add(scope(row, false));
    }
    if (!hasUsage(row)) continue;
    usageScopes.add(scope(row));
    if (row.attributes["conversation.id"]) usageSessions.add(scope(row, false));
    else missingSession = true;
  }
  const total = usageTotals(), efforts = new Map(), latencies = new Map(), tools = new Map();
  const approvals = new Map(), runtime = new Map(), events = new Map(), missingUsage = new Set();
  let requests = 0, rejectedRequests = 0, retries = 0, errors = 0, missingAttempts = false, missingOutcomes = false;
  let prompts = 0, promptLength = 0, approved = 0, denied = 0, unknownDecisions = 0, lastSeen = null;
  for (const row of records) {
    const a = row.attributes, r = row.resource, event = a["event.name"];
    events.set(event, (events.get(event) || 0) + 1);
    // Timestamp is the collector-populated log Timestamp; event.timestamp is not a fallback.
    const time = Date.parse(String(row.timestamp).replace(" ", "T").replace(/(?<!Z)$/, "Z"));
    if (Number.isFinite(time) && (lastSeen === null || time > lastSeen)) lastSeen = time;

    const operational = OVERVIEW_EVENTS.includes(event)
      && (!stream(event) || completed(row) || a["event.kind"] === "response.failed");
    // Partial cost coverage does not establish how many sessions anonymous
    // operational records represent, even alongside identified priced usage.
    if (operational && !a["conversation.id"]) missingSession = true;
    const rejected = isRejectedRequestEvent(a);
    const rejectedSetup = setupMetadata(a) && a["conversation.id"]
      && rejectedSessions.has(scope(row, false)) && !requiringSessions.has(scope(row, false));
    if (!rejectedSetup && (!rejected || !a["conversation.id"] || requiringUsage.has(scope(row))
      || unmodelledEvidence.has(scope(row, false))) && (operational ? !usageScopes.has(scope(row))
      && !(a["conversation.id"] && !a.model && usageSessions.has(scope(row, false)))
      : a["conversation.id"] && !usageSessions.has(scope(row, false)))) missingUsage.add(scope(row));

    if (hasUsage(row)) {
      const input = Object.fromEntries(Object.entries(TOKEN_FIELDS).map(([raw, name]) => [name, count(a[raw])]));
      const usage = priceCodexUsage({ ...input, model: a.model || "", backend: resolveBackend(a.model, r.backend),
        context_tier: input.input_tokens_total > (prices[codexModel(a.model)]?.short_context_limit ?? 0) ? "long" : "short" }, prices);
      const effort = text(a.model_reasoning_effort);
      if (!efforts.has(effort)) efforts.set(effort, usageTotals());
      addUsage(total, usage);
      addUsage(efforts.get(effort), usage);
    }
    if (event === "codex.api_request" || event === "codex.api_error") {
      requests++;
      rejectedRequests += Number(rejected);
      const attempt = count(a.attempt), failed = requestFailed(event, a);
      // Native 0.154.0 emits attempt=0 for the first HTTP attempt.
      if (attempt === null) missingAttempts = true;
      else retries += Number(attempt > 0);
      if (failed === null) missingOutcomes = true;
      else errors += Number(failed);
    }
    if (stream(event) && a["event.kind"] === "response.failed") errors++;
    const duration = number(a.duration_ms);
    const latencyName = event === "codex.startup_phase" ? `startup_phase:${text(a["startup.phase"])}`
      : ["codex.api_request", "codex.api_error", "codex.sse_event", "codex.websocket_request",
        "codex.websocket_event", "codex.turn_ttft", "codex.tool_result"].includes(event)
        ? (event === "codex.api_error" ? "api_request" : event.slice(6)) : null;
    if (latencyName && duration !== null) {
      if (!latencies.has(latencyName)) latencies.set(latencyName, []);
      latencies.get(latencyName).push(duration);
    }
    if (event === "codex.user_prompt") {
      prompts++;
      const length = count(a.prompt_length);
      promptLength = promptLength === null || length === null ? null : promptLength + length;
    }
    if (event === "codex.tool_result") {
      const tool = text(a.tool_name);
      if (!tools.has(tool)) tools.set(tool, { tool, calls: 0, successes: 0, failures: 0, unknown: 0, durations: [] });
      const target = tools.get(tool), success = flag(a.success);
      target.calls++;
      target[success === true ? "successes" : success === false ? "failures" : "unknown"]++;
      if (duration !== null) target.durations.push(duration);
    }
    if (event === "codex.tool_decision") {
      const meta = { tool: text(a.tool_name), decision: text(a.decision), source: text(a.source) };
      const key = JSON.stringify(meta);
      if (!approvals.has(key)) approvals.set(key, { ...meta, count: 0 });
      approvals.get(key).count++;
      if (APPROVED.has(a.decision)) approved++;
      else if (DENIED.has(a.decision)) denied++;
      else unknownDecisions++;
    }
    if (event === "codex.conversation_starts") {
      const meta = { model: text(a.model), version: text(a["app.version"] || r["service.version"]),
        provider: text(a.provider_name), effort: text(a.reasoning_effort),
        sandbox_policy: policyName(a.sandbox_policy, SANDBOX_POLICIES),
        approval_policy: policyName(a.approval_policy, APPROVAL_POLICIES) };
      const key = JSON.stringify(meta);
      if (!runtime.has(key)) runtime.set(key, { ...meta, sessions: new Set(), missingSession: false });
      if (a["conversation.id"]) runtime.get(key).sessions.add(a["conversation.id"]);
      else runtime.get(key).missingSession = true;
    }
  }
  const toolRows = [...tools.values()].map(({ durations, ...tool }) => {
    const stats = statistics(durations);
    return { ...tool, success_rate: tool.unknown ? null : ratio(tool.successes, tool.calls),
      average_ms: stats.average_ms, p95_ms: stats.p95_ms };
  });
  const missingUsageScopes = missingUsage.size > 0 || streamScopes.some((key) => !usageSessions.has(key));
  const completeUsage = total.requests > 0 && !missingUsageScopes;
  const rejectedOnly = requests > 0 && rejectedRequests === requests && total.requests === 0 && !missingUsageScopes;
  const cost = total.hasCost ? rounded(total.cost_usd) : rejectedOnly ? 0 : null;
  const toolCalls = toolRows.reduce((n, tool) => n + tool.calls, 0);
  return {
    coverage: summary?.coverage ?? { status: records.length ? "observed" : "empty", records: records.length,
      last_seen: lastSeen === null ? null : new Date(lastSeen).toISOString() },
    summary: {
      ...finishObservedTokens(total.observedTokens, { partial: missingUsageScopes || total.tokens === null,
        emptyValue: rejectedOnly ? 0 : null }),
      rejected_requests: rejectedRequests,
      ...(completeUsage ? fractions(total) : { cache_hit_rate: null, cache_write_share: null, reasoning_share: null }),
      // Per-request units use observed HTTP attempts, matching the client overview.
      tokens_per_request: completeUsage ? ratio(total.tokens, requests) : null,
      cost_per_request: ratio(cost, requests),
      // Include stream-only sessions from the same detail snapshot as pricing;
      // nearby summary ingestion must not change the subtotal's denominator.
      cost_per_session: !missingSession ? ratio(cost, sessions.size) : null,
      cost_partial: total.unpriced > 0 || missingUsageScopes || (total.hasCost && cost === null),
      retry_rate: missingAttempts ? null : ratio(retries, requests),
      api_error_rate: missingOutcomes ? null : ratio(errors, requests), // Error records per HTTP attempt; may exceed 1.
      tool_success_rate: toolRows.some((tool) => tool.unknown) ? null
        : ratio(toolRows.reduce((n, tool) => n + tool.successes, 0), toolCalls),
      approval_rate: unknownDecisions ? null : ratio(approved, approved + denied),
      prompts, prompt_length_mean: ratio(promptLength, prompts),
    },
    effort: [...efforts].map(([effort, value]) => ({ effort, requests: value.requests, tokens: value.tokens,
      ...finishObservedTokens(value.observedTokens, { partial: value.tokens === null }),
      cost_usd: value.hasCost ? rounded(value.cost_usd) : null,
      cost_partial: value.unpriced > 0 || (value.hasCost && rounded(value.cost_usd) === null),
      unpriced: value.unpriced, ...fractions(value) })).sort(byName("effort")),
    latency: [...[...latencies].filter(([name]) => !summary || !["sse_event", "websocket_event"].includes(name))
      .map(([name, values]) => ({ name, ...statistics(values) })), ...(summary?.latency || [])].sort(byName("name")),
    tools: toolRows.sort((a, b) => b.calls - a.calls || byName("tool")(a, b)),
    approvals: [...approvals.values()].sort((a, b) => byName("tool")(a, b)
      || byName("decision")(a, b) || byName("source")(a, b)),
    runtime: [...runtime.values()].map(({ sessions: ids, missingSession, ...meta }) =>
      ({ ...meta, sessions: missingSession ? null : ids.size })).sort(byName("model")),
    events: summary?.events ?? [...events].map(([event, count]) => ({ event, count })).sort(byName("event")),
  };
}
