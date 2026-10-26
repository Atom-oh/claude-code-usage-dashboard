import test from "node:test";
import assert from "node:assert/strict";
import { compareCodexCost } from "./compareCodexCost.js";
import { foldClientMetrics } from "./clientMetrics.js";

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

test("comparison ordering distinguishes strings with equal locale collation", async () => {
  const rows = ["caf\u00e9", "cafe\u0301"].map(user =>
    ({ kind: "scope_evidence", user, requires_usage: 1 }));
  let calls = 0;
  const result = await compareCodexCost(range, async () => ++calls === 1 ? rows : [...rows].reverse());
  assert.equal(result.sql_match, true);
  assert.equal(result.matched, true);
});

const usage = { client: "codex", kind: "usage", t: "2026-10-25 00:00:00",
  session: "fixture", user: "fixture@example.test", backend: "bedrock-mantle",
  model: "openai.gpt-6-astra", project: "", context_tier: "short", count: 1,
  input_tokens_total: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  output_tokens: 1, reasoning_tokens: 0, invalid: 0 };

test("comparison folds identical SQL multisets in the same order without numeric tolerance", async () => {
  const rows = [{ ...usage, output_tokens: 40000000 },
    ...Array.from({ length: 100 }, () => ({ ...usage }))];
  const reversed = rows.slice().reverse();
  const cost = input => foldClientMetrics(input, ["codex"], undefined,
    { costView: true, modelTime: true }).totals.cost_usd;
  // Prove this fixture exercises floating-point accumulation order.
  assert.notEqual(cost(rows), cost(reversed));
  let calls = 0;
  const result = await compareCodexCost(range, async () => ++calls === 1 ? rows : reversed);
  assert.equal(result.sql_match, true);
  assert.equal(result.fold_match, true);
  assert.equal(result.matched, true);
  assert.equal(rows[0].output_tokens, 40000000, "comparison must not mutate caller rows");
});

test("comparison still rejects small token changes, null changes and duplicate-count changes", async () => {
  for (const changed of [
    [{ ...usage, output_tokens: 1 + Number.EPSILON }],
    [{ ...usage, reasoning_tokens: null }],
    [usage, usage],
  ]) {
    let calls = 0;
    const result = await compareCodexCost(range, async () => ++calls === 1 ? [usage] : changed);
    assert.equal(result.sql_match, false);
    assert.equal(result.matched, false);
  }
});
