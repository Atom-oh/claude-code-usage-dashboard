import { test } from "node:test";
import assert from "node:assert/strict";
import { clientTokenEconomics, tokenEconomicsWindow } from "./clientTokenEconomics.js";
import { claudeOutcomeBySessionSql } from "./queries.js";
import { TERMS } from "./tokenEconomics.js";

const FROM = new Date("2026-11-10T00:00:00Z"), TO = new Date("2026-11-11T00:00:00Z");
const PREV_FROM = "2026-11-09 00:00:00", CUR_FROM = "2026-11-10 00:00:00";
const NOW = () => new Date("2026-11-11T12:00:00Z");
const READ_FROM = new Date("2026-10-01T00:00:00Z");
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

const claudeUsage = (over = {}) => ({ t: "2026-11-10T03:00:00Z", session: "s1", user: "", model: "claude-sonnet-5",
  backend: "anthropic", channel: "enterprise", count: 1, timeline_only: 0, reported_cost: 1,
  input_tokens: 100, output_tokens: 50, cache_read_tokens: 800, cache_write_tokens: 50, ...over });
const turn = (over = {}) => ({ client: "claude", session: "s1", user: "alice@example.invalid", bucket: "",
  kind: "turn", model: "", n: 1, ...over });
const codexUsage = (over = {}) => ({ t: "2026-11-10T05:00:00Z", session: "c1", user: "bob@example.invalid",
  model: "openai.gpt-6-astra", backend: "bedrock-mantle", project: "", kind: "usage", context_tier: "short",
  count: 4, rejected_count: 0, requires_usage: 1, input_tokens_total: 1000, cache_read_tokens: 600,
  cache_write_tokens: 0, output_tokens: 200, reasoning_tokens: 0, invalid: 0, ...over });

// Window turn rows plus the same counts in one grid bucket, as turnsSql returns them.
const turnRows = (rows, bucket) => rows.flatMap((r) => [turn(r), turn({ ...r, bucket })]);

// Stub deps keyed by window start (ClickHouse DateTime params).
function stub({ claude = {}, codex = {}, turns = {}, outcomes = {}, readFrom = READ_FROM } = {}) {
  const calls = { query: [], claude: [] };
  return { calls, deps: {
    now: NOW, readFrom,
    clientClaudeRows: async (from, to, filters, nativeSeconds) => {
      calls.claude.push({ from, to, filters, nativeSeconds });
      return claude[from.toISOString()] || [];
    },
    query: async (sql, params) => {
      calls.query.push({ sql, params });
      if (sql.includes("session_turns_v1")) return (turns[params.from] || []).filter((r) => params.clients.includes(r.client)
        && (!params.clientUser || r.user.toLowerCase().includes(params.clientUser.toLowerCase()))
        && (!params.clientUserExact || r.user === params.clientUserExact));
      if (sql.includes("claude_code.commit.count")) return outcomes[params.from] || [];
      if (sql.includes("conversation.id") || sql.includes("ConversationId")) return codex[params.from] || [];
      throw new Error(`unexpected SQL ${sql.slice(0, 80)}`);
    },
  } };
}

