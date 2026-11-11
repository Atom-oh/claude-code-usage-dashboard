import { test } from "node:test";
import assert from "node:assert/strict";
import { chain, lmdi, TERMS, BUNDLES } from "./tokenEconomics.js";

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

test("zero tokens keeps chain JSON-safe", () => {
  const c = chain({ ...CUR, tokens: 0, cost: 0 });
  assert.equal(c.unavailable, null);
  assert.equal(c.cost_per_million_tokens, null);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(c)));
  assert.ok(Object.values(c.factors).every(Number.isFinite));
  assert.equal(lmdi(chain(PREV), c).unavailable, "zero_factor");
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
