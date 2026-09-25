import { logSelection } from "./codexInsightsLogs.js";
import { parseCodexPricing } from "./codexPricing.js";
import { CODEX_USAGE_KEYS, REJECTED_REQUEST_STATUSES, SETUP_METADATA_EVENTS } from "./codexRequests.js";
import { createObservedTokens, addObservedTokens, finishObservedTokens } from "./observedTokens.js";
import { backendSql, VALID_BACKENDS } from "./backend.js";
import { resolvedRatesTable } from "./pricing.js";
import { normModel } from "./queries.js";

const LIMIT = 50000;
const DEFAULT_PRICES = parseCodexPricing(process.env.CODEX_PRICING_JSON);
const CLAUDE_RATES = resolvedRatesTable(); // ADR-017 fallback rates.
const FAMILIES = ["event", "usage", "effort", "scope", "operations", "latency", "tool", "approval", "runtime"];
const FAMILY_BUDGET = Math.floor((LIMIT - FAMILIES.length) / FAMILIES.length);
const TOKEN_KEYS = ["input", "read", "write", "output", "reasoning"];
const APPROVED = ["approved", "approved_for_session", "approved_with_amendment",
  "approved_mcp_policy_amendment", "approved_with_network_policy_allow"];
const DENIED = ["denied", "denied_with_network_policy_deny"];
const SANDBOX = ["read-only", "workspace-write", "danger-full-access", "external-sandbox"];
const APPROVAL = ["never", "untrusted", "unless-trusted", "on-request", "on-failure", "reject"];
const strings = (values) => `[${values.map((v) => `'${v}'`).join(",")}]`;
const safeText = (value) => `if(match(${value}, '(?i)^[a-z0-9][a-z0-9_.+ -]{0,127}$'), ${value}, 'unknown')`;
function numeric(value) {
  const text = `trimBoth(${value})`;
  const base = `multiIf(lower(substring(${text},2,1)) = 'x',16,
    lower(substring(${text},2,1)) = 'b',2,8)`;
  // Preserve Number()'s non-decimal integer strings as well as scientific
  // notation. Partial parses and absent values remain unknown.
  return `if(match(${text},'(?i)^0(x[0-9a-f]+|b[01]+|o[0-7]+)$'),
    arrayFold((acc,digit) -> acc * ${base} + toFloat64(position('0123456789abcdef',lower(digit))-1),
      extractAll(substring(${text},3),'.'),toFloat64(0)),
    toFloat64OrNull(nullIf(${text},'')))`;
}
const nonnegative = (value) => `if(isFinite(${value}) AND ${value} >= 0, ${value}, NULL)`;
const integer = (value) => `if(isFinite(${value}) AND ${value} >= 0 AND floor(${value}) = ${value}
  AND ${value} <= 9007199254740991, ${value}, NULL)`;

function policy(value, allowed) {
  // Match policyName's string, type/name, and single-key object forms. A
  // non-string truthy type/name cannot be replaced by a different property.
  const member = (key) => `if(JSONExtractRaw(${value},'${key}') IN ('','null','false','0','""'), '',
    if(JSONType(${value},'${key}') = 'String', JSONExtractString(${value},'${key}'), 'unknown'))`;
  const candidate = `coalesce(nullIf(if(JSONType(${value}) = 'String', JSONExtractString(${value}), ''), ''),
    nullIf(${member("type")}, ''), nullIf(${member("name")}, ''),
    if(length(JSONExtractKeys(${value})) = 1, JSONExtractKeys(${value})[1], 'unknown'))`;
  return `multiIf(has(${strings(allowed)}, ${value}), ${value}, lengthUTF8(${value}) > 4096, 'unknown',
    has(${strings(allowed)}, ${candidate}), ${candidate}, 'unknown')`;
}