test("returns chain, decomposition and coverage per client", async () => {
  const { deps } = stub({
    claude: {
      "2026-11-10T00:00:00.000Z": [claudeUsage({ reported_cost: 3144 }), claudeUsage({ session: "x", reported_cost: 5 })],
      "2026-11-09T00:00:00.000Z": [claudeUsage({ t: "2026-11-09T03:00:00Z", reported_cost: 2519, input_tokens: 80 })],
    },
    turns: {
      [CUR_FROM]: turnRows([{ n: 9 }, { kind: "request", model: "us.anthropic.claude-sonnet-5", n: 57 }], "2026-11-10T00:00:00Z"),
      [PREV_FROM]: turnRows([{ n: 9 }, { kind: "request", model: "claude-sonnet-5", n: 50 }], "2026-11-09T00:00:00Z"),
    },
  });
  const r = await clientTokenEconomics(FROM, TO, { intervalHours: "24" }, ["claude"], undefined, deps);
  assert.deepEqual(r.effective_range, { from: "2026-11-10T00:00:00.000Z", to: "2026-11-11T00:00:00.000Z" });
  assert.deepEqual(r.previous_range, { from: "2026-11-09T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z" });
  assert.equal(r.bucket_hours, 24);
  const c = r.by_client[0];
  assert.equal(c.client, "claude");
  assert.equal(c.cost_basis, "client_reported");
  assert.deepEqual(c.unavailable, { chain: null, decomposition: null, outcome: null });
  assert.equal(c.current.cost, 3144);
  assert.equal(c.current.users, 1);
  assert.equal(c.current.requests, 57);
  assert.equal(c.current.tokens, 1000);
  assert.equal(c.previous.cost, 2519);
  near(c.decomposition.total_change, 625);
  near(TERMS.reduce((s, t) => s + c.decomposition.contributions[t], 0), 625);
  // Session "x" has cost but no turns: excluded, and its cost is outside the matched population.
  assert.equal(c.coverage.sessions, 2);
  assert.equal(c.coverage.matched_sessions, 1);
  assert.equal(c.coverage.excluded.no_turns, 1);
  assert.equal(c.coverage.cost_known, 3149);
  assert.equal(c.coverage.cost_matched, 3144);
  assert.equal(c.previous_coverage.matched_sessions, 1);
  assert.deepEqual(c.trend.map((p) => p.t), ["2026-11-10T00:00:00Z"]);
  near(c.trend[0].cost_per_session, 3144);
  near(c.trend[0].cache_hit_rate, 800 / 950);
  assert.deepEqual(c.models.map((m) => [m.model, m.requests, m.cost]), [["claude-sonnet-5", 57, 3144]]);
  // No outcome counter evidence: unavailable per metric, not zero (ADR-018).
  assert.deepEqual(c.outcome, { commits: null, prs: null, loc_added: null, cost_per_commit: null, cost_per_pr: null, cost_per_kloc: null });
  assert.equal(c.exemplars.eligible_users, 0);
  assert.equal(r.combined.cost, 3144);
  assert.equal(r.combined.previous_cost, 2519);
  near(r.combined.decomposition.total_change, 625);
  assert.equal(r.combined.decomposition.unavailable, null);
});

test("only enabled clients are queried", async () => {
  const { deps, calls } = stub();
  const r = await clientTokenEconomics(FROM, TO, { client: "all" }, ["claude"], undefined, deps);
  assert.equal(r.by_client.length, 1);
  assert.equal(r.by_client[0].client, "claude");
  assert.ok(calls.claude.length > 0);
  assert.ok(calls.query.every((c) => !c.sql.includes("conversation.id") && !c.sql.includes("ConversationId")));
  for (const c of calls.query.filter((q) => q.sql.includes("session_turns_v1"))) assert.deepEqual(c.params.clients, ["claude"]);

  const codexOnly = stub();
  const rc = await clientTokenEconomics(FROM, TO, {}, ["codex"], undefined, codexOnly.deps);
  assert.deepEqual(rc.by_client.map((c) => c.client), ["codex"]);
  assert.equal(codexOnly.calls.claude.length, 0);
  assert.ok(codexOnly.calls.query.every((c) => !c.sql.includes("claude_code.commit.count")));
});

test("unset boundary is not_backfilled, not zero", async () => {
  const { deps, calls } = stub({ readFrom: null });
  const r = await clientTokenEconomics(FROM, TO, {}, ["claude", "codex"], undefined, deps);
  for (const c of r.by_client) {
    assert.equal(c.current, null);
    assert.equal(c.previous, null);
    assert.equal(c.unavailable.chain, "not_backfilled");
    assert.equal(c.unavailable.decomposition, "not_backfilled");
    assert.equal(c.decomposition.contributions, null);
    assert.equal(c.decomposition.total_change, null);
    assert.equal(c.coverage, null);
    assert.equal(c.trend, null);
    assert.equal(c.outcome, null);
  }
  assert.equal(r.by_client[0].unavailable.outcome, "not_backfilled");
  assert.equal(r.by_client[1].unavailable.outcome, "not_collected");
  assert.equal(r.combined.cost, null);
  assert.equal(r.combined.previous_cost, null);
  assert.equal(r.combined.decomposition.unavailable, "not_backfilled");
  assert.equal(calls.query.length + calls.claude.length, 0);
});

