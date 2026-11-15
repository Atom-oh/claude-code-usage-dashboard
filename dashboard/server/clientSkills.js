// Shared skill usage (docs/api-reference.md#get-apiclientsskills): per client, the skills
// invoked in the range with how each was invoked, from Claude Code's skill_activated logs and
// Codex's codex.skill_invocation logs. Invocation kinds map onto one vocabulary:
//   explicit  — Claude `user-slash`, Codex `explicit` (the user named the skill)
//   automatic — Claude `claude-proactive`, Codex `implicit` (the agent chose it)
//   nested    — Claude `nested-skill` (another skill invoked it; Codex has no such kind)
// Anything else counts in `calls` but in no kind. Exact duplicate deliveries count once. No
// rows means none was recorded: a Codex version or collector without the event records none.
import { query } from "./clickhouse.js";
import { validateClientFilters, effectiveClientEnd } from "./clientMetrics.js";
import { clientQueryBatch } from "./clientQueryBatch.js";
import { codexScopedEventsSql } from "./clientProductivity.js";
import { GROUP_CTE } from "./grouping.js";
import { claudeProductivityScope, range } from "./queries.js";

// Skills returned per client, most called first; beyond it the client's list is limited.
export const SKILL_ROW_LIMIT = 200;

const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/;
const label = (value) => typeof value === "string" && LABEL.test(value) ? value : null;
function count(value) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// One aggregate over a `skill_events` CTE of (skill, kind, session, user).
const aggregate = `
SELECT skill,
    count() AS calls,
    countIf(kind = 'explicit') AS explicit,
    countIf(kind = 'automatic') AS automatic,
    countIf(kind = 'nested') AS nested,
    uniqExactIf(user, user != '') AS users,
    uniqExactIf(session, session != '') AS sessions
FROM skill_events
GROUP BY skill
ORDER BY calls DESC, skill
LIMIT ${SKILL_ROW_LIMIT + 1}`;

export function claudeSkillsSql(from, to, filters = {}) {
  const scope = claudeProductivityScope(filters);
  const user = "coalesce(nullIf(ResourceAttributes['user.email'], ''), nullIf(ResourceAttributes['enduser.id'], ''), '')";
  return {
    sql: `${GROUP_CTE}${scope.cte}, claude_events AS (
      SELECT DISTINCT Timestamp, mapSort(ResourceAttributes) AS r, mapSort(LogAttributes) AS a,
        SessionId AS session, ${user} AS user
      FROM claude_code.otel_logs
      WHERE Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime}
        AND EventName IN ('skill_activated', 'claude_code.skill_activated')
    ), skill_events AS (
      SELECT a['skill.name'] AS skill,
        multiIf(a['invocation_trigger'] = 'user-slash', 'explicit', a['invocation_trigger'] = 'claude-proactive', 'automatic',
          a['invocation_trigger'] = 'nested-skill', 'nested', '') AS kind,
        session, user
      FROM claude_events
      WHERE 1 = 1
        ${scope.where("session", "user")}
    )${aggregate}`,
    params: { ...range(from, to, true), ...scope.params },
  };
}

export function codexSkillsUsageSql(from, to, filters = {}) {
  const scoped = codexScopedEventsSql(from, to, filters, ["codex.skill_invocation"]);
  return {
    sql: `${scoped.sql}, skill_events AS (
      SELECT a['skill.name'] AS skill,
        multiIf(a['skill.invocation_type'] = 'explicit', 'explicit', a['skill.invocation_type'] = 'implicit', 'automatic', '') AS kind,
        session, user
      FROM selected
    )${aggregate}`,
    params: scoped.params,
  };
}

// One client's rows: [{ skill, calls, explicit, automatic, nested, users, sessions }]. Codex has
// no nested kind (null). Events without a label-shaped name (none, or free text) are kept in one
// unnamed row (skill null) so they stay in the counts; when several raw names fold into it, its
// distinct users and sessions are unknown (null). A malformed count stays null. A malformed (non-array) response is null (unknown), not an empty list; a
// failed read fails the request.
export function foldClientSkills(client, rows) {
  if (!Array.isArray(rows)) return { client, skills: null, skills_limited: false, totals: null };
  const add = (a, b) => (a === null || b === null ? null : a + b);
  const skills = [];
  let unnamed = null;
  for (const r of rows.slice(0, SKILL_ROW_LIMIT)) {
    const row = { skill: label(r.skill), calls: count(r.calls), explicit: count(r.explicit), automatic: count(r.automatic),
      nested: client === "codex" ? null : count(r.nested), users: count(r.users), sessions: count(r.sessions) };
    if (row.skill !== null) { skills.push(row); continue; }
    if (!unnamed) { unnamed = row; skills.push(row); continue; }
    for (const key of ["calls", "explicit", "automatic", "nested"])
      unnamed[key] = client === "codex" && key === "nested" ? null : add(unnamed[key], row[key]);
    unnamed.users = null;
    unnamed.sessions = null;
  }
  const sum = (key) => skills.reduce((total, s) => total === null || s[key] === null ? null : total + s[key], 0);
  return { client, skills, skills_limited: rows.length > SKILL_ROW_LIMIT,
    totals: { skills: skills.filter((s) => s.skill !== null).length, calls: sum("calls"), explicit: sum("explicit"), automatic: sum("automatic"),
      nested: client === "codex" ? null : sum("nested") } };
}

export async function clientSkills(from, to, raw, enabledClients, externalSignal, run = query) {
  externalSignal?.throwIfAborted();
  const filters = validateClientFilters(raw, enabledClients);
  const requestedTo = to;
  // The overview's effective end, so the page joins this to the overview over one window.
  to = effectiveClientEnd(from, to, filters.clients);
  const jobs = filters.clients.map((client) => {
    const sql = client === "claude" ? claudeSkillsSql(from, to, filters) : codexSkillsUsageSql(from, to, filters);
    return (signal) => run(sql.sql, sql.params, signal);
  });
  const results = await clientQueryBatch(jobs, externalSignal);
  return { clients: filters.clients, skill_limit: SKILL_ROW_LIMIT,
    by_client: filters.clients.map((client, i) => foldClientSkills(client, Array.isArray(results[i]) ? results[i] : null)),
    effective_range: { from: from.toISOString(), to: to.toISOString(), requested_to: requestedTo.toISOString() } };
}
