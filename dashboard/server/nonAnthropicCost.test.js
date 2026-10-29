import { test } from "node:test";
import assert from "node:assert/strict";
import { foldFactors, isNonAnthropicModel, nacCostSql, withNacParams,
  nonAnthropicFactors, clearNonAnthropicFactorCache } from "./nonAnthropicCost.js";
import { setPriceListLayersForTesting } from "./priceCatalog.js";

// Live request (2026-10-07 12:54:42): Claude Code reported $1.819543 (Opus 5.5 rates); mayu
// priced it at the AWS long-context rate, $0.099921.
const luna = { session: "s1", model: "us.openai.gpt-6-luna", input_tokens: "2", output_tokens: "558",
  cache_read_tokens: "0", cache_creation_tokens: "361675", cost_usd: 1.819543 };

test("only models that do not normalize to claude-* are rescaled", () => {
  for (const model of ["us.openai.gpt-6-luna", "global.xai.grok-4.6", "zai.glm-5", "gemma-4-31b-vllm"])
    assert.equal(isNonAnthropicModel(model), true, model);
  for (const model of ["claude-opus-5-5[1m]", "us.anthropic.claude-fable-5-1",
    "in.anthropic.claude-opus-5", "anthropic.claude-sonnet-5", ""])
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

test("140 cold views share one factor lookup for the same window", async () => {
  clearNonAnthropicFactorCache();
  let resolve, calls = 0;
  const held = new Promise(done => { resolve = done; });
  const run = async () => { calls++; return held; };
  const loads = Array.from({ length: 140 }, () =>
    nonAnthropicFactors(new Date("2026-10-14"), new Date("2026-10-15"), run));
  try {
    await new Promise(done => setImmediate(done));
    assert.equal(calls, 1);
  } finally {
    resolve([]);
    await Promise.allSettled(loads);
    clearNonAnthropicFactorCache();
  }
});

test("factor caches keep runner identity and invalidation separate", async () => {
  clearNonAnthropicFactorCache();
  const from = new Date("2026-10-14"), to = new Date("2026-10-15");
  let calls = 0;
  const first = async () => { calls++; return [luna]; };
  const second = async () => [];
  assert.deepEqual(await nonAnthropicFactors(from, to, first), foldFactors([luna]));
  assert.deepEqual(await nonAnthropicFactors(from, to, second), { keys: [], factors: [] });
  await nonAnthropicFactors(from, to, first);
  assert.equal(calls, 1);
  clearNonAnthropicFactorCache();
  await nonAnthropicFactors(from, to, first);
  assert.equal(calls, 2);
});

// 2026-10-28: Claude Code reported bare ids (kimi-k3) that the namespaced price keys never matched.
test("a bare model id prices as its unique vendor entry and keeps its own factor key", () => {
  const row = { session: "s1", model: "kimi-k3", input_tokens: "1000", output_tokens: "100",
    cache_read_tokens: "0", cache_creation_tokens: "0", cost_usd: 1 };
  const { keys, factors } = foldFactors([row]);
  assert.deepEqual(keys, ["s1|kimi-k3"]);
  assert.equal(factors[0], 0.00495); // regional kimi-k3: (1,000 x 3.3 + 100 x 16.5) / 1M over $1
  const entry = { short_context_limit: 1000000, regional: { short: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 },
    long: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 } } };
  const ambiguous = { "moonshotai.kimi-k3": entry, "other.kimi-k3": entry };
  assert.deepEqual(foldFactors([row], undefined, ambiguous).factors, [-1]);
  assert.deepEqual(foldFactors([row], undefined, {}).factors, [-1]);
});

test("foldFactors prices a model once the AWS Price List catalog has it", (t) => {
  t.after(() => setPriceListLayersForTesting());
  const row = { session: "s2", model: "nemotron-super-3-120b", input_tokens: "1000", output_tokens: "100",
    cache_read_tokens: "0", cache_creation_tokens: "0", cost_usd: 1 };
  setPriceListLayersForTesting({ snapshot: null });
  assert.deepEqual(foldFactors([row]).factors, [-1], "the code table has no Nemotron rate");
  setPriceListLayersForTesting();
  // Committed snapshot: nvidia.nemotron-super-3-120b standard rates $0.15 / $0.65 per 1M.
  assert.equal(foldFactors([row]).factors[0], 0.000215);
});

// 2026-10-28: "[1m]" ids (global.zai.glm-5.3[1m], kimi-k3[1m]) missed priced base entries.
test("a context-window suffix prices as the base model and shares its factor key", () => {
  const row = (model) => ({ session: "s1", model, input_tokens: "1000", output_tokens: "100",
    cache_read_tokens: "0", cache_creation_tokens: "0", cost_usd: 1 });
  const base = foldFactors([row("global.openai.gpt-6.1-sol")]);
  const suffixed = foldFactors([row("global.openai.gpt-6.1-sol[1m]")]);
  assert.deepEqual(suffixed, base);
  assert.notEqual(suffixed.factors[0], -1);
  assert.deepEqual(foldFactors([row("kimi-k3[1m]")]), foldFactors([row("kimi-k3")]));
});
