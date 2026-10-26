import test from "node:test";
import assert from "node:assert/strict";
import { compareCodexCost } from "./compareCodexCost.js";

const range = { from: "2026-10-25T00:00:00Z", to: "2026-10-25T01:00:00Z" };
test("cost comparison rejects unbounded, invalid and reversed intervals before queries", async () => {
  for (const input of [{}, { ...range, from: "bad" }, { ...range, to: range.from },
    { ...range, to: "2026-10-27T00:00:00Z" }]) {
    await assert.rejects(compareCodexCost(input, () => assert.fail("must not query")),
      /timestamp|interval|CODEX_COST_READ_FROM/);
  }
});

test("comparison uses both real builders, bound filters, and reports empty evidence", async () => {
  const calls = [];
  const result = await compareCodexCost({ ...range, userExact: "synthetic@example.test" },
    async (sql, params) => { calls.push({ sql, params }); return []; });
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /FROM claude_code\.otel_logs/);
  assert.match(calls[1].sql, /FROM claude_code\.codex_cost_events_v1/);
  for (const call of calls) {
    assert.equal(call.params.clientUserExact, "synthetic@example.test");
    assert.equal(call.params.clientBucketSeconds, 60);
    assert.doesNotMatch(call.sql, /synthetic@example/);
  }
  assert.deepEqual(result, { matched: true, sql_match: true, fold_match: true,
    raw_rows: 0, facts_rows: 0, has_evidence: false });
});

test("comparison detects mismatches without disclosing returned telemetry", async () => {
  let calls = 0;
  const result = await compareCodexCost(range, async () => ++calls === 1
    ? [{ kind: "scope_evidence", user: "private@example.test", requires_usage: 1 }] : []);
  assert.equal(result.matched, false);
  assert.equal(result.sql_match, false);
  assert.equal(result.has_evidence, true);
  assert.doesNotMatch(JSON.stringify(result), /private@example/);
});

test("query failures abort comparison instead of pretending to match", async () => {
  await assert.rejects(compareCodexCost(range, async () => { throw new Error("query failed"); }),
    /query failed/);
});
