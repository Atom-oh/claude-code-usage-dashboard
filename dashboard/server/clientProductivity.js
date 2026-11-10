import { query, toChDateTime } from "./clickhouse.js";
import { validateClientFilters, effectiveClientEnd } from "./clientMetrics.js";
import { clientQueryBatch } from "./clientQueryBatch.js";
import { backendSql } from "./backend.js";
import { clientProductivityClaudeSql, sessionTeamsSql } from "./queries.js";

// Shared Productivity rows (docs/api-reference.md#get-apiclientsproductivity). One row shape per
// selected client. Users, sessions, tokens and costs stay in /api/clients/overview; the page
// joins both responses by client over the same effective range.
//
// A measure a client cannot provide is null with a reason in `unavailable`, never zero:
//   not_collected  — default OTel has no source (Codex PR/commit/LOC needs Git/CI evidence).
//   not_aggregated — no confirmed source metric, so the dashboard does not aggregate it.
//   not_derived    — a dashboard-derived value whose inputs are missing (Codex active time:
//                    codex.turn.e2e_duration_ms is turn elapsed time, not human active time).
export const UNAVAILABLE_REASONS = ["not_collected", "not_aggregated", "not_derived"];
const CODEX_UNAVAILABLE = {
  active_user_seconds: "not_derived", active_cli_seconds: "not_derived",
  prs: "not_collected", commits: "not_collected", loc_added: "not_collected", loc_removed: "not_collected",
};
const CLAUDE_COUNTER_FIELDS = ["active_user_seconds", "active_cli_seconds", "commits", "prs", "loc_added", "loc_removed"];
const APPROVED = ["approved", "approved_for_session", "approved_with_amendment",
  "approved_mcp_policy_amendment", "approved_with_network_policy_allow"];
const DENIED = ["denied", "denied_with_network_policy_deny"];
const PRODUCTIVITY_EVENTS = ["codex.user_prompt", "codex.tool_result", "codex.tool_decision", "codex.turn_ttft"];
// The overview's model evidence events (clientMetrics.js buildCodexQuery).
const MODEL_EVIDENCE_EVENTS = ["codex.sse_event", "codex.websocket_event", "codex.api_request", "codex.api_error",
  "codex.tool_result", "codex.tool_decision", "codex.turn_ttft"];
const list = (values) => values.map((v) => `'${v}'`).join(", ");

// Codex filters follow the overview's event-level semantics: user/userExact on the resource
// identity, model on the event model with session evidence for model-less events, backend from
// model/resource tag, team from the session's resolved team.
export function buildCodexProductivityQuery(from, to, filters = {}) {
  const params = { from: toChDateTime(from), to: toChDateTime(to),
    clientUser: filters.user || "", clientUserExact: filters.userExact || "",
    clientModel: filters.model || "", clientModelExact: filters.modelExact || "",
    clientBackend: filters.backend || "", ...(filters.team ? { clientTeam: filters.team } : {}) };
  const user = "coalesce(nullIf(ResourceAttributes['user.email'], ''), nullIf(ResourceAttributes['enduser.id'], ''), '')";
  const modelFiltered = Boolean(filters.model || filters.modelExact);
  const modelMatch = (model) => `(positionCaseInsensitive(${model}, {clientModel:String}) > 0
      AND ({clientModelExact:String} = '' OR ${model} = {clientModelExact:String}))`;
  const sql = `WITH ${modelFiltered ? `model_sessions AS (
    SELECT DISTINCT LogAttributes['conversation.id'] AS session, ${user} AS user, ResourceAttributes['project.name'] AS project
    FROM claude_code.otel_logs
    WHERE Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime}
      AND EventName IN (${list(MODEL_EVIDENCE_EVENTS)}) AND LogAttributes['conversation.id'] != ''
      AND ${modelMatch("LogAttributes['model']")}
  ), ` : ""}codex_events AS (
    SELECT DISTINCT Timestamp, mapSort(ResourceAttributes) AS r, mapSort(LogAttributes) AS a, EventName AS event,
      LogAttributes['conversation.id'] AS session, ${user} AS user, LogAttributes['model'] AS model,
      ${backendSql("LogAttributes['model']", "ResourceAttributes['backend']")} AS backend,
      ResourceAttributes['project.name'] AS project
    FROM claude_code.otel_logs
    WHERE Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime} AND EventName IN (${list(PRODUCTIVITY_EVENTS)})
  ), selected AS (
    SELECT event, a, ifNull(toFloat64OrNull(trimBoth(a['duration_ms'])), -1) AS duration,
      event = 'codex.turn_ttft' AND isFinite(duration) AND duration >= 0 AS ttft_valid
    FROM codex_events
    WHERE ({clientUser:String} = '' OR positionCaseInsensitive(user, {clientUser:String}) > 0)
      AND ({clientUserExact:String} = '' OR user = {clientUserExact:String})
      ${modelFiltered ? `AND (${modelMatch("model")} OR (model = '' AND (session, user, project) IN (SELECT * FROM model_sessions)))` : ""}
      AND ({clientBackend:String} = '' OR backend = {clientBackend:String})
      ${filters.team ? `AND session IN (SELECT session FROM (${sessionTeamsSql(["codex"])}) WHERE team = {clientTeam:String})` : ""}
  )
  SELECT countIf(event = 'codex.user_prompt') AS prompts,
    countIf(event = 'codex.tool_result') AS tool_calls,
    countIf(event = 'codex.tool_result' AND a['success'] = 'true') AS tool_successes,
    countIf(event = 'codex.tool_result' AND a['success'] = 'false') AS tool_failures,
    countIf(event = 'codex.tool_decision') AS decisions_total,
    countIf(event = 'codex.tool_decision' AND a['decision'] IN (${list(APPROVED)})) AS decisions_allowed,
    countIf(event = 'codex.tool_decision' AND a['decision'] IN (${list(DENIED)})) AS decisions_denied,
    countIf(ttft_valid) AS ttft_samples,
    if(ttft_samples = 0, NULL, quantileExactLowIf(0.5)(duration, ttft_valid)) AS ttft_p50_ms
  FROM selected`;
  return { sql, params };
}

