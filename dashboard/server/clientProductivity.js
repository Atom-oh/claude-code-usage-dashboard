import { query, toChDateTime } from "./clickhouse.js";
import { validateClientFilters, effectiveClientEnd } from "./clientMetrics.js";
import { clientQueryBatch } from "./clientQueryBatch.js";
import { backendSql } from "./backend.js";
import { clientProductivityClaudeSql, sessionTeamsSql, toolBreakdownSql, validMs } from "./queries.js";
import { withProductivityScore } from "./productivity.js";

// Shared Productivity rows (docs/api-reference.md#get-apiclientsproductivity). One row shape per
// selected client. Users, sessions, tokens and costs stay in /api/clients/overview; the page
// joins both responses by client over the same effective range.
//
// A measure a client cannot provide is null with a reason in `unavailable`, never zero:
//   not_collected  — default OTel has no source (Codex PR/commit/LOC needs Git/CI evidence).
//   not_aggregated — no confirmed source metric, so the dashboard does not aggregate it.
//   not_derived    — a dashboard-derived value whose inputs are missing (Codex active time:
//                    codex.turn.e2e_duration_ms is turn elapsed time, not human active time;
//                    the activity index needs LOC and commits Codex does not emit).
// Codex permission wait has no confirmed source metric, so it is not aggregated.
export const UNAVAILABLE_REASONS = ["not_collected", "not_aggregated", "not_derived"];
const CODEX_UNAVAILABLE = {
  active_user_seconds: "not_derived", active_cli_seconds: "not_derived",
  prs: "not_collected", commits: "not_collected", loc_added: "not_collected", loc_removed: "not_collected",
  permission_wait_p50_ms: "not_aggregated", top_users: "not_derived",
};
// Section 8 lists at most this many users by activity index; per-tool lists are bounded in SQL.
export const TOP_USER_LIMIT = 10;
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
// One scan: kinds prompt (codex.user_prompt), result (codex.tool_result: success 'true' /
// 'false'), decision (codex.tool_decision: approved/denied sets; source as in /api/codex/insights
// approvals) and ttft (codex.turn_ttft duration_ms). Totals are the sums of each kind's rows.
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
    SELECT event, a
    FROM codex_events
    WHERE ({clientUser:String} = '' OR positionCaseInsensitive(user, {clientUser:String}) > 0)
      AND ({clientUserExact:String} = '' OR user = {clientUserExact:String})
      ${modelFiltered ? `AND (${modelMatch("model")} OR (model = '' AND (session, user, project) IN (SELECT * FROM model_sessions)))` : ""}
      AND ({clientBackend:String} = '' OR backend = {clientBackend:String})
      ${filters.team ? `AND session IN (SELECT session FROM (${sessionTeamsSql(["codex"])}) WHERE team = {clientTeam:String})` : ""}
  ), tool_events AS (
    SELECT multiIf(event = 'codex.tool_result', 'result', event = 'codex.tool_decision', 'decision',
        event = 'codex.turn_ttft', 'ttft', 'prompt') AS kind,
      if(kind IN ('result', 'decision'), a['tool_name'], '') AS tool,
      if(kind = 'decision', a['source'], '') AS source,
      kind = 'result' AND a['success'] = 'true' AS ok,
      kind = 'result' AND a['success'] = 'false' AS bad,
      kind = 'decision' AND a['decision'] IN (${list(APPROVED)}) AS allow,
      kind = 'decision' AND a['decision'] IN (${list(DENIED)}) AS deny,
      if(kind IN ('result', 'ttft'), ${validMs("a['duration_ms']")}, -1) AS duration
    FROM selected
  )${toolBreakdownSql("tool_events")}`;
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

// Client totals from the per-kind rows of one log scan. A kind with no rows is a measured zero;
// a missing response or malformed count stays unknown.
export function eventTotals(rows) {
  if (!Array.isArray(rows)) return {};
  const sum = (kind, field) => rows.filter((r) => r?.kind === kind)
    .reduce((total, r) => total === null || count(r[field]) === null ? null : total + count(r[field]), 0);
  const ttft = rows.find((r) => r?.kind === "ttft");
  return { prompts: sum("prompt", "events"), tool_calls: sum("result", "events"),
    tool_successes: sum("result", "successes"), tool_failures: sum("result", "failures"),
    decisions_total: sum("decision", "events"), decisions_allowed: sum("decision", "allowed"),
    decisions_denied: sum("decision", "denied"), ttft_samples: ttft ? ttft.duration_samples : 0,
    ttft_p50_ms: ttft?.duration_p50_ms ?? null, ttft_p90_ms: ttft?.duration_p90_ms ?? null };
}

// Folds one client's query rows into the shared row shape. Missing or malformed counts become
// null; rates use only known outcomes and expose the unknown remainder.
export function foldClientProductivity(client, parts = {}, range = null) {
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
    ttft_p90_ms: count(ttft.ttft_samples) > 0 ? measure(ttft.ttft_p90_ms) : null,
    ttft_source: client === "claude" ? "llm_request_span" : "turn_ttft_event",
    permission_wait_samples: client === "claude" && traces ? count(traces.permission_wait_samples) : null,
    permission_wait_p50_ms: client === "claude" && traces && count(traces.permission_wait_samples) > 0
      ? measure(traces.permission_wait_p50_ms) : null,
    by_tool_decisions: foldTools(parts.tools, "decision"),
    by_tool_results: foldTools(parts.tools, "result"),
    ...(client === "claude" ? foldTopUsers(parts.users, range)
      : { top_users: null, activity_index_users: null, activity_index_scored: null }),
  };
  for (const field of CLAUDE_COUNTER_FIELDS) {
    row[field] = client === "claude" && counters && observed(counters[`${field}_observed`])
      ? measure(counters[field]) : null;
  }
  row.unavailable = client === "codex" ? { ...CODEX_UNAVAILABLE } : {};
  return row;
}

// Exact per-source counts from sumMap: [[sources], [counts]].
function sourceCounts(value) {
  const ok = Array.isArray(value) && Array.isArray(value[0]) && Array.isArray(value[1]);
  return ok ? value[0].map((source, i) => [String(source ?? ""), count(value[1][i])]) : [];
}

// One row per top tool, then the remainder (`other: true`, `tool: null`, `tools` = folded tool
// count), from toolBreakdownSql rows. A missing response stays null rather than an empty list.
export function foldTools(rows, kind) {
  if (!Array.isArray(rows)) return null;
  const out = rows.filter((r) => r?.kind === kind).map((r) => {
    const other = !observed(r.top), events = count(r.events);
    const base = { tool: other ? null : String(r.tool_key ?? ""), other, tools: count(r.tools) };
    if (kind === "result") {
      const successes = count(r.successes), failures = count(r.failures);
      const known = successes !== null && failures !== null ? successes + failures : null;
      return { ...base, calls: events, successes, failures,
        unknown: events !== null && known !== null && events >= known ? events - known : null,
        success_rate: ratio(successes, known), duration_samples: count(r.duration_samples),
        duration_p50_ms: count(r.duration_samples) > 0 ? measure(r.duration_p50_ms) : null };
    }
    const allowed = count(r.allowed), denied = count(r.denied);
    const decided = allowed !== null && denied !== null ? allowed + denied : null;
    // Most frequent decision source; ties resolve by name. An empty name is a missing source.
    const sources = sourceCounts(r.source_counts);
    const top = sources.some(([, n]) => n === null) ? null : sources.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || null;
    return { ...base, decisions: events, allowed, denied,
      unknown: events !== null && decided !== null && events >= decided ? events - decided : null,
      allow_rate: ratio(allowed, decided), source: top ? top[0] : null, source_decisions: top ? top[1] : null };
  });
  const size = (r) => (kind === "result" ? r.calls : r.decisions) ?? -1;
  return out.sort((a, b) => a.other - b.other || size(b) - size(a) || String(a.tool).localeCompare(String(b.tool)));
}

// Claude activity index rows (userLeaderboard inputs) scored by withProductivityScore over the
// effective range; a malformed input or no code-edit decision leaves the score null.
export function foldTopUsers(rows, range) {
  if (!Array.isArray(rows) || !range) return { top_users: null, activity_index_users: null, activity_index_scored: null };
  const inputs = rows.map((r) => ({ user: String(r.user ?? ""), sessions: measure(r.sessions), loc: measure(r.loc),
    commits: measure(r.commits), accepted: measure(r.accepted), decisions: measure(r.decisions),
    active_days: measure(r.active_days) }));
  const scored = withProductivityScore(inputs, range.from, range.to).map((r, i) => {
    const valid = Object.values(inputs[i]).every((v) => v !== null);
    return { user: r.user, productivity_score: valid ? r.productivity_score : null,
      accept_rate: valid ? r.accept_rate : null, loc_added: r.loc, commits: r.commits, sessions: r.sessions,
      active_days: r.active_days, decisions: r.decisions };
  });
  scored.sort((a, b) => (b.productivity_score ?? -1) - (a.productivity_score ?? -1) || a.user.localeCompare(b.user));
  return { top_users: scored.slice(0, TOP_USER_LIMIT), activity_index_users: scored.length,
    activity_index_scored: scored.filter((r) => r.productivity_score !== null).length };
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
    const sql = client === "claude" ? clientProductivityClaudeSql(from, to, filters)
      : { logs: buildCodexProductivityQuery(from, to, filters) };
    for (const part of client === "claude" ? ["logs", "counters", "traces", "users"] : ["logs"]) {
      slots.push([client, part]);
      jobs.push((signal) => run(sql[part].sql, sql[part].params, signal));
    }
  }
  const results = await clientQueryBatch(jobs, externalSignal);
  const parts = new Map(filters.clients.map((client) => [client, {}]));
  // Log and user parts keep every row; counter and trace parts keep their single row.
  slots.forEach(([client, part], i) => {
    const rows = Array.isArray(results[i]) ? results[i] : null, target = parts.get(client);
    if (part === "logs") Object.assign(target, { events: eventTotals(rows), tools: rows });
    else target[part] = part === "users" ? rows : rows?.[0] || null;
  });
  return { clients: filters.clients,
    by_client: filters.clients.map((client) => foldClientProductivity(client, parts.get(client), { from, to })),
    effective_range: { from: from.toISOString(), to: to.toISOString(), requested_to: requestedTo.toISOString() } };
}