function priceExpression(prices, params, claudeRates = CLAUDE_RATES) {
  const cases = [];
  Object.entries(prices).forEach(([model, entry], i) => {
    params[`aggregateModel${i}`] = model;
    params[`aggregateThreshold${i}`] = entry.short_context_limit;
    for (const backendKey of [...VALID_BACKENDS, null]) {
      const source = backendKey ? entry.backends?.[backendKey] : entry;
      if (!source) continue;
      for (const scope of ["regional", "global"]) for (const tier of ["short", "long"]) {
        const rates = source[scope]?.[tier];
        if (!rates) continue;
        const key = `aggregatePrice${i}${backendKey ? backendKey.replace(/-/g, "_") : "base"}${scope}${tier}`;
        for (const field of ["input", "cacheRead", "cacheWrite", "output"]) params[key + field] = rates[field];
        const condition = `base_model = {aggregateModel${i}:String}
          ${backendKey ? `AND backend = '${backendKey}'` : ""}
          AND ${scope === "global" ? "" : "NOT "}startsWith(model, 'global.')
          AND input_value ${tier === "short" ? "<=" : ">"} {aggregateThreshold${i}:UInt64}`;
        const amount = `((input_value - read_value - write_value) * {${key}input:Float64}
          + read_value * {${key}cacheRead:Float64} + write_value * {${key}cacheWrite:Float64}
          + output_value * {${key}output:Float64}) / 1000000`;
        cases.push(condition, amount);
      }
    }
  });
  const codexModelKeys = Object.keys(prices);
  const notCodexEntry = codexModelKeys.length ? `NOT has(${strings(codexModelKeys)}, base_model)` : "1";
  Object.entries(claudeRates).forEach(([model, entry], i) => {
    params[`claudeModel${i}`] = model;
    for (const backendKey of VALID_BACKENDS) {
      const rates = entry.backends[backendKey];
      const key = `claudeRate${i}${backendKey.replace(/-/g, "_")}`;
      for (const field of ["input", "cacheRead", "cacheWrite", "output"]) params[key + field] = rates[field];
      const condition = `claude_model = {claudeModel${i}:String} AND backend = '${backendKey}' AND ${notCodexEntry}`;
      const amount = `((input_value - read_value - write_value) * {${key}input:Float64}
        + read_value * {${key}cacheRead:Float64} + write_value * {${key}cacheWrite:Float64}
        + output_value * {${key}output:Float64}) / 1000000`;
      cases.push(condition, amount);
    }
  });
  return cases.length ? `if(has_usage AND usage_valid AND backend IN ('bedrock-mantle','bedrock-runtime')
    AND NOT startsWith(model, 'us-gov.')
    AND NOT (backend = 'bedrock-mantle' AND match(model, '^(us|global)\\\\.')),
    multiIf(${cases.join(",")}, NULL), NULL)` : "CAST(NULL, 'Nullable(Float64)')";
}

/**
 * One log aggregation query supplies all log-derived summaries and their scope
 * evidence. The transferred rows are aggregate dimensions, not individual events.
 * Exact weighted quantiles use the same nearest-rank convention as the raw fold.
 */
