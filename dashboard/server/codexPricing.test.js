import { test } from "node:test";
import assert from "node:assert/strict";
import { priceCodexUsage, parseCodexPricing } from "./codexPricing.js";

const usage = { backend: "bedrock-mantle", model: "openai.gpt-6-astra", context_tier: "short",
  input_tokens_total: 100, cache_read_tokens: 40, cache_write_tokens: 11,
  output_tokens: 30, reasoning_tokens: 10 };

test("Codex prices cache subsets once and includes reasoning only through output", () => {
  const row = priceCodexUsage(usage);
  assert.equal(row.input_tokens, 49);
  assert.equal(row.tokens, 130);
  assert.equal(row.cost_usd, 0.00238425);
  assert.equal(row.cost_basis, "aws_list_estimate");
  assert.equal(row.unpriced, false);
});

test("observed tokens use the input/output pair independently of pricing and subset validation", () => {
  for (const patch of [
    {}, { model: "openai.unknown" }, { cache_write_tokens: undefined },
    { cache_read_tokens: 101 }, { reasoning_tokens: 31 },
  ]) {
    const row = priceCodexUsage({ ...usage, ...patch });
    assert.equal(row.observed_tokens, 130);
    if ("cache_write_tokens" in patch || "cache_read_tokens" in patch || "reasoning_tokens" in patch) {
      assert.equal(row.tokens, null);
      assert.equal(row.cost_usd, null);
    }
  }
});

test("unavailable or unsafe input/output pairs never become observed zero", () => {
  for (const value of [undefined, null, "", " ", false, [], {}, -1, 1.5, Infinity]) {
    for (const key of ["input_tokens_total", "output_tokens"]) {
      assert.equal(priceCodexUsage({ ...usage, [key]: value }).observed_tokens, null, key);
    }
  }
  assert.equal(priceCodexUsage({ ...usage, input_tokens_total: Number.MAX_SAFE_INTEGER,
    output_tokens: 1 }).observed_tokens, null);
  assert.equal(priceCodexUsage({ ...usage, input_tokens_total: "0", output_tokens: "0",
    cache_read_tokens: undefined, cache_write_tokens: undefined }).observed_tokens, 0);
});

test("global inference and long context use their own rates", () => {
  const global = priceCodexUsage({ ...usage, backend: "bedrock-runtime", model: "global.openai.gpt-6-astra" });
  assert.equal(global.cost_usd, 0.0021675);
  const long = priceCodexUsage({ ...usage, context_tier: "long" });
  assert.equal(long.cost_usd, 0.0039435);
  assert.equal(priceCodexUsage({ ...usage, backend: "bedrock-runtime", model: "us.openai.gpt-6-astra" }).cost_usd, 0.00238425);
});

test("Luna defaults price regional and global cache-aware usage in each context tier", () => {
  for (const [backend, model, context_tier, expected] of [
    ["bedrock-mantle", "openai.gpt-5.6-luna", "short", 0.000054285],
    ["bedrock-mantle", "openai.gpt-5.6-luna", "long", 0.00008877],
    ["bedrock-runtime", "global.openai.gpt-5.6-luna", "short", 0.00004935],
    ["bedrock-runtime", "global.openai.gpt-5.6-luna", "long", 0.0000807],
    ["bedrock-runtime", "us.openai.gpt-5.6-luna", "short", 0.000054285],
  ]) {
    const row = priceCodexUsage({ ...usage, backend, model, context_tier });
    assert.equal(row.cost_usd, expected, `${model}/${context_tier}`);
    assert.equal(row.tokens, 130);
    assert.equal(row.input_tokens, 49);
    assert.equal(row.unpriced, false);
  }
});

test("unknown rates or backend, missing cache data, and invalid subsets are unavailable", () => {
  for (const patch of [
    { model: "openai.unknown" }, { backend: "unknown" }, { cache_write_tokens: undefined },
    { cache_read_tokens: 101 }, { output_tokens: -1 }, { reasoning_tokens: 31 },
    { backend: "bedrock-mantle", model: "global.openai.gpt-6-astra" },
    { model: "us-gov.openai.gpt-6-astra", backend: "bedrock-runtime" },
  ]) {
    const row = priceCodexUsage({ ...usage, ...patch });
    assert.equal(row.cost_usd, null, JSON.stringify(patch));
    assert.equal(row.unpriced, true);
  }
});

test("known zero usage remains a real zero", () => {
  const row = priceCodexUsage({ ...usage, input_tokens_total: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0 });
  assert.equal(row.cost_usd, 0);
  assert.equal(row.unpriced, false);
});

test("invalid cache and reasoning subsets do not survive as observed component counts", () => {
  const cache = priceCodexUsage({ ...usage, cache_read_tokens: 101 });
  assert.equal(cache.cache_read_tokens, null);
  assert.equal(cache.cache_write_tokens, null);
  assert.equal(cache.output_tokens, 30);
  assert.equal(cache.cost_usd, null);
  const reasoning = priceCodexUsage({ ...usage, reasoning_tokens: 31 });
  assert.equal(reasoning.reasoning_tokens, null);
  assert.equal(reasoning.output_tokens, 30);
  assert.equal(reasoning.cache_read_tokens, 40);
  assert.equal(reasoning.cost_usd, null);
});

test("pricing overrides are validated rather than silently making costs zero", () => {
  assert.throws(() => parseCodexPricing("{"));
  assert.throws(() => parseCodexPricing('{"openai.other":{"short_context_limit":0}}'));
  const rate = { input: 2, cacheWrite: 3, cacheRead: 1, output: 4 };
  const prices = parseCodexPricing(JSON.stringify({ "openai.other": {
    short_context_limit: 1000, regional: { short: rate, long: rate },
  } }));
  assert.equal(priceCodexUsage({ ...usage, model: "openai.other" }, prices).cost_usd, 0.000291);
  assert.throws(() => parseCodexPricing(JSON.stringify({ "openai.other": {
    short_context_limit: 1000, regional: { short: { ...rate, output: -1 }, long: rate },
  } })));
});

test("pricing keys reject routing prefixes stripped by lookup", () => {
  const value = parseCodexPricing()["openai.gpt-6-astra"];
  for (const prefix of ["us.", "global."])
    assert.throws(() => parseCodexPricing(JSON.stringify({ [prefix + "openai.gpt-6-astra"]: value })));
});

test("an overflowing configured estimate is unavailable, not a JSON infinity", () => {
  const rate = { input: 1e308, cacheWrite: 1e308, cacheRead: 1e308, output: 1e308 };
  const prices = { "openai.gpt-6-astra": { regional: { short: rate } } };
  const row = priceCodexUsage(usage, prices);
  assert.equal(row.cost_usd, null);
  assert.equal(row.unpriced, true);
});
