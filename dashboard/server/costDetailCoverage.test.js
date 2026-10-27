import { test } from "node:test";
import assert from "node:assert/strict";
import { rollupComputedCost } from "./pricing.js";
import { userCostEfficiency } from "./costEfficiency.js";

const model = (overrides = {}) => ({
  group: "bedrock", effort: "high", agent: "main",
  model: "fixture-unpriced", reported_cost: 5, cost_counter_rows: 1,
  input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  ...overrides,
});
const fold = (rows, dimension = "effort") =>
  rollupComputedCost(rows, ["group", dimension], { knownReports: true });

test("dimension rollups retain known reports when another model is unavailable", () => {
  for (const dimension of ["effort", "agent"]) {
    const [row] = fold([model(), model({ reported_cost: null })], dimension);
    assert.equal(row.reported_cost, null);
    assert.equal(row.known_reported_cost, 5);
    assert.equal(row.reported_partial, true);
    assert.equal(row.cost, 0, "missing diagnostic rates never replace the report");
    assert.equal(row.unpriced_tokens, 20);
  }
});

test("dimension report coverage separates channels and dimension values", () => {
  const rows = fold([
    model(), model({ reported_cost: null }),
    model({ effort: "medium", reported_cost: 2 }),
    model({ group: "enterprise", reported_cost: 3 }),
  ]);
  assert.deepEqual(rows.map((r) => [r.group, r.effort, r.known_reported_cost, r.reported_partial]), [
    ["bedrock", "high", 5, true], ["bedrock", "medium", 2, false], ["enterprise", "high", 3, false],
  ]);
});

test("dimension rollups reject missing, invalid, negative, and unverified zero reports", () => {
  for (const reported_cost of [null, undefined, "", " ", false, [], "bad", NaN, Infinity, -1, 0]) {
    const [row] = fold([model({ reported_cost })]);
    assert.equal(row.known_reported_cost, null, String(reported_cost));
    assert.equal(row.reported_partial, false);
  }
});

test("an observed zero remains available beside excluded positive-token models", () => {
  const zero = model({ reported_cost: 0, input_tokens: 0 });
  const [row] = fold([zero, model({ reported_cost: null })]);
  assert.equal(row.known_reported_cost, 0);
  assert.equal(row.reported_partial, true);
  const [complete] = fold([zero]);
  assert.equal(complete.known_reported_cost, 0);
  assert.equal(complete.reported_partial, false);
});

test("lookback-only zero counters establish neither measured zero nor exclusions", () => {
  const baseline = model({ reported_cost: 0, input_tokens: 0, cost_counter_rows: 0, observed_usage_rows: "0" });
  assert.equal(fold([baseline])[0].known_reported_cost, null);
  const [row] = fold([model(), baseline]);
  assert.equal(row.known_reported_cost, 5);
  assert.equal(row.reported_partial, false);
});

test("current zero-token samples without reports remain unavailable coverage", () => {
  for (const observed_usage_rows of [1, "1"]) {
    const missing = model({
      reported_cost: 0, input_tokens: 0, cost_counter_rows: 0, observed_usage_rows,
    });
    for (const dimension of ["effort", "agent"]) {
      const [mixed] = fold([model(), missing], dimension);
      assert.equal(mixed.known_reported_cost, 5);
      assert.equal(mixed.reported_partial, true);
      const [unknown] = fold([missing], dimension);
      assert.equal(unknown.known_reported_cost, null);
      assert.equal(unknown.reported_partial, false);
      const [zero] = fold([model({ reported_cost: 0, input_tokens: 0 }), missing], dimension);
      assert.equal(zero.known_reported_cost, 0);
      assert.equal(zero.reported_partial, true);
    }
  }
});

test("dimension coverage rejects explicitly unverified reports and overflowing totals", () => {
  const [unverified] = fold([model({ reported_unpriced: true })]);
  assert.equal(unverified.known_reported_cost, null);
  const [overflow] = fold([model({ reported_cost: Number.MAX_VALUE }), model({ reported_cost: Number.MAX_VALUE })]);
  assert.equal(overflow.known_reported_cost, null);
});

test("legacy dimension rollup callers do not acquire additive report fields", () => {
  const [row] = rollupComputedCost([model(), model({ reported_cost: null })], ["group", "effort"]);
  assert.equal(row.reported_cost, null);
  assert.equal(Object.hasOwn(row, "known_reported_cost"), false);
  assert.equal(Object.hasOwn(row, "reported_partial"), false);
});

const user = { user: "fixture-user", group: "bedrock", loc: 100, commits: 4 };
test("efficiency exposes a known subtotal without granting partial reports valid units", () => {
  const [row] = userCostEfficiency([user], [
    { ...user, cost: 10, reported_cost: 6, tokens: 100 },
    { ...user, cost: 5, reported_cost: 0, tokens: 100 },
  ]);
  assert.equal(row.reported_cost, 6, "legacy report diagnostics remain compatible");
  assert.equal(row.reported_unpriced, true);
  assert.equal(row.known_reported_cost, 6);
  assert.equal(row.reported_partial, true);
  assert.equal(row.cost_per_loc, null);
  assert.equal(row.cost_per_commit, null);
});

test("efficiency all-unknown and absent reports never acquire a zero subtotal", () => {
  for (const costs of [[], [{ ...user, cost: 5, reported_cost: null, tokens: 100 }]]) {
    const [row] = userCostEfficiency([user], costs);
    assert.equal(row.known_reported_cost, null);
    assert.equal(row.reported_partial, false);
    assert.equal(row.cost_per_loc, null);
  }
});

test("efficiency preserves valid zero and channel separation in additive amounts", () => {
  const other = { ...user, group: "enterprise" };
  const rows = userCostEfficiency([user, other], [
    { ...user, cost: 0, reported_cost: 0, tokens: 0 },
    { ...user, cost: 5, reported_cost: 0, tokens: 100 },
    { ...other, cost: null, reported_cost: 3, tokens: 100 },
  ]);
  assert.deepEqual(rows.map((r) => [r.known_reported_cost, r.reported_partial]), [[0, true], [3, false]]);
  assert.equal(rows[0].cost_per_loc, null);
  assert.equal(rows[1].cost_per_loc, 0.03);
});