export function buildCodexLogAggregateQuery(from, to, filters = {}, prices = DEFAULT_PRICES) {
  // Count complete identities inside each compact group instead of retaining a
  // separate DISTINCT set of every large resource/attribute map in the window.
  const selected = logSelection(from, to, filters, false);
  const params = { ...selected.params };
  const tokenAttributes = ["input_token_count", "cached_token_count", "cache_write_token_count",
    "output_token_count", "reasoning_token_count"];
  const parsed = [
    ...TOKEN_KEYS.map((key, i) => `${numeric(`attributes['${tokenAttributes[i]}']`)} AS ${key}_number`),
    ...["duration_ms", "prompt_length", "attempt", "http.response.status_code"].map((key, i) =>
      `${numeric(`attributes['${key}']`)} AS operation_number${i}`),
  ].join(",\n");
  const tokens = TOKEN_KEYS.map(key => `${integer(`${key}_number`)} AS ${key}_raw`).join(",\n");
  const priced = priceExpression(prices, params);
  const group = (kind, condition, keys) =>
    `if(${condition}, tuple('${kind}', toJSONString([${keys.join(",")}])), tuple('', ''))`;
  const groups = [
    group("event", "1", ["event"]),
    group("usage", "has_usage", []),
    group("effort", "has_usage", [safeText("attributes['model_reasoning_effort']")]),
    group("scope", "NOT bulk OR session != ''",
      ["session", "user", "backend", "project", "model", "if(session = '', timestamp, '')"]),
    group("operations", "NOT bulk", []),
    group("latency", "latency_name != '' AND isNotNull(duration)", ["latency_name"]),
    group("tool", "event = 'codex.tool_result'", [safeText("attributes['tool_name']")]),
    group("approval", "event = 'codex.tool_decision'",
      [safeText("attributes['tool_name']"), safeText("attributes['decision']"), safeText("attributes['source']")]),
    group("runtime", "event = 'codex.conversation_starts'", [safeText("model"),
      safeText("coalesce(nullIf(attributes['app.version'], ''), resource['service.version'])"),
      safeText("attributes['provider_name']"), safeText("attributes['reasoning_effort']"),
      policy("attributes['sandbox_policy']", SANDBOX), policy("attributes['approval_policy']", APPROVAL)]),
  ];
  const usageFamily = "family IN ('usage','effort')";
  const completeSum = (value, condition = "1") =>
    `if(countIf(${usageFamily} AND NOT (${condition} AND isNotNull(${value}))) > 0,
      NULL, sumIf((${value}) * weight, ${usageFamily}))`;
  return { params, sql: `WITH selected AS (${selected.sql}),
    compact_source AS (
      SELECT *,
        attributes['event.name'] IN ('codex.sse_event','codex.websocket_event')
          AND attributes['event.kind'] NOT IN ('response.completed','response.failed') AS intermediate,
        if(intermediate, '', timestamp) AS identity_time,
        if(intermediate, map('user.email',coalesce(nullIf(resource['user.email'],''),resource['enduser.id']),
          'backend',${backendSql("attributes['model']", "resource['backend']")},
          'project.name',resource['project.name']),resource) AS compact_resource,
        if(intermediate, map('event.name',attributes['event.name'],'event.kind','progress',
          'conversation.id',attributes['conversation.id'],'model',attributes['model'],
          'duration_ms',attributes['duration_ms']),attributes) AS compact_attributes
      FROM selected WHERE startsWith(attributes['event.name'], 'codex.')
    ), compacted AS (
      SELECT max(compact_source.timestamp) AS timestamp, min(compact_source.timestamp) AS first_timestamp,
        uniqExact(tuple(compact_source.timestamp,compact_source.resource,compact_source.attributes)) AS weight,
        compact_resource AS resource, compact_attributes AS attributes
      FROM compact_source GROUP BY identity_time, compact_resource, compact_attributes
    ), parsed AS (
      SELECT *, ${parsed} FROM compacted
    ),
    typed AS (
      SELECT *, attributes['event.name'] AS event, attributes['event.kind'] AS event_kind,
        attributes['conversation.id'] AS session, attributes['model'] AS model,
        coalesce(nullIf(resource['user.email'], ''), resource['enduser.id']) AS user,
        ${backendSql("model", "resource['backend']")} AS backend,
        resource['project.name'] AS project,
        event IN ('codex.sse_event','codex.websocket_event') AS stream,
        stream AND event_kind NOT IN ('response.completed','response.failed') AS bulk,
        stream AND event_kind = 'response.completed'
          AND arrayExists(k -> mapContains(attributes,k), ${strings(tokenAttributes)}) AS has_usage,
        event IN ('codex.api_request','codex.api_error') AS is_request,
        is_request AND trimBoth(attributes['http.response.status_code']) IN ${strings(REJECTED_REQUEST_STATUSES)}
          AND NOT arrayExists(k -> mapContains(attributes,k), ${strings(CODEX_USAGE_KEYS)}) AS rejected,
        event IN ${strings(SETUP_METADATA_EVENTS)}
          AND NOT arrayExists(k -> mapContains(attributes,k), ${strings(CODEX_USAGE_KEYS)}) AS setup,
        (event IN ('codex.api_request','codex.api_error','codex.tool_result','codex.tool_decision','codex.turn_ttft')
          OR stream AND NOT bulk) AS operational,
        ${tokens},
        ${nonnegative("operation_number0")} AS duration,
        ${integer("operation_number1")} AS prompt_length,
        ${integer("operation_number2")} AS attempt,
        ${integer("operation_number3")} AS http_status,
        multiIf(event = 'codex.api_error' OR attributes['error.message'] != '' OR attributes['error'] != ''
            OR attributes['success'] = 'false', 1,
          http_status >= 100 AND http_status <= 599, toUInt8(http_status >= 400),
          attributes['success'] = 'true', 0, NULL) AS failed,
        multiIf(event = 'codex.startup_phase', concat('startup_phase:', ${safeText("attributes['startup.phase']")}),
          event IN ('codex.api_request','codex.api_error'), 'api_request',
          event IN ('codex.sse_event','codex.websocket_request','codex.websocket_event','codex.turn_ttft','codex.tool_result'),
          substring(event,7), '') AS latency_name
      FROM parsed
    ), values AS (
      SELECT *, input_raw AS input_value, output_raw AS output_value,
        if(ifNull(read_raw + write_raw > input_raw, 0), NULL, read_raw) AS read_value,
        if(ifNull(read_raw + write_raw > input_raw, 0), NULL, write_raw) AS write_value,
        if(ifNull(reasoning_raw > output_raw, 0), NULL, reasoning_raw) AS reasoning_value,
        isNotNull(input_raw) AND isNotNull(output_raw)
          AND ifNull(input_raw + output_raw <= 9007199254740991, 0) AS pair_valid,
        ${TOKEN_KEYS.map(k => `isNotNull(${k}_value)`).join(" AND ")} AS usage_valid,
        replaceRegexpOne(model, '^(us|global)\\\\.', '') AS base_model,
        ${normModel("model")} AS claude_model
      FROM typed
    ), priced AS (
      SELECT *, ${priced} AS amount,
        if(isFinite(amount * 1e12), floor(amount * 1e12 + 0.5) / 1e12, NULL) AS cost_value
      FROM values
    ), grouped_source AS (
      SELECT *, category.1 AS family, category.2 AS dimensions
      FROM priced ARRAY JOIN arrayFilter(x -> x.1 != '', [${groups.join(",\n")}]) AS category
    ), aggregates AS (
    SELECT family, dimensions, sum(weight) AS records, min(first_timestamp) AS first_seen, max(timestamp) AS last_seen,
      max(toUInt8(grouped_source.has_usage)) AS has_usage,
      max(toUInt8(NOT rejected AND NOT setup)) AS requires_usage,
      max(toUInt8(rejected)) AS has_rejected,
      max(toUInt8(setup)) AS has_setup,
      max(toUInt8(NOT bulk AND operational AND NOT rejected)) AS has_operational,
      max(toUInt8(NOT bulk AND NOT operational AND NOT setup)) AS has_other,
      max(toUInt8(bulk)) AS has_bulk,
      max(toUInt8(operational AND session = '')) AS missing_session,
      sumIf(weight, is_request) AS requests, sumIf(weight, rejected) AS rejected_requests,
      sumIf(weight, is_request AND attempt > 0) AS retries,
      sumIf(weight, is_request AND isNull(attempt)) AS missing_attempts,
      sumIf(weight, is_request AND isNull(failed)) AS missing_outcomes,
      sumIf(weight, is_request AND failed = 1 OR stream AND event_kind = 'response.failed') AS errors,
      sumIf(weight, event = 'codex.user_prompt') AS prompts,
      if(countIf(event = 'codex.user_prompt' AND isNull(grouped_source.prompt_length)) > 0, NULL,
        sumIf(grouped_source.prompt_length * weight, event = 'codex.user_prompt')) AS prompt_length,
      sumIf(weight, event = 'codex.tool_decision' AND has(${strings(APPROVED)}, attributes['decision'])) AS approved,
      sumIf(weight, event = 'codex.tool_decision' AND has(${strings(DENIED)}, attributes['decision'])) AS denied,
      sumIf(weight, event = 'codex.tool_decision' AND NOT has(${strings([...APPROVED, ...DENIED])}, attributes['decision'])) AS unknown_decisions,
      sumIf(weight, attributes['success'] = 'true') AS successes,
      sumIf(weight, attributes['success'] = 'false') AS failures,
      sumIf(weight, attributes['success'] NOT IN ('true','false')) AS unknown_outcomes,
      sumIf(weight, isNotNull(duration) AND family IN ('latency','tool')) AS duration_count,
      sumKahanIf(duration * weight, family IN ('latency','tool')) / nullIf(duration_count,0) AS average_ms,
      quantilesExactWeightedIf(0.5,0.95)(ifNull(duration,0), weight,
        isNotNull(duration) AND family IN ('latency','tool')) AS percentiles,
      maxOrNullIf(duration, family IN ('latency','tool')) AS max_ms,
      uniqExactIf(session, family = 'runtime' AND session != '') AS sessions,
      max(toUInt8(session = '')) AS anonymous,
      ${TOKEN_KEYS.map(k => `${completeSum(`${k}_value`)} AS ${k}`).join(",\n")},
      ${completeSum("input_value + output_value", "usage_valid AND pair_valid")} AS tokens,
      sumIf(weight, ${usageFamily} AND pair_valid) AS observed_pairs,
      sumIf(weight, ${usageFamily} AND NOT pair_valid) AS missing_pairs,
      sumIf((input_value + output_value) * weight, ${usageFamily} AND pair_valid) AS observed_tokens,
      sumIf(weight, ${usageFamily} AND isNotNull(cost_value)) AS priced,
      sumIf(weight, ${usageFamily} AND isNull(cost_value)) AS unpriced,
      sumKahanIf(cost_value * weight, ${usageFamily}) AS cost_usd
    FROM grouped_source GROUP BY family, dimensions
    ), bounded AS (
      SELECT *, count() OVER () AS aggregate_rows, count() OVER (PARTITION BY family) AS family_rows,
        row_number() OVER (PARTITION BY family ORDER BY first_seen, dimensions) AS family_row
      FROM aggregates
    )
    SELECT *, toUInt8(family_rows > if(aggregate_rows > ${LIMIT}, ${FAMILY_BUDGET}, ${LIMIT})) AS family_limited
    FROM bounded WHERE NOT family_limited OR family_row = 1
    ORDER BY family, first_seen, dimensions LIMIT ${LIMIT}` };
}

