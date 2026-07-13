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