test("previous window before the boundary or beyond log retention gates both windows", async () => {
  // The current window starts after the boundary; the previous one does not.
  const late = stub({ readFrom: new Date("2026-11-09T12:00:00Z") });
  const r = await clientTokenEconomics(FROM, TO, {}, ["claude"], undefined, late.deps);
  assert.equal(r.by_client[0].unavailable.chain, "not_backfilled");
  assert.equal(late.calls.query.length, 0);
  const old = stub();
  const o = await clientTokenEconomics(new Date("2026-08-14T00:00:00Z"), new Date("2026-08-20T00:00:00Z"), {}, ["claude"], undefined,
    { ...old.deps, readFrom: new Date("2026-01-01T00:00:00Z") });
  assert.equal(o.by_client[0].unavailable.chain, "retention");
});

test("window shorter than an hour", async () => {
  const { deps, calls } = stub();
  const r = await clientTokenEconomics(new Date("2026-11-10T10:10:00Z"), new Date("2026-11-10T10:50:00Z"), {}, ["claude", "codex"], undefined, deps);
  for (const c of r.by_client) {
    assert.equal(c.unavailable.chain, "window_too_short");
    assert.equal(c.unavailable.decomposition, "window_too_short");
    assert.equal(c.current, null);
  }
  assert.equal(r.combined.cost, null);
  assert.equal(calls.query.length + calls.claude.length, 0);
});

test("model filter selects whole sessions", async () => {
  const cur = "2026-11-10T00:00:00.000Z";
  const { deps, calls } = stub({
    claude: { [cur]: [claudeUsage({ model: "claude-sonnet-5", reported_cost: 2 }), claudeUsage({ model: "claude-haiku-5", reported_cost: 1 }),
      claudeUsage({ session: "s2", model: "claude-sonnet-5", reported_cost: 7 }),
      claudeUsage({ session: "", model: "claude-haiku-5", reported_cost: 0.5 }), claudeUsage({ session: "", reported_cost: 11 })] },
    turns: { [CUR_FROM]: [
      ...turnRows([{ n: 2 }, { kind: "request", model: "claude-sonnet-5", n: 3 }, { kind: "request", model: "claude-haiku-5", n: 1 }], "2026-11-10T00:00:00Z"),
      ...turnRows([{ session: "s2", user: "carol@example.invalid", n: 2 }, { session: "s2", kind: "request", model: "claude-sonnet-5", n: 4 }], "2026-11-10T00:00:00Z"),
    ] },
  });
  const r = await clientTokenEconomics(FROM, TO, { model: "haiku" }, ["claude"], undefined, deps);
  const c = r.by_client[0];
  assert.equal(c.current.cost, 3);
  assert.equal(c.current.requests, 4);
  // Session s2 never used haiku: it is neither matched nor counted in coverage.
  assert.equal(c.coverage.sessions, 1);
  // Sessionless usage in the model scope is known cost outside the matched population.
  assert.equal(c.coverage.cost_unattributed, 0.5);
  assert.equal(c.coverage.cost_known, 3.5);
  assert.equal(c.models.find((m) => m.model === "claude-haiku-5").small, true);
  // Sources are queried without model/backend; the session filter is applied afterwards.
  for (const call of calls.claude) {
    assert.equal(call.filters.model, "");
    assert.equal(call.filters.modelExact, undefined);
    assert.equal(call.filters.backend, "");
  }
  const backend = await clientTokenEconomics(FROM, TO, { backend: "bedrock-runtime" }, ["claude"], undefined, deps);
  assert.equal(backend.by_client[0].coverage.sessions, 0);
  assert.equal(backend.by_client[0].unavailable.chain, "no_matched_sessions");
});

