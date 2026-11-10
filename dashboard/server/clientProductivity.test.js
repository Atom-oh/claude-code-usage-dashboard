import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodexProductivityQuery, clientProductivity, eventTotals, foldClientProductivity, foldTools, foldTopUsers,
  TOP_USER_LIMIT, UNAVAILABLE_REASONS } from "./clientProductivity.js";
import { clientProductivityClaudeSql, PRODUCTIVITY_TOOL_LIMIT } from "./queries.js";
import { ValidationError } from "./http.js";

const from = new Date("2026-09-14T10:00:00Z"), to = new Date("2026-09-14T11:00:00Z");
const hostile = "x' OR 1=1 --";

test("filters reach productivity SQL only as bound parameters", () => {
  const filters = { user: hostile, userExact: hostile, model: hostile, modelExact: hostile, backend: "anthropic", team: hostile };
  const claude = clientProductivityClaudeSql(from, to, filters);
  for (const part of ["counters", "logs", "traces", "users"]) {
    const { sql, params } = claude[part];
    assert.ok(!sql.includes(hostile), part);
    assert.equal(params.clientUser, hostile);
    assert.equal(params.clientUserExact, hostile);
    assert.equal(params.clientTeam, hostile);
    assert.equal(params.clientBackend, "anthropic");
    assert.match(sql, /claude_scope_sessions/);
    assert.match(sql, /\{clientTeam:String\}/);
  }
  // Cumulative counters use the shared increase helper and in-window observation evidence.
  assert.match(claude.counters.sql, /counter_observations/);
  assert.match(claude.counters.sql, /maxIf\(Value, TimeUnix < \{to:DateTime\}\) - maxIf\(Value, TimeUnix < \{from:DateTime\}\)/);
  // The activity index uses the shared counter helper, not raw cumulative sums.
  assert.match(claude.users.sql, /maxIf\(Value, TimeUnix < \{to:DateTime\}\) - maxIf\(Value, TimeUnix < \{from:DateTime\}\)/);
  assert.match(claude.logs.sql, new RegExp(`<= ${PRODUCTIVITY_TOOL_LIMIT} AS top`));
  const codex = buildCodexProductivityQuery(from, to, filters);
  assert.ok(!codex.sql.includes(hostile));
  assert.equal(codex.params.clientModel, hostile);
  assert.match(codex.sql, /model_sessions/);
  assert.match(codex.sql, /\{clientTeam:String\}/);
});

test("unfiltered productivity SQL omits the optional session scopes", () => {
  const claude = clientProductivityClaudeSql(from, to, {});
  assert.doesNotMatch(claude.logs.sql, /claude_scope_sessions|clientTeam/);
  assert.doesNotMatch(buildCodexProductivityQuery(from, to, {}).sql, /model_sessions|clientTeam/);
});

