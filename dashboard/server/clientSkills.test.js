import test from "node:test";
import assert from "node:assert/strict";
import { SKILL_ROW_LIMIT, claudeSkillsSql, clientSkills, codexSkillsUsageSql, foldClientSkills } from "./clientSkills.js";

const from = new Date("2026-11-08T00:00:00Z"), to = new Date("2026-11-09T00:00:00Z");

test("both skill reads count each delivered event once and map invocation kinds", () => {
  const claude = claudeSkillsSql(from, to, {}).sql, codex = codexSkillsUsageSql(from, to, {}).sql;
  for (const sql of [claude, codex]) {
    assert.match(sql, /SELECT DISTINCT Timestamp, mapSort\(ResourceAttributes\) AS r, mapSort\(LogAttributes\) AS a/);
    assert.match(sql, /countIf\(kind = 'explicit'\) AS explicit/);
    assert.match(sql, new RegExp(`LIMIT ${SKILL_ROW_LIMIT + 1}`));
  }
  assert.match(claude, /EventName IN \('skill_activated', 'claude_code\.skill_activated'\)/);
  assert.match(claude, /'user-slash', 'explicit'.*'claude-proactive', 'automatic'/s);
  assert.match(claude, /'nested-skill', 'nested'/);
  assert.match(codex, /EventName IN \('codex\.skill_invocation'\)/);
  assert.match(codex, /'explicit', 'explicit', a\['skill\.invocation_type'\] = 'implicit', 'automatic'/);
});

test("skill reads apply the shared user, model and team filters", () => {
  const filters = { userExact: "kim@x.com", model: "gpt", team: "core" };
  const claude = claudeSkillsSql(from, to, filters), codex = codexSkillsUsageSql(from, to, filters);
  for (const { sql, params } of [claude, codex]) {
    assert.match(sql, /\{clientUserExact:String\} = '' OR user = \{clientUserExact:String\}/);
    assert.match(sql, /WHERE team = \{clientTeam:String\}/);
    assert.equal(params.clientUserExact, "kim@x.com");
    assert.equal(params.clientTeam, "core");
  }
  assert.match(claude.sql, /claude_scope_sessions/);
  assert.match(codex.sql, /model_sessions/);
});

test("a client's skills keep labels and counts; Codex has no nested kind", () => {
  const rows = [{ skill: "superpowers:brainstorming", calls: "5", explicit: "1", automatic: "3", nested: "1", users: "2", sessions: "4" },
    { skill: "/home/me/x y", calls: "1", explicit: "0", automatic: "1", nested: "0", users: "1", sessions: "1" }];
  const claude = foldClientSkills("claude", rows);
  assert.deepEqual(claude.skills[0], { skill: "superpowers:brainstorming", calls: 5, explicit: 1, automatic: 3, nested: 1, users: 2, sessions: 4 });
  assert.equal(claude.skills[1].skill, null);
  assert.deepEqual(claude.totals, { skills: 2, calls: 6, explicit: 1, automatic: 4, nested: 1 });
  const codex = foldClientSkills("codex", rows);
  assert.equal(codex.skills[0].nested, null);
  assert.equal(codex.totals.nested, null);
  // A malformed count makes the total unknown, not smaller.
  assert.equal(foldClientSkills("claude", [{ ...rows[0], calls: "x" }]).totals.calls, null);
  assert.deepEqual(foldClientSkills("claude", null), { client: "claude", skills: null, skills_limited: false, totals: null });
  const many = Array.from({ length: SKILL_ROW_LIMIT + 1 }, (_, i) => ({ ...rows[0], skill: `s${i}` }));
  const limited = foldClientSkills("claude", many);
  assert.equal(limited.skills.length, SKILL_ROW_LIMIT);
  assert.equal(limited.skills_limited, true);
});

test("clientSkills reads each selected client once over the overview's effective window", async () => {
  const seen = [];
  const run = async (sql, params) => {
    seen.push({ sql, params });
    return sql.includes("codex.skill_invocation") ? [{ skill: "co-agent:pr-autofix", calls: "2", explicit: "1", automatic: "1",
      nested: "0", users: "1", sessions: "1" }] : [];
  };
  const out = await clientSkills(from, to, { client: "all" }, ["claude", "codex"], undefined, run);
  assert.deepEqual(out.clients, ["claude", "codex"]);
  assert.equal(seen.length, 2);
  assert.deepEqual(out.by_client[0], { client: "claude", skills: [], skills_limited: false,
    totals: { skills: 0, calls: 0, explicit: 0, automatic: 0, nested: 0 } });
  assert.equal(out.by_client[1].skills[0].skill, "co-agent:pr-autofix");
  assert.ok(out.effective_range.from && out.effective_range.to);
  const codexOnly = await clientSkills(from, to, { client: "codex" }, ["claude", "codex"], undefined, run);
  assert.deepEqual(codexOnly.clients, ["codex"]);
});