test("codex outcome is not collected", async () => {
  const cur = "2026-11-10 00:00:00", prev = "2026-11-09 00:00:00";
  const { deps } = stub({
    codex: {
      [cur]: [codexUsage(), codexUsage({ kind: "request", count: 9, cache_read_tokens: null })],
      [prev]: [codexUsage({ t: "2026-11-09T05:00:00Z", count: 2, input_tokens_total: 500, cache_read_tokens: 300 })],
    },
    turns: {
      [cur]: turnRows([{ client: "codex", session: "c1", user: "bob@example.invalid", n: 2 }], "2026-11-10T00:00:00Z"),
      [prev]: turnRows([{ client: "codex", session: "c1", user: "bob@example.invalid", n: 1 }], "2026-11-09T00:00:00Z"),
    },
  });
  const r = await clientTokenEconomics(FROM, TO, { intervalHours: "24" }, ["codex"], undefined, deps);
  const c = r.by_client[0];
  assert.equal(c.outcome, null);
  assert.equal(c.previous_outcome, null);
  assert.equal(c.unavailable.outcome, "not_collected");
  assert.equal(c.cost_basis, "aws_list_estimate");
  // Requests are completed usage records, not codex.api_request attempts.
  assert.equal(c.current.requests, 4);
  assert.equal(c.current.tokens, 1200);
  assert.ok(c.current.cost > 0);
  near(c.trend[0].cache_hit_rate, 0.6);
  assert.equal(c.unavailable.decomposition, null);
  assert.equal(c.exemplars.levers[0].top.length, 0);
});

test("codex scopes without usage make the session cost incomplete", async () => {
  const cur = "2026-11-10 00:00:00";
  const { deps } = stub({
    codex: { [cur]: [codexUsage(), codexUsage({ session: "c2", kind: "completion", count: 1 }), codexUsage({ session: "" })] },
    turns: { [cur]: [
      ...turnRows([{ client: "codex", session: "c1", n: 2 }], "2026-11-10T00:00:00Z"),
      ...turnRows([{ client: "codex", session: "c2", n: 2 }], "2026-11-10T00:00:00Z"),
    ] },
  });
  const r = await clientTokenEconomics(FROM, TO, {}, ["codex"], undefined, deps);
  assert.equal(r.by_client[0].coverage.sessions, 2);
  assert.equal(r.by_client[0].coverage.excluded.no_requests + r.by_client[0].coverage.excluded.cost_incomplete, 1);
  assert.equal(r.by_client[0].current.sessions, 1);
  const cov = r.by_client[0].coverage;
  assert.ok(cov.cost_unattributed > 0);
  near(cov.cost_known, cov.cost_matched + cov.cost_unattributed);
});

test("team filter keeps other teams out of coverage", async () => {
  const cur = "2026-11-10T00:00:00.000Z";
  const { deps, calls } = stub({
    // The usage source is team-filtered: s2 belongs to another team and is absent.
    claude: { [cur]: [claudeUsage()] },
    turns: { [CUR_FROM]: [
      ...turnRows([{ n: 2 }, { kind: "request", model: "claude-sonnet-5", n: 3 }], "2026-11-10T00:00:00Z"),
      ...turnRows([{ session: "s2", n: 4 }, { session: "s2", kind: "request", model: "claude-sonnet-5", n: 8 }], "2026-11-10T00:00:00Z"),
    ] },
  });
  const r = await clientTokenEconomics(FROM, TO, { team: "alpha" }, ["claude"], undefined, deps);
  assert.equal(r.by_client[0].coverage.sessions, 1);
  assert.equal(r.by_client[0].current.turns, 2);
  for (const call of calls.claude) assert.equal(call.filters.team, "alpha");
  // Without a team filter, a session with turns but no usage stays visible as excluded coverage.
  const open = await clientTokenEconomics(FROM, TO, {}, ["claude"], undefined, deps);
  assert.equal(open.by_client[0].coverage.sessions, 2);
  assert.equal(open.by_client[0].coverage.excluded.cost_incomplete, 1);
});

