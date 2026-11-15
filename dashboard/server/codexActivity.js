// What a Codex turn used, for its task detail: the skills it invoked (codex.skill_invocation
// logs carry the turn's conversation.id and turn.id, so the link is exact) and its tool calls
// by tool name, MCP tools marked (Codex names an MCP tool span `mcp__<server><tool>` and puts
// the same name in tool_name; server and tool are not separable). Only enumerated labels
// leave the database: skill name, invocation type and scope, never paths or arguments.
import { toChDateTime } from "./clickhouse.js";
import { EXACT_USER, SPAN_SLACK_MS, count } from "./taskTraces.js";

// Distinct (skill, invocation, scope) rows returned per turn; beyond it the list is limited.
export const SKILL_LIMIT = 50;
// Distinct tool names returned per turn.
export const TOOL_LIMIT = 50;

const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}$/;
const label = (value) => typeof value === "string" && LABEL.test(value) ? value : null;
const INVOCATIONS = new Set(["explicit", "implicit"]);

// The turn's skill invocations in the detail's span window. Ids are exact, so the window only
// bounds the scan.
export function codexSkillsSql(from, to, q, conversationId, turnId) {
  return {
    sql: `SELECT LogAttributes['skill.name'] AS name,
    LogAttributes['skill.invocation_type'] AS invocation,
    LogAttributes['skill.scope'] AS scope,
    count() AS calls
FROM claude_code.otel_logs
PREWHERE Timestamp >= {logFrom:DateTime} AND Timestamp < {logTo:DateTime}
  AND EventName = 'codex.skill_invocation'
  AND ${EXACT_USER}
WHERE LogAttributes['conversation.id'] = {conversationId:String}
  AND LogAttributes['turn.id'] = {turnId:String}
GROUP BY name, invocation, scope
ORDER BY calls DESC, name
LIMIT ${SKILL_LIMIT + 1}`,
    params: { logFrom: toChDateTime(new Date(from.getTime() - SPAN_SLACK_MS)),
      logTo: toChDateTime(new Date(to.getTime() + SPAN_SLACK_MS)), userExact: q.userExact, conversationId, turnId },
  };
}

// Skill rows: [{ name, invocation, scope, calls }]. A name that is not label-shaped is
// withheld (null) but still counted.
export function foldCodexSkills(rows) {
  const skills = rows.slice(0, SKILL_LIMIT).map((r) => ({
    name: label(r.name),
    invocation: INVOCATIONS.has(r.invocation) ? r.invocation : null,
    scope: label(r.scope),
    calls: count(r.calls) ?? 0,
  }));
  return { skills, skills_limited: rows.length > SKILL_LIMIT };
}

// Tool calls of the turn by tool name from the folded detail spans (each Codex tool call is
// one span carrying tool_name). Durations sum the known ones; a truncated detail counts only
// the returned spans.
export function foldCodexTools(spans, truncated) {
  const byName = new Map();
  for (const s of spans) {
    const name = s.attrs?.tool_name;
    if (!name) continue;
    const t = byName.get(name) ?? { name, mcp: name.startsWith("mcp__"), calls: 0, duration_ms: 0,
      duration_partial: false, aborted: 0, known: 0 };
    t.calls += 1;
    if (s.duration_ms === null || s.duration_ms === undefined) t.duration_partial = true;
    else { t.duration_ms += s.duration_ms; t.known += 1; }
    if (s.attrs.aborted === true) t.aborted += 1;
    byName.set(name, t);
  }
  const tools = [...byName.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  for (const t of tools) { if (t.known === 0) t.duration_ms = null; delete t.known; }
  return { tools: tools.slice(0, TOOL_LIMIT), tools_partial: Boolean(truncated) || tools.length > TOOL_LIMIT };
}
