import { test } from "node:test";
import assert from "node:assert/strict";
import { userCostEfficiency } from "./costEfficiency.js";

const user = { user: "a", group: "bedrock", loc: 100, commits: 4 };

test("unit costs use reported cost while retaining computed cost for comparison", () => {
  const [row] = userCostEfficiency([user], [
    { ...user, cost: 10, reported_cost: "6", tokens: 100 },
    { ...user, cost: 2, reported_cost: "1", tokens: 100 },
  ]);
  assert.equal(row.cost, 12);
  assert.equal(row.reported_cost, 7);
  assert.equal(row.cost_per_loc, 0.07);
  assert.equal(row.cost_per_commit, 1.75);
  assert.equal(row.reported_unpriced, false);
  assert.equal(Object.hasOwn(row, "display_cost"), false);
});

test("a positive report remains usable when the server pricing table lacks the model", () => {
  const [row] = userCostEfficiency([user], [
    { ...user, cost: null, unpriced: true, reported_cost: 8, tokens: 100 },
  ]);
  assert.equal(row.cost, 0);
  assert.equal(row.unpriced, true);
  assert.equal(row.reported_unpriced, false);
  assert.equal(row.cost_per_loc, 0.08);
  assert.equal(row.cost_per_commit, 2);
});

test("zero reported cost with token usage is unpriced instead of the most efficient user", () => {
  for (const field of ["tokens", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]) {
    const [row] = userCostEfficiency([user], [
      { ...user, cost: 5, reported_cost: 0, [field]: "100" },
    ]);
    assert.equal(row.cost, 5);
    assert.equal(row.reported_cost, 0);
    assert.equal(row.reported_unpriced, true);
    assert.equal(row.cost_per_loc, null);
    assert.equal(row.cost_per_commit, null);
  }
});

test("mixed known and unpriced reports invalidate unit costs while retaining both sums", () => {
  const [row] = userCostEfficiency([user], [
    { ...user, cost: 10, reported_cost: 6, tokens: 100 },
    { ...user, cost: 5, reported_cost: 0, tokens: 100 },
  ]);
  assert.equal(row.cost, 15);
  assert.equal(row.reported_cost, 6);
  assert.equal(row.reported_unpriced, true);
  assert.equal(row.cost_per_loc, null);
  assert.equal(row.cost_per_commit, null);
});

test("reports are joined by user and group", () => {
  const other = { ...user, group: "enterprise", loc: 50, commits: 2 };
  const rows = userCostEfficiency([user, other], [
    { ...user, cost: 10, reported_cost: 6, tokens: 100 },
    { ...other, cost: 20, reported_cost: 3, tokens: 100 },
  ]);
  assert.equal(rows[0].reported_cost, 6);
  assert.equal(rows[1].reported_cost, 3);
  assert.equal(rows[0].cost_per_loc, 0.06);
  assert.equal(rows[1].cost_per_commit, 1.5);
});

test("missing or invalid reports never become zero cost", () => {
  const [missing] = userCostEfficiency([user], []);
  assert.equal(missing.reported_unpriced, true);
  assert.equal(missing.cost_per_loc, null);
  for (const reported_cost of [undefined, null, "", " ", "bad", -1, NaN, Infinity, false, []]) {
    const [row] = userCostEfficiency([user], [{ ...user, cost: 10, reported_cost, tokens: 100 }]);
    assert.equal(row.reported_unpriced, true);
    assert.equal(row.cost_per_loc, null);
    assert.equal(row.cost_per_commit, null);
  }
});

test("zero without tokens is valid and zero denominators stay guarded", () => {
  const [zero, noOutput] = userCostEfficiency([user, { ...user, user: "b", loc: 0, commits: 0 }], [
    { ...user, cost: 0, reported_cost: 0, tokens: 0 },
    { ...user, user: "b", cost: 10, reported_cost: 6, tokens: 100 },
  ]);
  assert.equal(zero.reported_unpriced, false);
  assert.equal(zero.cost_per_loc, 0);
  assert.equal(zero.cost_per_commit, 0);
  assert.equal(noOutput.cost_per_loc, null);
  assert.equal(noOutput.cost_per_commit, null);
});