const finite = (v) => v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;
const count = (v) => Number.isSafeInteger(finite(v)) && finite(v) >= 0 ? finite(v) : null;
const ratio = (n, d) => n !== null && d > 0 && Number.isFinite(n / d) ? n / d : null;
const rounded = (n) => n !== null && Number.isFinite(n * 1e12) ? Math.round(n * 1e12) / 1e12 : null;
const byName = (key) => (a, b) => a[key].localeCompare(b[key]);
const fraction = (value) => ({ cache_hit_rate: ratio(value.read, value.input),
  cache_write_share: ratio(value.write, value.input), reasoning_share: ratio(value.reasoning, value.output) });

function usageTotal() {
  return { requests: 0, tokens: 0, input: 0, read: 0, write: 0, output: 0, reasoning: 0,
    cost_usd: 0, priced: 0, unpriced: 0, observed: createObservedTokens() };
}
function addUsage(total, row) {
  total.requests += Number(row.records);
  total.priced += Number(row.priced);
  total.unpriced += Number(row.unpriced);
  total.cost_usd = finite(total.cost_usd === null ? null : total.cost_usd + Number(row.cost_usd));
  for (const k of ["tokens", ...TOKEN_KEYS]) total[k] = count(
    total[k] === null || row[k] === null ? null : total[k] + Number(row[k]));
  if (Number(row.observed_pairs)) addObservedTokens(total.observed, row.observed_tokens,
    count(row.observed_tokens) === null);
  if (Number(row.missing_pairs)) addObservedTokens(total.observed, null);
}
function usageResult(value) {
  const cost = value.priced ? rounded(value.cost_usd) : null;
  return { requests: value.requests, tokens: value.tokens,
    ...finishObservedTokens(value.observed, { partial: value.tokens === null }),
    cost_usd: cost, cost_partial: value.unpriced > 0 || value.priced > 0 && cost === null,
    unpriced: value.unpriced, ...fraction(value) };
}

