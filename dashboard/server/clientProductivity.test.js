import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodexProductivityQuery, clientProductivity, foldClientProductivity, UNAVAILABLE_REASONS } from "./clientProductivity.js";
import { clientProductivityClaudeSql } from "./queries.js";
import { ValidationError } from "./http.js";

const from = new Date("2026-09-14T10:00:00Z"), to = new Date("2026-09-14T11:00:00Z");
const hostile = "x' OR 1=1 --";

test("filters reach productivity SQL only as bound parameters", () => {
  const filters = { user: hostile, userExact: hostile, model: hostile, modelExact: hostile, backend: "anthropic", team: hostile };
  const claude = clientProductivityClaudeSql(from, to, filters);
  for (const part of ["counters", "logs", "traces"]) {
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
    prs: "not_collected", commits: "not_collected", loc_added: "not_collected", loc_removed: "not_collected" });
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
    if (sql.includes("codex_events")) return [{ prompts: 2, tool_calls: 3, tool_successes: 3, tool_failures: 0,
      decisions_total: 1, decisions_allowed: 1, decisions_denied: 0, ttft_samples: 1, ttft_p50_ms: 40 }];
    if (sql.includes("claude_events")) return [{ prompts: 1, tool_calls: 2, tool_successes: 1, tool_failures: 1,
      decisions_total: 0, decisions_allowed: 0, decisions_denied: 0 }];
    if (sql.includes("otel_traces")) return [{ ttft_samples: 0, ttft_p50_ms: null }];
    return [{ commits: 1, commits_observed: 1 }];
  };
  const historical = new Date("2026-09-14T12:30:00Z");
  const both = await clientProductivity(new Date("2026-09-14T00:00:00Z"), historical, {}, ["claude", "codex"], undefined, run);
  assert.deepEqual(both.clients, ["claude", "codex"]);
  assert.deepEqual(both.by_client.map((row) => row.client), ["claude", "codex"]);
  assert.equal(seen.length, 4);
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
