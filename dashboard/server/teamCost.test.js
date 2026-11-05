import { test } from "node:test";
import assert from "node:assert/strict";
import { foldCostSummary } from "./queries.js";

const base = { group: "bedrock", model: "claude-sonnet-5", cost_counter_rows: 1, input_tokens: 10,
  output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 0 };

test("foldCostSummary groups by team, keeps partial and unavailable, sorts 팀 없음 last", () => {
  const rows = [
    { ...base, team: "A", reported_cost: 2 },
    { ...base, team: "A", group: "unknown", reported_cost: 1 },
    { ...base, team: "B", reported_cost: null },
    { ...base, team: null, reported_cost: 0.5 },
    { ...base, team: "", reported_cost: 0.5 },
  ];
  const out = foldCostSummary(rows, "team");
  assert.deepEqual(out.map((r) => r.team), ["A", "B", null]);
  assert.equal(out[0].known_reported_cost, 3);
  assert.equal(out[0].input_tokens, 20);
  assert.equal(out[1].known_reported_cost, null);
  assert.equal(out[1].reported_partial, false);
  assert.equal(out[2].known_reported_cost, 1);
  assert.ok(out.every((r) => !("group" in r) || r.group === undefined), "team rows are not channel rows");
});

test("foldCostSummary by group is unchanged", () => {
  const rows = [{ ...base, reported_cost: 2 }, { ...base, group: "enterprise", reported_cost: 1 }];
  assert.deepEqual(foldCostSummary(rows).map((r) => [r.group, r.known_reported_cost]),
    [["bedrock", 2], ["enterprise", 1]]);
});
