import { test } from "node:test";
import assert from "node:assert/strict";
import { foldFactors, isNonAnthropicModel, nacCostSql, withNacParams } from "./nonAnthropicCost.js";

// Live request (2026-10-07 12:54:42): Claude Code reported $1.819543 (Opus 5.5 rates); mayu
// priced it at the AWS long-context rate, $0.099921.
const luna = { session: "s1", model: "us.openai.gpt-6-luna", input_tokens: "2", output_tokens: "558",
  cache_read_tokens: "0", cache_creation_tokens: "361675", cost_usd: 1.819543 };

test("only models that do not normalize to claude-* are rescaled", () => {
  for (const model of ["us.openai.gpt-6-luna", "global.xai.grok-4.6", "zai.glm-5", "gemma-4-31b-vllm"])
    assert.equal(isNonAnthropicModel(model), true, model);
  for (const model of ["claude-opus-5-5[1m]", "us.anthropic.claude-fable-5-1", "anthropic.claude-sonnet-5", ""])
    assert.equal(isNonAnthropicModel(model), false, model);
});

test("the factor is the AWS estimate over the report, per request tier", () => {
  const { keys, factors } = foldFactors([luna]);
  assert.deepEqual(keys, ["s1|openai.gpt-6-luna"]);
  // 361,677 inclusive input > 272K: the whole request uses the long rate.
  assert.equal(Math.round(factors[0] * luna.cost_usd * 1e6), 99921);
  // A short request in the same session mixes into one ratio of sums.
  const short = { ...luna, cache_creation_tokens: "1000", output_tokens: "10", cost_usd: 0.0052 };
  const mixed = foldFactors([luna, short]).factors[0];
  const expected = (0.099921415 + (2 * 0.11 + 1000 * 0.1375 + 10 * 0.55) / 1e6) / (1.819543 + 0.0052);
  assert.ok(Math.abs(mixed - expected) < 1e-9);
});

test("duplicate deliveries cancel and Anthropic rows are ignored", () => {
  const once = foldFactors([luna]).factors[0];
  const twice = foldFactors([luna, luna, { ...luna, model: "claude-sonnet-5", cost_usd: 9 }]);
  assert.deepEqual(twice.keys, ["s1|openai.gpt-6-luna"]);
  assert.equal(twice.factors[0], once);
});

test("no usable estimate yields the unknown factor (-1), never the inflated report", () => {
  for (const row of [
    { ...luna, model: "gemma-4-31b-vllm" },            // no rate (self-hosted)
    { ...luna, cache_creation_tokens: "" },             // missing token component
    { ...luna, cost_usd: 0 },                           // nothing to rescale
    { ...luna, cost_usd: null },
  ]) assert.deepEqual(foldFactors([row]).factors, [-1], JSON.stringify(row));
  // One unpriced request withholds the whole session-model ratio.
  assert.deepEqual(foldFactors([luna, { ...luna, output_tokens: "-1" }]).factors, [-1]);
  // A missing report beside a valid one cannot add its estimate without a denominator.
  for (const cost_usd of [null, "", "abc", 0]) assert.deepEqual(foldFactors([luna, { ...luna, cost_usd }]).factors, [-1]);
});

test("factor params are added only for queries that reference them, over [prevFrom ?? from, to)", async () => {
  const calls = [];
  const run = async (sql, params) => { calls.push(params); return [luna]; };
  const plain = { from: "2026-10-07 00:00:00", to: "2026-10-07 13:00:00" };
  assert.equal(await withNacParams("SELECT 1", plain, run), plain);
  const sql = `SELECT ${nacCostSql("m.Value", "m.SessionId", "m.Model")}`;
  const params = await withNacParams(sql, { ...plain, prevFrom: "2026-10-06 11:00:00" }, run);
  // Widened two hours back for rollup branches that align the previous start down to the hour.
  assert.deepEqual(calls.at(-1), { from: "2026-10-06 09:00:00", to: "2026-10-07 13:00:00" });
  assert.deepEqual(params.nacKeys, ["s1|openai.gpt-6-luna"]);
  assert.equal(params.nacFactors.length, 1);
  // An empty factor set still binds both params (the client drops empty arrays).
  const empty = await withNacParams(sql, { from: "2026-10-01 00:00:00", to: "2026-10-01 01:00:00" }, async () => []);
  assert.deepEqual([empty.nacKeys, empty.nacFactors], [["|"], [-1]]);
});
