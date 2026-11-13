import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chain, lmdi, TERMS, BUNDLES, matchSessions, summarize, unitTrend, modelEconomics, outcomeCost, exemplars, isSmallModel,
} from "./tokenEconomics.js";

const CUR = { users: 42, sessions: 756, turns: 6804, requests: 43546, tokens: 1654748000, cost: 3144 };
const PREV = { users: 34, sessions: 595, turns: 5712, requests: 34272, tokens: 1199520000, cost: 2519 };
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("chain telescopes to cost", () => {
  const c = chain(CUR);
  assert.equal(c.unavailable, null);
  assert.equal(c.factors.sessions_per_user, 18);
  assert.equal(c.factors.turns_per_session, 9);
  near(TERMS.reduce((p, t) => p * c.factors[t], 1), 3144, 1e-9);
  near(c.cost_per_million_tokens, 1.9, 1e-4);
});

test("lmdi is exact", () => {
  const r = lmdi(chain(PREV), chain(CUR));
  assert.equal(r.unavailable, null);
  const want = { users: 595.8845, sessions_per_user: 79.4409, turns_per_session: -181.9964,
    requests_per_turn: 182.0223, tokens_per_request: 231.9086, cost_per_token: -282.2599 };
  for (const t of TERMS) near(r.contributions[t], want[t], 1e-3);
  near(r.bundles.growth, 675.3254, 1e-3);
  near(r.bundles.waste, 231.9345, 1e-3);
  near(r.bundles.price, -282.2599, 1e-3);
  assert.deepEqual(Object.keys(r.bundles), Object.keys(BUNDLES));
  near(TERMS.reduce((s, t) => s + r.contributions[t], 0), 625, 1e-9);
  near(r.total_change, 625, 1e-9);
});

test("equal cost uses L = C", () => {
  const r = lmdi(chain(CUR), chain(CUR));
  for (const t of TERMS) assert.equal(r.contributions[t], 0);
  assert.equal(r.total_change, 0);
});

test("zero factor makes decomposition unavailable", () => {
  const r = lmdi(chain(PREV), chain({ ...CUR, cost: 0 }));
  assert.equal(r.unavailable, "zero_factor");
  assert.equal(r.contributions, null);
  assert.equal(r.bundles, null);
  assert.equal(r.total_change, -2519);
});

test("no previous", () => {
  for (const p of [null, undefined, chain({ ...PREV, users: 0 })]) {
    const r = lmdi(p, chain(CUR));
    assert.equal(r.unavailable, "no_previous");
    assert.equal(r.contributions, null);
    assert.equal(r.total_change, null);
  }
});

test("no identified users", () => {
  const c = chain({ ...CUR, users: 0, sessions: 3 });
  assert.equal(c.unavailable, "no_users");
  assert.equal(c.factors, null);
  assert.equal(c.cost_per_million_tokens, null);
});

test("no matched sessions", () => {
  assert.equal(chain({ ...CUR, sessions: 0 }).unavailable, "no_matched_sessions");
  assert.equal(chain({ users: 1 }).unavailable, "no_matched_sessions");
});

test("a zero denominator makes its ratio undefined (null), never zero", () => {
  const c = chain({ ...CUR, tokens: 0, cost: 5 });
  assert.equal(c.unavailable, null);
  assert.equal(c.cost, 5);
  assert.equal(c.factors.cost_per_token, null);
  assert.equal(c.factors.tokens_per_request, 0);
  assert.equal(c.cost_per_million_tokens, null);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(c)));
  assert.equal(lmdi(chain(PREV), c).unavailable, "zero_factor");
  const noRequests = chain({ ...CUR, requests: 0 });
  assert.equal(noRequests.factors.tokens_per_request, null);
  assert.equal(noRequests.factors.requests_per_turn, 0);
});

