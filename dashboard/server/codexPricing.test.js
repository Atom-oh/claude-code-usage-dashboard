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

test("unpriced_reason is null when priced", () => {
  assert.equal(priceCodexUsage(usage).unpriced_reason, null, "regional short");
  const global = priceCodexUsage({ ...usage, backend: "bedrock-runtime", model: "global.openai.gpt-6-astra" });
  assert.equal(global.unpriced_reason, null, "global runtime");
  const zero = priceCodexUsage({ ...usage, input_tokens_total: 0, cache_read_tokens: 0,
    cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0 });
  assert.equal(zero.unpriced_reason, null, "known zero usage");
});

test("unpriced_reason names why a Codex response has no estimate", () => {
  for (const [patch, reason] of [
    [{ backend: "unknown" }, "unknown_backend"],
    [{ backend: "" }, "unknown_backend"],
    [{ backend: "bedrock-mantle", model: "global.openai.gpt-6-astra" }, "scope"],
    [{ backend: "bedrock-mantle", model: "us.openai.gpt-6-astra" }, "scope"],
    [{ backend: "bedrock-runtime", model: "us-gov.openai.gpt-6-astra" }, "scope"],
    [{ model: "openai.unknown" }, "unknown_model"],
    [{ cache_write_tokens: undefined }, "invalid_usage"],
    [{ cache_read_tokens: 101 }, "invalid_usage"],
    [{ output_tokens: -1 }, "invalid_usage"],
    [{ reasoning_tokens: 31 }, "invalid_usage"],
    [{ invalid: 1 }, "invalid_usage"],
  ]) {
    // An undefined patch value stringifies to {}, so the key names are added to the message.
    const label = `${JSON.stringify(patch)} (${Object.keys(patch).join(", ")})`;
    const row = priceCodexUsage({ ...usage, ...patch });
    assert.equal(row.cost_usd, null, label);
    assert.equal(row.unpriced, true, label);
    assert.equal(row.unpriced_reason, reason, label);
  }
});

test("unpriced_reason precedence is backend, scope, model rate, then usage", () => {
  for (const [patch, reason] of [
    [{ backend: "unknown", model: "openai.unknown", output_tokens: -1 }, "unknown_backend"],
    [{ backend: "bedrock-mantle", model: "global.openai.unknown", output_tokens: -1 }, "scope"],
    [{ model: "openai.unknown", output_tokens: -1 }, "unknown_model"],
    [{ backend: "bedrock-mantle", model: "global.anthropic.claude-fable-5-1" }, "scope"],
  ]) {
    const label = JSON.stringify(patch);
    const row = priceCodexUsage({ ...usage, ...patch });
    assert.equal(row.cost_usd, null, label);
    assert.equal(row.unpriced, true, label);
    assert.equal(row.unpriced_reason, reason, label);
  }
});

test("a configured model without a rate for the response scope is a scope mismatch", () => {
  const rate = { input: 2, cacheWrite: 3, cacheRead: 1, output: 4 };
  const prices = parseCodexPricing(JSON.stringify({ "openai.other": {
    short_context_limit: 1000, regional: { short: rate, long: rate },
  } }));
  const global = priceCodexUsage({ ...usage, backend: "bedrock-runtime", model: "global.openai.other" }, prices);
  assert.equal(global.cost_usd, null);
  assert.equal(global.unpriced_reason, "scope");
  const regional = priceCodexUsage({ ...usage, model: "openai.other" }, prices);
  assert.equal(regional.cost_usd, 0.000291);
  assert.equal(regional.unpriced_reason, null);
});

test("a non-finite configured estimate reports no usable rate", () => {
  const rate = { input: 1e308, cacheWrite: 1e308, cacheRead: 1e308, output: 1e308 };
  const prices = { "openai.gpt-6-astra": { regional: { short: rate } } };
  const row = priceCodexUsage(usage, prices);
  assert.equal(row.cost_usd, null);
  assert.equal(row.unpriced_reason, "unknown_model");
});

// ADR-017 Claude-table fallback.
test("an Anthropic model absent from the Codex table falls back to the Claude table", () => {
  const row = priceCodexUsage({ ...usage, backend: "bedrock-runtime", model: "global.anthropic.claude-fable-5-1" });
  assert.equal(row.cost_usd, 0.00222);
  assert.equal(row.cost_basis, "aws_list_estimate");
  assert.equal(row.price_source, "claude_table");
  assert.equal(row.unpriced, false);
  assert.equal(row.unpriced_reason, null);
});

test("the Claude-table fallback never overrides an existing Codex-table entry or an invalid scope/usage", () => {
  const codexPriced = priceCodexUsage(usage);
  assert.equal(codexPriced.price_source, undefined);
  const badScope = priceCodexUsage({ ...usage, backend: "bedrock-mantle", model: "global.anthropic.claude-fable-5-1" });
  assert.equal(badScope.cost_usd, null);
  assert.equal(badScope.unpriced_reason, "scope");
  const badUsage = priceCodexUsage({ ...usage, backend: "bedrock-runtime",
    model: "global.anthropic.claude-fable-5-1", output_tokens: -1 });
  assert.equal(badUsage.cost_usd, null);
  assert.equal(badUsage.unpriced_reason, "invalid_usage");
  const noMatch = priceCodexUsage({ ...usage, backend: "bedrock-runtime", model: "global.anthropic.claude-unreleased" });
  assert.equal(noMatch.cost_usd, null);
  assert.equal(noMatch.unpriced_reason, "unknown_model");
});

test("CODEX_PRICING_JSON accepts an optional per-backend rate override", () => {
  const prices = parseCodexPricing(JSON.stringify({ "openai.other": {
    short_context_limit: 1000,
    regional: { short: { input: 2, cacheWrite: 3, cacheRead: 1, output: 4 },
      long: { input: 2, cacheWrite: 3, cacheRead: 1, output: 4 } },
    backends: { "bedrock-runtime": { regional: { short: { input: 20, cacheWrite: 30, cacheRead: 10, output: 40 },
      long: { input: 20, cacheWrite: 30, cacheRead: 10, output: 40 } } } },
  } }));
  const mantle = priceCodexUsage({ ...usage, backend: "bedrock-mantle", model: "openai.other" }, prices);
  assert.equal(mantle.cost_usd, 0.000291); // base rate, no override for this backend
  const runtime = priceCodexUsage({ ...usage, backend: "bedrock-runtime", model: "openai.other" }, prices);
  assert.equal(runtime.cost_usd, 0.00291); // overridden rate is exactly 10x the base rate
  for (const bad of [
    { backends: { "bedrock-runtime": { regional: null } } },
    { backends: { unknown: { regional: { short: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 },
      long: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 } } } } },
    { backends: { "bedrock-runtime": {} } },
  ]) assert.throws(() => parseCodexPricing(JSON.stringify({ "openai.other": {
    short_context_limit: 1000, regional: { short: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 },
      long: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 } }, ...bad,
  } })));
});