test("the fold keeps unknown outcomes and unavailable measures out of zero", () => {
  const claude = foldClientProductivity("claude", {
    events: { prompts: "4", tool_calls: "10", tool_successes: "7", tool_failures: "2",
      decisions_total: "5", decisions_allowed: "3", decisions_denied: "1" },
    counters: { active_user_seconds: 300, active_user_seconds_observed: 1, active_cli_seconds: 0, active_cli_seconds_observed: 0,
      commits: 0, commits_observed: true, prs: 2, prs_observed: 1, loc_added: 100, loc_added_observed: 1,
      loc_removed: 5, loc_removed_observed: 1 },
    traces: { ttft_samples: "3", ttft_p50_ms: "250" },
  });
  assert.equal(claude.tool_unknown, 1);
  assert.equal(claude.tool_success_rate, 7 / 9);
  assert.equal(claude.decisions_unknown, 1);
  assert.equal(claude.permission_allow_rate, 3 / 4);
  assert.equal(claude.tool_calls_per_prompt, 2.5);
  assert.equal(claude.ttft_p50_ms, 250);
  assert.equal(claude.ttft_source, "llm_request_span");
  assert.equal(claude.commits, 0); // Observed zero stays zero.
  assert.equal(claude.active_cli_seconds, null); // Unobserved counter stays unavailable.
  assert.deepEqual(claude.unavailable, {});

  const codex = foldClientProductivity("codex", { events: { prompts: 0, tool_calls: 0, tool_successes: 0, tool_failures: 0,
    decisions_total: 0, decisions_allowed: 0, decisions_denied: 0, ttft_samples: 0, ttft_p50_ms: null } });
  assert.equal(codex.prompts, 0);
  assert.equal(codex.tool_success_rate, null);
  assert.equal(codex.permission_allow_rate, null);
  assert.equal(codex.tool_calls_per_prompt, null);
  assert.equal(codex.ttft_p50_ms, null);
  for (const field of ["prs", "commits", "loc_added", "loc_removed", "active_user_seconds", "active_cli_seconds"])
    assert.equal(codex[field], null, field);
  assert.deepEqual(codex.unavailable, { active_user_seconds: "not_derived", active_cli_seconds: "not_derived",
    prs: "not_collected", commits: "not_collected", loc_added: "not_collected", loc_removed: "not_collected",
    permission_wait_p50_ms: "not_aggregated", top_users: "not_derived" });
  assert.deepEqual([codex.permission_wait_p50_ms, codex.top_users], [null, null]);
  assert.ok(Object.values(codex.unavailable).every((reason) => UNAVAILABLE_REASONS.includes(reason)));
  // Malformed counts become unknown rather than zero.
  const malformed = foldClientProductivity("codex", { events: { prompts: "-1", tool_calls: "x" } });
  assert.equal(malformed.prompts, null);
  assert.equal(malformed.tool_calls, null);
  assert.equal(malformed.tool_unknown, null);
});

test("the endpoint returns one row per selected client over the overview's effective range", async () => {
  const seen = [];
  const run = async (sql) => {
    seen.push(sql);
    if (sql.includes("codex_events")) return [{ kind: "prompt", top: 1, tool_key: "", events: 2 },
      { kind: "result", top: 1, tool_key: "shell", events: 3, successes: 3, failures: 0 },
      { kind: "decision", top: 1, tool_key: "shell", events: 1, allowed: 1, denied: 0, source_counts: [["User"], ["1"]] },
      { kind: "ttft", top: 1, tool_key: "", events: 1, duration_samples: 1, duration_p50_ms: 40, duration_p90_ms: 40 }];
    if (sql.includes("claude_events")) return [{ kind: "prompt", top: 1, tool_key: "", events: 1 },
      { kind: "result", top: 1, tool_key: "Bash", events: 2, successes: 1, failures: 1 }];
    if (sql.includes("otel_traces")) return [{ ttft_samples: 0, ttft_p50_ms: null }];
    return [{ commits: 1, commits_observed: 1 }];
  };
  const historical = new Date("2026-09-14T12:30:00Z");
  const both = await clientProductivity(new Date("2026-09-14T00:00:00Z"), historical, {}, ["claude", "codex"], undefined, run);
  assert.deepEqual(both.clients, ["claude", "codex"]);
  assert.deepEqual(both.by_client.map((row) => row.client), ["claude", "codex"]);
  assert.equal(seen.length, 5);
  assert.deepEqual([both.by_client[0].prompts, both.by_client[0].tool_failures, both.by_client[0].decisions_total], [1, 1, 0]);
  assert.deepEqual(both.by_client[0].by_tool_decisions, []);
  assert.equal(both.by_client[1].by_tool_decisions[0].source, "User");
  assert.equal(both.by_client[1].tool_calls_per_prompt, 1.5);
  assert.equal(both.by_client[0].commits, 1);
  assert.equal(both.by_client[0].ttft_p50_ms, null);
  assert.equal(both.by_client[1].ttft_p50_ms, 40);
  // Claude's historical end floors to the hour exactly as /api/clients/overview does.
  assert.equal(both.effective_range.to, "2026-09-14T12:00:00.000Z");
  assert.equal(both.effective_range.requested_to, historical.toISOString());

  seen.length = 0;
  const codex = await clientProductivity(from, to, { client: "codex", backend: "bedrock-mantle" }, ["claude", "codex"], undefined, run);
  assert.deepEqual(codex.by_client.map((row) => row.client), ["codex"]);
  assert.equal(seen.length, 1);
  assert.equal(codex.effective_range.to, to.toISOString());
});