test("a session with requests but zero tokens is token-invalid", () => {
  // Cost and token counters are separate series; at a window edge cost can rise while tokens do not.
  const usage = [U({ tokens: 0, cost_usd: 2 })];
  const turns = [T(), T({ kind: "request", model: "claude-sonnet-4", n: 3 })];
  const [f] = matchSessions(usage, turns);
  assert.equal(f.exclusion, "tokens_invalid");
  assert.equal(f.matched, false);
  assert.equal(summarize([f]).coverage.cost_known, 2);
});

test("near-equal costs stay finite", () => {
  const c1 = 1e6 + 1.2e-10;
  assert.notEqual(c1, 1e6);
  const base = { users: 10, sessions: 100, turns: 1000, requests: 5000, tokens: 1e9 };
  const r = lmdi(chain({ ...base, cost: 1e6 }), chain({ ...base, cost: c1 }));
  assert.equal(r.unavailable, null);
  assert.ok(TERMS.every((k) => Number.isFinite(r.contributions[k])));
  assert.ok(Object.values(r.bundles).every(Number.isFinite));
  near(TERMS.reduce((s, k) => s + r.contributions[k], 0), r.total_change, 1e-9);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

const U = (o) => ({ client: "claude", session: "s", user: "u", bucket: "A", model: "claude-sonnet-4", backend: "b", tokens: 100, cache_read: 0, cache_den: 0, cost_usd: 1, cost_basis: "reported", requests: null, ...o });
const T = (o) => ({ client: "claude", session: "s", user: "u", bucket: "", kind: "turn", model: "", n: 1, ...o });

test("excludes sessions in reason order", () => {
  const usage = [
    U({ session: "a" }), // no turns
    U({ session: "b" }), // turns, no requests
    U({ session: "c", cost_usd: null }),
    U({ session: "d", tokens: null }),
  ];
  const turns = ["b", "c", "d"].map((session) => T({ session }))
    .concat(["c", "d"].map((session) => T({ session, kind: "request", model: "claude-sonnet-4", n: 2 })));
  const facts = matchSessions(usage, turns);
  assert.deepEqual(facts.map((f) => f.exclusion), ["no_turns", "no_requests", "cost_incomplete", "tokens_invalid"]);
  const s = summarize(facts);
  assert.deepEqual(s.coverage.excluded, { no_turns: 1, no_requests: 1, cost_incomplete: 1, tokens_invalid: 1 });
  assert.equal(s.coverage.matched_sessions, 0);
  assert.equal(s.coverage.cost_known, 3);
  assert.equal(s.coverage.cost_matched, 0);
});

test("claude requests come from turn rows, codex from usage rows", () => {
  const usage = [U({ session: "c1" }), U({ client: "codex", session: "x1", requests: 7, model: "gpt-6" })];
  const turns = [
    T({ session: "c1", n: 3 }), T({ session: "c1", kind: "request", model: "claude-sonnet-4", n: 12 }),
    T({ client: "codex", session: "x1", n: 2 }),
  ];
  const facts = matchSessions(usage, turns);
  assert.equal(facts.find((f) => f.session === "c1").requests, 12);
  assert.equal(facts.find((f) => f.session === "x1").requests, 7);
  assert.ok(facts.every((f) => f.matched));
});

test("window and bucket matching differ", () => {
  const usage = [U({ bucket: "B" })];
  const turns = [T({ bucket: "", n: 2 }), T({ bucket: "", kind: "request", model: "claude-sonnet-4", n: 4 }), T({ bucket: "A", n: 2 })];
  assert.equal(matchSessions(usage, turns)[0].matched, true);
  assert.equal(matchSessions(usage, turns, { bucket: "A" })[0].exclusion, "no_requests");
  assert.equal(matchSessions(usage, turns, { bucket: "B" })[0].exclusion, "no_turns");
});

test("small model share", () => {
  const usage = [U({ model: "claude-haiku-4-5" }), U({ model: "claude-sonnet-4" })];
  const turns = [
    T(), T({ kind: "request", model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", n: 3 }),
    T({ kind: "request", model: "claude-sonnet-4", n: 9 }),
  ];
  const [f] = matchSessions(usage, turns);
  assert.equal(f.small_requests, 3);
  assert.equal(f.requests, 12);
  assert.equal(isSmallModel("global.openai.gpt-6-luna"), true);
  assert.equal(isSmallModel("unknown-model"), false);
  const m = modelEconomics([f]);
  assert.equal(m.find((r) => r.model === "claude-haiku-4-5").requests, 3);
  assert.equal(m.find((r) => r.model === "claude-haiku-4-5").small, true);
});

test("model without usage rows is unavailable, not zero", () => {
  // Claude request rows name a model that has no counter usage row in this session.
  const usage = [U({ model: "claude-sonnet-4" })];
  const turns = [T(), T({ kind: "request", model: "claude-sonnet-4", n: 2 }),
    T({ kind: "request", model: "claude-haiku-4-5", n: 3 })];
  const [f] = matchSessions(usage, turns);
  assert.equal(f.matched, true);
  const haiku = f.models.find((m) => m.model === "claude-haiku-4-5");
  assert.equal(haiku.usage_rows, 0);
  const rows = modelEconomics([f]);
  const h = rows.find((r) => r.model === "claude-haiku-4-5");
  assert.equal(h.requests, 3);
  assert.equal(h.request_share, 0.6);
  assert.equal(h.cost, null);
  assert.equal(h.tokens, null);
  assert.equal(h.cost_per_million_tokens, null);
  assert.equal(h.cost_partial, false);
  const s = rows.find((r) => r.model === "claude-sonnet-4");
  assert.equal(s.cost, 1);
  assert.equal(s.cost_partial, false);
  assert.equal(rows.at(-1).model, "claude-haiku-4-5");
});

test("model with usage in only some sessions is a partial known subtotal", () => {
  const usage = [U({ session: "a", model: "claude-haiku-4-5" }), U({ session: "b", model: "claude-sonnet-4" })];
  const turns = [
    T({ session: "a" }), T({ session: "a", kind: "request", model: "claude-haiku-4-5", n: 1 }),
    T({ session: "b" }), T({ session: "b", kind: "request", model: "claude-sonnet-4", n: 1 }),
    T({ session: "b", kind: "request", model: "claude-haiku-4-5", n: 1 }),
  ];
  const h = modelEconomics(matchSessions(usage, turns)).find((r) => r.model === "claude-haiku-4-5");
  assert.equal(h.cost, 1);
  assert.equal(h.requests, 2);
  assert.equal(h.cost_partial, true);
});

test("cache hit rate", () => {
  const usage = [U({ cache_read: 900, cache_den: 1000 })];
  const turns = [T({ bucket: "A" }), T({ bucket: "A", kind: "request", model: "claude-sonnet-4", n: 2 })];
  const [row] = unitTrend(usage, turns, ["A", "Z"]);
  assert.equal(row.cache_hit_rate, 0.9);
  assert.equal(row.cost_per_user, 1);
  assert.equal(row.cost_per_1k_requests, 500);
  assert.equal(unitTrend(usage, turns, ["Z"])[0].cost_per_user, null);
});

test("outcome cost restricted to matched sessions", () => {
  const usage = [U({ session: "m" }), U({ session: "x" })];
  const turns = [T({ session: "m" }), T({ session: "m", kind: "request", model: "claude-sonnet-4", n: 1 }), T({ session: "x" })];
  const facts = matchSessions(usage, turns);
  const seen = { commits_observed: 1, prs_observed: 1, loc_added_observed: 1 };
  const out = outcomeCost(facts, [{ session: "m", commits: 4, prs: 1, loc_added: 2000, ...seen }, { session: "x", commits: 100, prs: 9, loc_added: 9, ...seen }], 8);
  assert.deepEqual(out, { commits: 4, prs: 1, loc_added: 2000, cost_per_commit: 2, cost_per_pr: 8, cost_per_kloc: 4 });
  // An observed zero stays zero; ratios over it are null.
  const zero = outcomeCost(facts, [{ session: "m", commits: 0, prs: 0, loc_added: 0, ...seen }], 8);
  assert.deepEqual(zero, { commits: 0, prs: 0, loc_added: 0, cost_per_commit: null, cost_per_pr: null, cost_per_kloc: null });
  // No in-window evidence for matched sessions is unavailable, not zero (ADR-018), per metric.
  const unobserved = { commits: null, prs: null, loc_added: null, cost_per_commit: null, cost_per_pr: null, cost_per_kloc: null };
  assert.deepEqual(outcomeCost(facts, [], 8), unobserved);
  assert.deepEqual(outcomeCost(facts, [{ session: "x", commits: 3, ...seen }], 8), unobserved);
  const partial = outcomeCost(facts, [{ session: "m", commits: 2, prs: 0, loc_added: 0, commits_observed: "1", prs_observed: 0, loc_added_observed: false }], 8);
  assert.deepEqual(partial, { commits: 2, prs: null, loc_added: null, cost_per_commit: 4, cost_per_pr: null, cost_per_kloc: null });
  for (const missing of [null, undefined, {}]) {
    assert.deepEqual(outcomeCost(facts, missing, 8), { commits: null, prs: null, loc_added: null, cost_per_commit: null, cost_per_pr: null, cost_per_kloc: null });
  }
});

test("exemplars require activity", () => {
  const usage = [], turns = [];
  const add = (user, n, tokens, reqPerTurn) => {
    for (let i = 0; i < n; i++) {
      const session = `${user}${i}`;
      usage.push(U({ session, user, tokens, cache_read: 50, cache_den: 100 }));
      turns.push(T({ session, user, n: 5 }), T({ session, user, kind: "request", model: "claude-sonnet-4", n: 5 * reqPerTurn }));
    }
  };
  add("small", 4, 100, 1); // 4 sessions, 80 turns: not eligible
  add("a", 5, 1000, 2); add("b", 5, 500, 3); add("c", 5, 800, 1); add("d", 5, 100, 4);
  const facts = matchSessions(usage, turns);
  const ex = exemplars(facts, null);
  assert.equal(ex.eligible_users, 4);
  const tpr = ex.levers.find((l) => l.lever === "tokens_per_request");
  assert.deepEqual(tpr.top.map((r) => r.user), ["d", "b", "a", "c"]); // lowest tokens/request first
  assert.equal(tpr.top[0].commits, null);
  const rpt = ex.levers.find((l) => l.lever === "requests_per_turn");
  assert.deepEqual(rpt.top.map((r) => r.user), ["c", "a", "b", "d"]);
  assert.equal(rpt.median, 2.5);
  const withOut = exemplars(facts, [{ session: "c0", commits: 2, commits_observed: 1 }]);
  assert.equal(withOut.levers[1].top.find((r) => r.user === "c").commits, 2);
  // Users without commit evidence have unavailable commits, not zero.
  assert.equal(withOut.levers[1].top.find((r) => r.user === "a").commits, null);
  const unobserved = exemplars(facts, [{ session: "c0", commits: 0, commits_observed: 0 }]);
  assert.equal(unobserved.levers[1].top.find((r) => r.user === "c").commits, null);
});

test("exemplars list up to ten users per lever", () => {
  const usage = [], turns = [];
  for (let u = 0; u < 12; u++) {
    const user = `u${String(u).padStart(2, "0")}`;
    for (let i = 0; i < 5; i++) {
      const session = `${user}-${i}`;
      usage.push(U({ session, user, tokens: 100 * (u + 1), cache_read: 50, cache_den: 100 }));
      turns.push(T({ session, user, n: 5 }), T({ session, user, kind: "request", model: "claude-sonnet-4", n: 5 }));
    }
  }
  const ex = exemplars(matchSessions(usage, turns), null);
  assert.equal(ex.eligible_users, 12);
  const tpr = ex.levers.find((l) => l.lever === "tokens_per_request");
  assert.equal(tpr.top.length, 10);
  assert.deepEqual(tpr.top.map((r) => r.user).slice(0, 2), ["u00", "u01"]);
  // The median still covers every eligible user, not only the listed ten.
  assert.equal(tpr.median, 130);
});