function count(value) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
function measure(value) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
const ratio = (n, d) => n !== null && d !== null && d > 0 ? n / d : null;
const observed = (value) => value === true || value === 1 || value === "1" || value === "true";

// Folds one client's query rows into the shared row shape. Missing or malformed counts become
// null; rates use only known outcomes and expose the unknown remainder.
export function foldClientProductivity(client, parts = {}) {
  const events = parts.events || {}, counters = parts.counters || null, traces = parts.traces || null;
  const calls = count(events.tool_calls), successes = count(events.tool_successes), failures = count(events.tool_failures);
  const decisions = count(events.decisions_total), allowed = count(events.decisions_allowed), denied = count(events.decisions_denied);
  const known = successes !== null && failures !== null ? successes + failures : null;
  const decided = allowed !== null && denied !== null ? allowed + denied : null;
  const prompts = count(events.prompts);
  const ttft = client === "claude" ? traces || {} : events;
  const row = { client, prompts, tool_calls: calls, tool_successes: successes, tool_failures: failures,
    tool_unknown: calls !== null && known !== null && calls >= known ? calls - known : null,
    tool_success_rate: ratio(successes, known),
    decisions_total: decisions, decisions_allowed: allowed, decisions_denied: denied,
    decisions_unknown: decisions !== null && decided !== null && decisions >= decided ? decisions - decided : null,
    permission_allow_rate: ratio(allowed, decided),
    tool_calls_per_prompt: ratio(calls, prompts),
    ttft_samples: count(ttft.ttft_samples),
    ttft_p50_ms: count(ttft.ttft_samples) > 0 ? measure(ttft.ttft_p50_ms) : null,
    ttft_source: client === "claude" ? "llm_request_span" : "turn_ttft_event",
  };
  for (const field of CLAUDE_COUNTER_FIELDS) {
    row[field] = client === "claude" && counters && observed(counters[`${field}_observed`])
      ? measure(counters[field]) : null;
  }
  row.unavailable = client === "codex" ? { ...CODEX_UNAVAILABLE } : {};
  return row;
}

export async function clientProductivity(from, to, raw, enabledClients, externalSignal, run = query) {
  externalSignal?.throwIfAborted();
  const filters = validateClientFilters(raw, enabledClients);
  const requestedTo = to;
  // The overview's default effective end. The page passes the overview's effective bounds,
  // which this resolves to unchanged, so the two responses join over one window.
  to = effectiveClientEnd(from, to, filters.clients);
  const jobs = [], slots = [];
  for (const client of filters.clients) {
    if (client === "claude") {
      const sql = clientProductivityClaudeSql(from, to, filters);
      for (const part of ["events", "counters", "traces"]) {
        const request = sql[part === "events" ? "logs" : part];
        slots.push([client, part]);
        jobs.push((signal) => run(request.sql, request.params, signal));
      }
    } else {
      const request = buildCodexProductivityQuery(from, to, filters);
      slots.push([client, "events"]);
      jobs.push((signal) => run(request.sql, request.params, signal));
    }
  }
  const results = await clientQueryBatch(jobs, externalSignal);
  const parts = new Map(filters.clients.map((client) => [client, {}]));
  slots.forEach(([client, part], i) => { parts.get(client)[part] = results[i]?.[0] || null; });
  return { clients: filters.clients,
    by_client: filters.clients.map((client) => foldClientProductivity(client, parts.get(client))),
    effective_range: { from: from.toISOString(), to: to.toISOString(), requested_to: requestedTo.toISOString() } };
}
