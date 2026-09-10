import { test } from "node:test";
import assert from "node:assert/strict";
import { userCostEfficiency } from "./costEfficiency.js";

test("userCostEfficiency joins per-user cost onto loc/commits and derives unit costs", () => {
  const leaderboard = [
    { user: "a@x.com", group: "bedrock", loc: 100, commits: 4 },
    { user: "b@x.com", group: "enterprise", loc: 0, commits: 0 },
  ];
  const costByUserModel = [
    { user: "a@x.com", group: "bedrock", model: "claude-sonnet-4-5", cost: 3 },
    { user: "a@x.com", group: "bedrock", model: "claude-opus-4-8", cost: 7 },
    { user: "b@x.com", group: "enterprise", model: "some-unknown-model", cost: null },
  ];
  const out = userCostEfficiency(leaderboard, costByUserModel);
  assert.equal(out[0].cost, 10);
  assert.equal(out[0].cost_per_loc, 0.1);
  assert.equal(out[0].cost_per_commit, 2.5);
  assert.equal(out[1].cost, 0); // unpriced-only rows contribute nothing
  assert.equal(out[1].cost_per_loc, null); // loc=0 guards divide-by-zero
  assert.equal(out[1].cost_per_commit, null);
});

test("userCostEfficiency flags unpriced users instead of ranking them as cost=0 most-efficient", () => {
  const leaderboard = [{ user: "c@x.com", group: "bedrock", loc: 500, commits: 10 }];
  const costByUserModel = [{ user: "c@x.com", group: "bedrock", model: "some-unknown-model", cost: null }];
  const out = userCostEfficiency(leaderboard, costByUserModel);
  assert.equal(out[0].unpriced, true);
  assert.equal(out[0].cost, 0);
  // loc=500 > 0이지만 unpriced라 cost_per_loc/commit은 null이어야 한다 —
  // 아니면 $0.0000/LOC로 정렬 최상단(가짜 "가장 효율적")에 노출된다.
  assert.equal(out[0].cost_per_loc, null);
  assert.equal(out[0].cost_per_commit, null);
});

test("userCostEfficiency keys the cost join by user+group, not user alone (straddler)", () => {
  // d@x.com이 두 그룹 모두에 세션이 있는 straddler — userLeaderboard가 유저×그룹으로 행을
  // 쪼개므로(topK 다수결 아님), costByUserModel도 그룹별로 쪼개져 있어야 조인 시 한쪽 그룹의
  // 비용이 다른 쪽 그룹 행에 새지 않는다.
  const leaderboard = [
    { user: "d@x.com", group: "bedrock", loc: 100, commits: 1 },
    { user: "d@x.com", group: "enterprise", loc: 50, commits: 1 },
  ];
  const costByUserModel = [
    { user: "d@x.com", group: "bedrock", model: "claude-sonnet-4-5", cost: 10 },
    { user: "d@x.com", group: "enterprise", model: "claude-sonnet-4-5", cost: 4 },
  ];
  const out = userCostEfficiency(leaderboard, costByUserModel);
  const bedrockRow = out.find((r) => r.group === "bedrock");
  const enterpriseRow = out.find((r) => r.group === "enterprise");
  assert.equal(bedrockRow.cost, 10);
  assert.equal(enterpriseRow.cost, 4);
});

test("userCostEfficiency adds reported unit costs without changing computed costs or user+group joins", () => {
  const rows = userCostEfficiency([
    { user: "a", group: "bedrock", loc: 100, commits: 4 },
    { user: "a", group: "enterprise", loc: 50, commits: 2 },
  ], [
    { user: "a", group: "bedrock", cost: 10, reported_cost: "6", tokens: 100 },
    { user: "a", group: "bedrock", cost: 2, reported_cost: "1", tokens: 100 },
    { user: "a", group: "enterprise", cost: 20, reported_cost: "3", tokens: 100 },
  ]);
  assert.equal(rows[0].cost, 12);
  assert.equal(rows[0].cost_per_loc, 0.12);
  assert.equal(rows[0].cost_per_commit, 3);
  assert.equal(rows[0].reported_cost, 7);
  assert.equal(rows[0].display_cost, 7);
  assert.equal(rows[0].reported_cost_status, "reported");
  assert.equal(rows[0].display_cost_per_loc, 0.07);
  assert.equal(rows[0].display_cost_per_commit, 1.75);
  assert.equal(rows[1].cost, 20);
  assert.equal(rows[1].display_cost, 3);
  assert.equal(rows[1].display_cost_per_loc, 0.06);
  assert.equal(rows[1].display_cost_per_commit, 1.5);
});

test("userCostEfficiency counts reported spend from unknown-price models in display unit costs", () => {
  const [row] = userCostEfficiency([{ user: "a", group: "bedrock", loc: 100, commits: 2 }], [
    { user: "a", group: "bedrock", cost: 5, reported_cost: 3, tokens: 100 },
    { user: "a", group: "bedrock", cost: null, reported_cost: "7", tokens: 100 },
  ]);
  assert.equal(row.cost, 5);
  assert.equal(row.unpriced, true);
  assert.equal(row.cost_per_loc, null);
  assert.equal(row.cost_per_commit, null);
  assert.equal(row.reported_cost, 10);
  assert.equal(row.display_cost, 10);
  assert.equal(row.reported_cost_status, "reported");
  assert.equal(row.display_cost_per_loc, 0.1);
  assert.equal(row.display_cost_per_commit, 5);
});

test("userCostEfficiency makes mixed missing spend partial and preserves computed unit costs", () => {
  for (const reported_cost of [undefined, null, "", "bad", -1, Infinity, 0]) {
    const [row] = userCostEfficiency([{ user: "a", group: "bedrock", loc: 100, commits: 2 }], [
      { user: "a", group: "bedrock", cost: 10, reported_cost: 6, tokens: 100 },
      { user: "a", group: "bedrock", cost: 5, reported_cost, tokens: 100 },
    ]);
    assert.equal(row.cost, 15);
    assert.equal(row.cost_per_loc, 0.15);
    assert.equal(row.cost_per_commit, 7.5);
    assert.equal(row.reported_cost, 6);
    assert.equal(row.display_cost, null);
    assert.equal(row.reported_cost_status, "partial");
    assert.equal(row.display_cost_per_loc, null);
    assert.equal(row.display_cost_per_commit, null);
  }
});

test("userCostEfficiency distinguishes missing cost rows from valid zero and guards zero denominators", () => {
  const leaderboard = [
    { user: "missing", group: "bedrock", loc: 100, commits: 1 },
    { user: "zero", group: "bedrock", loc: 100, commits: 1 },
    { user: "no-output", group: "bedrock", loc: 0, commits: 0 },
  ];
  const rows = userCostEfficiency(leaderboard, [
    { user: "zero", group: "bedrock", cost: 0, reported_cost: 0, tokens: 0 },
    { user: "no-output", group: "bedrock", cost: 10, reported_cost: 6, tokens: 100 },
  ]);
  assert.equal(rows[0].display_cost, null);
  assert.equal(rows[0].reported_cost_status, "unavailable");
  assert.equal(rows[0].display_cost_per_loc, null);
  assert.equal(rows[0].display_cost_per_commit, null);
  assert.equal(rows[1].display_cost, 0);
  assert.equal(rows[1].reported_cost_status, "reported");
  assert.equal(rows[1].display_cost_per_loc, 0);
  assert.equal(rows[1].display_cost_per_commit, 0);
  assert.equal(rows[2].display_cost, 6);
  assert.equal(rows[2].display_cost_per_loc, null);
  assert.equal(rows[2].display_cost_per_commit, null);
});