test("Claude-only channel and project filters are rejected before any query", async () => {
  let queries = 0;
  const run = async () => { queries++; return []; };
  for (const raw of [{ group: "enterprise" }, { project: "repo" }, { backend: "other" }, { client: "unknown" }])
    await assert.rejects(clientProductivity(from, to, raw, ["claude", "codex"], undefined, run), ValidationError);
  assert.equal(queries, 0);
});

test("per-tool rows fold sources, keep the remainder last and never turn a missing response into a list", () => {
  const rows = [
    { kind: "decision", top: 1, tool_key: "Bash", tools: "1", events: "5", allowed: "3", denied: "1",
      source_counts: [["user_temporary", "config"], ["2", "2"]] },
    { kind: "decision", top: 0, tool_key: "", tools: "4", events: "9", allowed: "9", denied: "0", source_counts: [["config"], ["9"]] },
    { kind: "decision", top: 1, tool_key: "Edit", tools: "1", events: "7", allowed: "x", denied: "0", source_counts: [["hook"], ["7"]] },
    { kind: "result", top: 1, tool_key: "Read", tools: "1", events: "4", successes: "3", failures: "0",
      duration_samples: "0", duration_p50_ms: 12 },
  ];
  const decisions = foldTools(rows, "decision");
  assert.deepEqual(decisions.map((row) => row.tool), ["Edit", "Bash", null]);
  assert.equal(decisions[0].allowed, null); // Malformed count stays unknown.
  assert.equal(decisions[0].allow_rate, null);
  assert.deepEqual([decisions[1].source, decisions[1].source_decisions, decisions[1].unknown], ["config", 2, 1]);
  assert.deepEqual([decisions[2].other, decisions[2].tools], [true, 4]);
  const [read] = foldTools(rows, "result");
  assert.deepEqual([read.unknown, read.success_rate, read.duration_p50_ms], [1, 1, null]);
  assert.equal(foldTools(null, "result"), null);
  // Totals sum the kind rows; no rows is a measured zero, a malformed count or no response is unknown.
  assert.deepEqual([eventTotals(rows).decisions_total, eventTotals(rows).decisions_allowed, eventTotals(rows).prompts], [21, null, 0]);
  assert.deepEqual(eventTotals(null), {});
  assert.deepEqual(foldTools([], "result"), []);
});

test("top users rank by activity index, bound the list and keep unscored users unscored", () => {
  const range = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-02T00:00:00Z") };
  const user = (n, decisions = "2") => ({ user: `u${String(n).padStart(2, "0")}@example.test`, sessions: "1", loc: String(n * 10),
    commits: "0", accepted: "1", decisions, active_days: "1" });
  const rows = [user(1, "0"), ...Array.from({ length: 12 }, (_, i) => user(i + 2)), { ...user(20), loc: "bad" }];
  const out = foldTopUsers(rows, range);
  assert.equal(out.top_users.length, TOP_USER_LIMIT);
  assert.equal(out.top_users[0].user, "u13@example.test");
  assert.deepEqual([out.activity_index_users, out.activity_index_scored], [14, 12]);
  const scores = out.top_users.map((row) => row.productivity_score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.deepEqual(foldTopUsers(null, range), { top_users: null, activity_index_users: null, activity_index_scored: null });
  assert.deepEqual(foldClientProductivity("codex", {}, range).top_users, null);
});
