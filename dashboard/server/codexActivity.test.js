import test from "node:test";
import assert from "node:assert/strict";
import { SKILL_LIMIT, TOOL_LIMIT, codexSkillsSql, foldCodexSkills, foldCodexTools } from "./codexActivity.js";

const from = new Date("2026-11-05T00:00:00Z"), to = new Date("2026-11-05T01:00:00Z");

test("the skill read binds the turn's exact ids and owner and selects only labels", () => {
  const { sql, params } = codexSkillsSql(from, to, { userExact: "kim@x.com" }, "c1", "t1");
  assert.match(sql, /EventName = 'codex\.skill_invocation'/);
  assert.match(sql, /LogAttributes\['conversation\.id'\] = \{conversationId:String\}/);
  assert.match(sql, /LogAttributes\['turn\.id'\] = \{turnId:String\}/);
  assert.doesNotMatch(sql, /plugin_id|skill\.path/);
  // A redelivered event (same timestamp and attribute maps) counts once, before grouping.
  assert.match(sql, /cityHash64\(Timestamp, mapSort\(ResourceAttributes\), mapSort\(LogAttributes\)\) AS identity_hash/);
  assert.ok(sql.indexOf("LIMIT 1 BY identity_hash") < sql.indexOf("GROUP BY name"));
  assert.deepEqual([params.conversationId, params.turnId, params.userExact], ["c1", "t1", "kim@x.com"]);
  assert.equal(params.logFrom, "2026-11-04 00:00:00");
  assert.equal(params.logTo, "2026-11-06 01:00:00");
});

test("skills keep labels, known invocation types and counts, and withhold free text", () => {
  const out = foldCodexSkills([
    { name: "superpowers:systematic-debugging", invocation: "implicit", scope: "user", calls: "3" },
    { name: "co-agent:pr-autofix", invocation: "explicit", scope: "user", calls: "1" },
    { name: "/home/me/skill dir", invocation: "other", scope: "", calls: "1" },
  ]);
  assert.deepEqual(out.skills, [
    { name: "superpowers:systematic-debugging", invocation: "implicit", scope: "user", calls: 3 },
    { name: "co-agent:pr-autofix", invocation: "explicit", scope: "user", calls: 1 },
    { name: null, invocation: null, scope: null, calls: 1 },
  ]);
  assert.equal(out.skills_limited, false);
  const many = Array.from({ length: SKILL_LIMIT + 1 }, (_, i) => ({ name: `s${i}`, invocation: "implicit", scope: "user", calls: "1" }));
  const limited = foldCodexSkills(many);
  assert.equal(limited.skills.length, SKILL_LIMIT);
  assert.equal(limited.skills_limited, true);
});

test("tool calls group by tool name with MCP marked and known durations summed", () => {
  const span = (tool, duration, extra = {}) => ({ kind: "tool", duration_ms: duration, attrs: { tool_name: tool, ...extra } });
  const { tools, tools_partial } = foldCodexTools([
    span("exec_command", 100), span("exec_command", 300), span("mcp__awsdocsread_documentation", 4000),
    span("mcp__awsdocsread_documentation", null, { aborted: true }), span("apply_patch", null),
    { kind: "tool", duration_ms: 5, attrs: {}, internal: true }, { kind: "llm", duration_ms: 9, attrs: { model: "gpt-6.1" } },
  ], false);
  assert.deepEqual(tools, [
    { name: "exec_command", mcp: false, calls: 2, duration_ms: 400, duration_partial: false, aborted: 0 },
    { name: "mcp__awsdocsread_documentation", mcp: true, calls: 2, duration_ms: 4000, duration_partial: true, aborted: 1 },
    { name: "apply_patch", mcp: false, calls: 1, duration_ms: null, duration_partial: true, aborted: 0 },
  ]);
  assert.equal(tools_partial, false);
  assert.equal(foldCodexTools([span("x", 1)], true).tools_partial, true);
  const many = Array.from({ length: TOOL_LIMIT + 1 }, (_, i) => span(`t${i}`, 1));
  assert.equal(foldCodexTools(many, false).tools.length, TOOL_LIMIT);
  assert.equal(foldCodexTools(many, false).tools_partial, true);
});