test("usage rows are re-bucketed onto the turns grid and outcomes use matched cost", async () => {
  const cur = "2026-11-10T00:00:00.000Z";
  const { deps, calls } = stub({
    claude: { [cur]: [claudeUsage({ t: "2026-11-10T07:59:00Z", reported_cost: 4 }), claudeUsage({ t: "2026-11-10T13:00:00Z", reported_cost: 6 })] },
    turns: { [CUR_FROM]: [
      turn({ n: 2 }), turn({ kind: "request", model: "claude-sonnet-5", n: 5 }),
      turn({ bucket: "2026-11-10T06:00:00Z", n: 1 }), turn({ bucket: "2026-11-10T06:00:00Z", kind: "request", model: "claude-sonnet-5", n: 2 }),
      turn({ bucket: "2026-11-10T12:00:00Z", n: 1 }), turn({ bucket: "2026-11-10T12:00:00Z", kind: "request", model: "claude-sonnet-5", n: 3 }),
    ] },
    outcomes: { [CUR_FROM]: [{ session: "s1", commits: 2, prs: 0, loc_added: 500, commits_observed: 1, prs_observed: 1, loc_added_observed: 1 },
      { session: "other", commits: 9, prs: 0, loc_added: 0, commits_observed: 1, prs_observed: 0, loc_added_observed: 0 }] },
  });
  const r = await clientTokenEconomics(FROM, TO, { intervalHours: "6" }, ["claude"], undefined, deps);
  const c = r.by_client[0];
  assert.equal(r.bucket_hours, 6);
  assert.deepEqual(c.trend.map((p) => p.t), ["2026-11-10T00:00:00Z", "2026-11-10T06:00:00Z", "2026-11-10T12:00:00Z", "2026-11-10T18:00:00Z"]);
  assert.deepEqual(c.trend.map((p) => p.cost_per_session), [null, 4, 6, null]);
  assert.equal(c.outcome.commits, 2);
  assert.equal(c.outcome.prs, 0);
  assert.equal(c.outcome.cost_per_pr, null);
  assert.equal(c.outcome.cost_per_commit, 5);
  assert.equal(c.outcome.cost_per_kloc, 20);
  assert.equal(c.previous_outcome, null);
  assert.equal(c.unavailable.decomposition, "no_previous");
  const turnsCall = calls.query.find((q) => q.sql.includes("session_turns_v1") && q.params.from === CUR_FROM);
  assert.equal(turnsCall.params.bucketSeconds, 6 * 3600);
  for (const call of calls.claude) assert.equal(call.nativeSeconds, 3600);
});

test("claude user filter uses the turns' log identity, so Bedrock sessions without UserEmail stay matched", async () => {
  const cur = "2026-11-10T00:00:00.000Z";
  const { deps, calls } = stub({
    claude: { [cur]: [claudeUsage({ user: "", reported_cost: 2 }), claudeUsage({ session: "s2", user: "alice.other@example.invalid", reported_cost: 5 }),
      claudeUsage({ session: "", user: "", reported_cost: 9 })] },
    turns: { [CUR_FROM]: [
      ...turnRows([{ n: 2 }, { kind: "request", model: "claude-sonnet-5", n: 3 }], "2026-11-10T03:00:00Z"),
      ...turnRows([{ session: "s2", user: "carol@example.invalid", n: 2 }, { session: "s2", user: "carol@example.invalid", kind: "request", model: "claude-sonnet-5", n: 3 }], "2026-11-10T03:00:00Z"),
    ] },
  });
  for (const raw of [{ user: "alice" }, { userExact: "alice@example.invalid" }]) {
    const r = await clientTokenEconomics(FROM, TO, raw, ["claude"], undefined, deps);
    const c = r.by_client[0];
    assert.equal(c.unavailable.chain, null);
    assert.equal(c.current.cost, 2);
    assert.equal(c.current.users, 1);
    // s2's counter identity contains "alice", but its log identity (carol) does not match.
    assert.equal(c.coverage.sessions, 1);
    assert.equal(c.coverage.cost_unattributed, 0);
  }
  for (const call of calls.claude) {
    assert.equal(call.filters.user, "");
    assert.equal(call.filters.userExact, undefined);
  }
  const turnCalls = calls.query.filter((q) => q.sql.includes("session_turns_v1"));
  assert.ok(turnCalls.some((q) => q.params.clientUser === "alice"));
  assert.ok(turnCalls.some((q) => q.params.clientUserExact === "alice@example.invalid"));
});

test("claude rows without token samples are token-invalid", async () => {
  const cur = "2026-11-10T00:00:00.000Z";
  const { deps } = stub({
    claude: { [cur]: [claudeUsage({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, token_observed: 0, cost_observed: 1, reported_cost: 3 })] },
    turns: { [CUR_FROM]: turnRows([{ n: 2 }, { kind: "request", model: "claude-sonnet-5", n: 3 }], "2026-11-10T03:00:00Z") },
  });
  const r = await clientTokenEconomics(FROM, TO, {}, ["claude"], undefined, deps);
  assert.equal(r.by_client[0].coverage.excluded.tokens_invalid, 1);
  assert.equal(r.by_client[0].current, null);
});