function scopeCoverage(rows) {
  const sessions = new Set(), usageScopes = new Set(), usageSessions = new Set();
  const requiring = new Set(), requiringSessions = new Set(), rejectedSessions = new Set(), unmodelled = new Set();
  let missingSession = false, missingUsage = false;
  const scopes = rows.map((row) => {
    const [session, user, backend, project, model, timestamp] = JSON.parse(row.dimensions);
    const identity = [session || ["unidentified", timestamp], user, project];
    const sessionKey = JSON.stringify(identity), key = JSON.stringify([...identity, backend, model]);
    if (session) sessions.add(session);
    if (Number(row.missing_session)) missingSession = true;
    if (Number(row.has_usage)) {
      usageScopes.add(key);
      if (session) usageSessions.add(sessionKey); else missingSession = true;
    }
    if (Number(row.has_rejected) && session) rejectedSessions.add(sessionKey);
    if (Number(row.requires_usage)) {
      requiring.add(key); requiringSessions.add(sessionKey);
      if (!model) unmodelled.add(sessionKey);
    }
    return { row, session, model, sessionKey, key };
  });
  for (const { row, session, model, sessionKey, key } of scopes) {
    const sessionUsage = usageSessions.has(sessionKey);
    const operationalMissing = !usageScopes.has(key) && !(session && !model && sessionUsage);
    if (Number(row.has_operational) && operationalMissing
      || Number(row.has_rejected) && (!session || requiring.has(key) || unmodelled.has(sessionKey)) && operationalMissing
      || Number(row.has_other) && session && !sessionUsage
      || Number(row.has_setup) && session && !sessionUsage
        && (!rejectedSessions.has(sessionKey) || requiringSessions.has(sessionKey))
      || Number(row.has_bulk) && session && !sessionUsage) missingUsage = true;
  }
  return { sessions: sessions.size, missingSession, missingUsage };
}

