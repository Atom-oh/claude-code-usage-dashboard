import { test } from "node:test";
import assert from "node:assert/strict";
import { withProductivityScore } from "./productivity.js";

const row = { loc: 300, commits: 3, sessions: 4, active_days: 1, accepted: 8, decisions: 10 };
test("no permission denominator withholds the activity index; observed rejection remains measurable", () => {
  const scores = withProductivityScore([row, { ...row, accepted: 0, decisions: 0 },
    { ...row, accepted: 0 }], new Date(0), new Date(86400000));
  assert.equal(scores[0].productivity_score, 95);
  assert.equal(scores[1].accept_rate, null);
  assert.equal(scores[1].productivity_score, null);
  assert.equal(scores[2].accept_rate, 0);
  assert.equal(scores[2].productivity_score, 75);
});