test("an unexpected query result is an error, not an empty window", async () => {
  const { deps } = stub();
  await assert.rejects(clientTokenEconomics(FROM, TO, {}, ["claude"], undefined, { ...deps, query: async () => null }),
    /query returned no row list/);
});

test("combined decomposition sums per-client contributions", async () => {
  const cur = "2026-11-10T00:00:00.000Z", prev = "2026-11-09T00:00:00.000Z";
  const { deps } = stub({
    claude: { [cur]: [claudeUsage({ reported_cost: 30 })], [prev]: [claudeUsage({ t: "2026-11-09T01:00:00Z", reported_cost: 20 })] },
    codex: { [CUR_FROM]: [codexUsage()], [PREV_FROM]: [codexUsage({ t: "2026-11-09T05:00:00Z", count: 2, output_tokens: 100 })] },
    turns: {
      [CUR_FROM]: [...turnRows([{ n: 2 }, { kind: "request", model: "claude-sonnet-5", n: 4 }], "2026-11-10T00:00:00Z"),
        ...turnRows([{ client: "codex", session: "c1", user: "bob@example.invalid", n: 3 }], "2026-11-10T00:00:00Z")],
      [PREV_FROM]: [...turnRows([{ n: 1 }, { kind: "request", model: "claude-sonnet-5", n: 3 }], "2026-11-09T00:00:00Z"),
        ...turnRows([{ client: "codex", session: "c1", user: "bob@example.invalid", n: 1 }], "2026-11-09T00:00:00Z")],
    },
  });
  const r = await clientTokenEconomics(FROM, TO, {}, ["claude", "codex"], undefined, deps);
  const [cl, cx] = r.by_client;
  near(r.combined.cost, cl.current.cost + cx.current.cost);
  near(r.combined.previous_cost, cl.previous.cost + cx.previous.cost);
  for (const t of TERMS) near(r.combined.decomposition.contributions[t], cl.decomposition.contributions[t] + cx.decomposition.contributions[t]);
  near(r.combined.decomposition.total_change, r.combined.cost - r.combined.previous_cost);
  near(r.combined.decomposition.bundles.waste, cl.decomposition.bundles.waste + cx.decomposition.bundles.waste);
});

test("window helper floors to the hour with buckets of at least one hour", () => {
  const w = tokenEconomicsWindow(new Date("2026-11-10T00:30:00Z"), new Date("2026-11-10T03:20:00Z"), ["codex"], "0.5");
  assert.equal(w.from.toISOString(), "2026-11-10T00:00:00.000Z");
  assert.equal(w.to.toISOString(), "2026-11-10T03:00:00.000Z");
  assert.equal(w.bucketSeconds, 3600);
  assert.equal(tokenEconomicsWindow(FROM, TO, ["codex"], "1.5").bucketSeconds, 7200);
});

test("outcome SQL takes counter increases per session with bound window parameters", () => {
  const { sql, params } = claudeOutcomeBySessionSql(FROM, TO);
  assert.match(sql, /'claude_code\.commit\.count', 'claude_code\.pull_request\.count', 'claude_code\.lines_of_code\.count'/);
  assert.match(sql, /m\.TokenType = 'added'/);
  assert.match(sql, /GROUP BY m\.SessionId/);
  for (const name of ["commits", "prs", "loc_added"]) assert.match(sql, new RegExp(`IN \\(SELECT \\* FROM counter_observations\\)[^,]*AS ${name}_observed`));
  assert.match(sql, /HAVING commits_observed OR prs_observed OR loc_added_observed/);
  assert.match(sql, /otel_metrics_sum_hourly/);
  assert.deepEqual(Object.keys(params).sort(), ["from", "to"]);
  assert.doesNotMatch(sql, /2026-11/);
  assert.match(claudeOutcomeBySessionSql(FROM, new Date("2026-11-10T02:00:00Z")).sql, /FROM claude_code\.otel_metrics_sum\n/);
});