export function foldCodexLogAggregates(rows) {
  const groups = Object.fromEntries(FAMILIES.map(family => [family, []]));
  for (const row of rows) {
    if (!groups[row.family] || count(row.records) === null || !Array.isArray(JSON.parse(row.dimensions)))
      throw new Error("Invalid Codex log aggregate");
    groups[row.family].push(row);
  }
  const limited = FAMILIES.filter(family => groups[family].length > LIMIT
    || groups[family].some(row => Number(row.family_limited)));
  for (const family of limited) groups[family] = [];
  const total = usageTotal();
  for (const row of groups.usage) addUsage(total, row);
  const effort = groups.effort.map(row => {
    const value = usageTotal(); addUsage(value, row);
    return { effort: JSON.parse(row.dimensions)[0], ...usageResult(value) };
  }).sort(byName("effort"));
  const scopes = scopeCoverage(groups.scope);
  const usageLimited = limited.includes("usage"), scopeLimited = limited.includes("scope");
  const missingUsage = scopes.missingUsage || scopeLimited;
  const complete = total.requests > 0 && !missingUsage && !usageLimited;
  const operations = groups.operations[0] || {};
  const number = (key) => Number(operations[key] || 0);
  const requests = number("requests"), rejected = number("rejected_requests");
  const rejectedOnly = requests > 0 && requests === rejected && !total.requests && !missingUsage && !usageLimited;
  const cost = usageLimited ? null : total.priced ? rounded(total.cost_usd) : rejectedOnly ? 0 : null;
  const tools = groups.tool.map(row => ({ tool: JSON.parse(row.dimensions)[0], calls: Number(row.records),
    successes: Number(row.successes), failures: Number(row.failures), unknown: Number(row.unknown_outcomes),
    success_rate: Number(row.unknown_outcomes) ? null : ratio(Number(row.successes), Number(row.records)),
    average_ms: finite(row.average_ms), p95_ms: Number(row.duration_count) ? finite(row.percentiles[1]) : null,
  })).sort((a, b) => b.calls - a.calls || byName("tool")(a, b));
  const events = groups.event.map(row => ({ event: JSON.parse(row.dimensions)[0], count: Number(row.records) }))
    .sort(byName("event"));
  const records = events.reduce((sum, row) => sum + row.count, 0);
  const last = groups.event.map(row => row.last_seen).sort().at(-1);
  const lastSeen = last ? new Date(last.replace(" ", "T").replace(/(?<!Z)$/, "Z")).toISOString() : null;
  return {
    coverage: { status: limited.includes("event") ? "limited" : records ? "observed" : "empty",
      records: limited.includes("event") ? null : records, last_seen: lastSeen,
      ...(limited.length ? { partial: true, limited_sections: limited } : {}) },
    summary: {
      ...finishObservedTokens(total.observed, { partial: missingUsage || total.tokens === null || usageLimited,
        emptyValue: rejectedOnly ? 0 : null }),
      rejected_requests: rejected,
      ...(complete ? fraction(total) : { cache_hit_rate: null, cache_write_share: null, reasoning_share: null }),
      tokens_per_request: complete ? ratio(total.tokens, requests) : null,
      cost_per_request: ratio(cost, requests),
      cost_per_session: !scopes.missingSession && !scopeLimited ? ratio(cost, scopes.sessions) : null,
      cost_partial: total.unpriced > 0 || missingUsage || usageLimited || total.priced > 0 && cost === null,
      retry_rate: number("missing_attempts") ? null : ratio(number("retries"), requests),
      api_error_rate: number("missing_outcomes") ? null : ratio(number("errors"), requests),
      tool_success_rate: limited.includes("tool") || tools.some(row => row.unknown) ? null
        : ratio(tools.reduce((sum, row) => sum + row.successes, 0), tools.reduce((sum, row) => sum + row.calls, 0)),
      approval_rate: number("unknown_decisions") ? null : ratio(number("approved"), number("approved") + number("denied")),
      prompts: number("prompts"), prompt_length_mean: ratio(finite(operations.prompt_length), number("prompts")),
    },
    effort, tools, events,
    latency: groups.latency.map(row => ({ name: JSON.parse(row.dimensions)[0], count: Number(row.duration_count),
      average_ms: finite(row.average_ms), p50_ms: finite(row.percentiles[0]), p95_ms: finite(row.percentiles[1]),
      max_ms: finite(row.max_ms) })).sort(byName("name")),
    approvals: groups.approval.map(row => {
      const [tool, decision, source] = JSON.parse(row.dimensions);
      return { tool, decision, source, count: Number(row.records) };
    }).sort((a, b) => byName("tool")(a, b) || byName("decision")(a, b) || byName("source")(a, b)),
    runtime: groups.runtime.map(row => {
      const [model, version, provider, effort, sandbox_policy, approval_policy] = JSON.parse(row.dimensions);
      return { model, version, provider, effort, sandbox_policy, approval_policy,
        sessions: Number(row.anonymous) ? null : Number(row.sessions) };
    }).sort(byName("model")),
  };
}
