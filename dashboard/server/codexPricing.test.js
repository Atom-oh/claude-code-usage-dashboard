import { test } from "node:test";
import assert from "node:assert/strict";
import { priceCodexUsage, parseCodexPricing, DEFAULT_CODEX_PRICING, RUNTIME_ID_ALIASES, codexModel, codexModelSql,
  mergeCodexPriceList, bareModelAlias, FLAT_CONTEXT_LIMIT } from "./codexPricing.js";

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

test("commercial geography prefixes retain known rates and the Haiku context tier", () => {
  for (const prefix of ["us.", "eu.", "apac.", "jp.", "au.", "in."]) {
    const priced = priceCodexUsage({ ...usage, backend: "bedrock-runtime",
      model: `${prefix}openai.gpt-6-astra` });
    assert.equal(priced.cost_usd, 0.00238425, prefix);
    assert.equal(priced.unpriced_reason, null, prefix);
    const haiku = priceCodexUsage({ ...usage, backend: "bedrock-runtime",
      model: `${prefix}anthropic.claude-haiku-5-5`, input_tokens_total: 100001,
      cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0,
      reasoning_tokens: 0, context_tier: "long" });
    assert.equal(haiku.cost_usd, 0.05500055, prefix);
    assert.equal(haiku.price_source, undefined, "the tiered entry must beat the flat fallback");
    assert.equal(priceCodexUsage({ ...usage, model: `${prefix}openai.gpt-6-astra` }).unpriced_reason, "scope");
  }
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

test("GPT-6.1 Sol defaults price regional and global usage in each context tier", () => {
  for (const [backend, model, context_tier, expected] of [
    ["bedrock-mantle", "openai.gpt-6.1-sol", "short", 0.00047245],
    ["bedrock-mantle", "openai.gpt-6.1-sol", "long", 0.0007799],
    ["bedrock-runtime", "global.openai.gpt-6.1-sol", "short", 0.0004295],
    ["bedrock-runtime", "global.openai.gpt-6.1-sol", "long", 0.000709],
    ["bedrock-runtime", "us.openai.gpt-6.1-sol", "short", 0.00047245],
  ]) {
    const row = priceCodexUsage({ ...usage, backend, model, context_tier });
    assert.equal(row.cost_usd, expected, `${model}/${context_tier}`);
    assert.equal(row.unpriced, false);
  }
});

test("GLM 5.3 prices US and global CRIS at their published flat rates", () => {
  for (const [model, expected] of [["global.zai.glm-5.3", 0.0002763], ["us.zai.glm-5.3", 0.00030393]]) {
    const row = priceCodexUsage({ ...usage, backend: "bedrock-runtime", model, context_tier: "short" });
    assert.equal(row.cost_usd, expected, model);
  }
});

test("non-OpenAI models routed through Codex price at their regional and global list rates", () => {
  for (const [model, expected] of [
    ["us.moonshotai.kimi-k3", 0.000715275], ["global.moonshotai.kimi-k3", 0.00065025],
    ["us.xai.grok-4.7", 0.000352], ["global.xai.grok-4.7", 0.00032],
    ["qwen.qwen3-coder-next", 0.000086],
  ]) {
    const row = priceCodexUsage({ ...usage, backend: "bedrock-runtime", model, context_tier: "short" });
    assert.equal(row.cost_usd, expected, model);
    assert.equal(row.unpriced, false);
    assert.equal(row.price_source, undefined);
  }
});

test("a regional-only model has no global rate and stays unpriced under a global. prefix", () => {
  const row = priceCodexUsage({ ...usage, backend: "bedrock-runtime", model: "global.qwen.qwen3-coder-next", context_tier: "short" });
  assert.equal(row.cost_usd, null);
  assert.equal(row.unpriced_reason, "scope");
});

test("Haiku 5.5 through Codex uses its per-request 100K tier, not the flat Claude fallback", () => {
  const at = (input, context_tier) => priceCodexUsage({ ...usage, backend: "bedrock-runtime",
    model: "global.anthropic.claude-haiku-5-5", input_tokens_total: input, cache_read_tokens: 0,
    cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0, context_tier });
  assert.equal(at(100000, "short").cost_usd, 0.01);
  assert.equal(at(100001, "long").cost_usd, 0.0500005);
  assert.equal(at(100000, "short").price_source, undefined);   // the Codex entry, not claude_table
  const regional = priceCodexUsage({ ...usage, backend: "bedrock-runtime", model: "us.anthropic.claude-haiku-5-5", context_tier: "short" });
  assert.equal(regional.cost_usd, Math.round(((49 * 0.11 + 40 * 0.011 + 11 * 0.1375 + 30 * 0.55) / 1e6) * 1e12) / 1e12);
});

test("open-weight models seen in live usage price at their In-Region list rate", () => {
  for (const [model, expected] of [["deepseek.v3.2", 0.0001175], ["minimax.minimax-m2.5", 0.000066], ["moonshotai.kimi-k2.5", 0.00015]]) {
    const row = priceCodexUsage({ ...usage, backend: "bedrock-mantle", model, context_tier: "short" });
    assert.equal(row.cost_usd, expected, model);
  }
});

test("GPT-5.4/5.5, Grok 4.3 and runtime-vs-mantle model ids price at their In-Region list rates", () => {
  for (const [model, tier, expected] of [
    ["openai.gpt-5.4", "short", 0.000671], ["openai.gpt-5.4", "long", 0.0010945],
    ["xai.grok-4.3", "short", 0.000158],
    ["moonshot.kimi-k2-thinking", "short", 0.000135], ["moonshotai.kimi-k2-thinking", "short", 0.000135],
    ["qwen.qwen3-32b-v1:0", "short", 0.000033], ["qwen.qwen3-32b", "short", 0.000033],
  ]) {
    const row = priceCodexUsage({ ...usage, backend: "bedrock-runtime", model, context_tier: tier });
    assert.equal(row.cost_usd, expected, `${model}/${tier}`);
    assert.equal(row.unpriced, false);
  }
});

test("a CODEX_PRICING_JSON override of a canonical id is read through every alias id", () => {
  const rate = { input: 2, cacheWrite: 3, cacheRead: 1, output: 4 };
  const entry = { short_context_limit: 1000, regional: { short: rate, long: rate } };
  for (const [alias, id] of Object.entries(RUNTIME_ID_ALIASES)) {
    const prices = parseCodexPricing(JSON.stringify({ [id]: entry }));
    assert.equal(prices[alias], prices[id], alias);
    for (const backend of ["bedrock-runtime", "bedrock-mantle"]) {
      assert.equal(priceCodexUsage({ ...usage, backend, model: alias, context_tier: "short" }, prices).cost_usd, 0.000291, `${backend}/${alias}`);
      assert.equal(priceCodexUsage({ ...usage, backend, model: id, context_tier: "short" }, prices).cost_usd, 0.000291, `${backend}/${id}`);
    }
  }
  // Runtime ids containing ':' fail the key pattern, so the canonical id is their only override path.
  for (const alias of ["openai.gpt-oss-120b-1:0", "openai.gpt-oss-20b-1:0", "qwen.qwen3-32b-v1:0", "qwen.qwen3-coder-30b-a3b-v1:0"])
    assert.throws(() => parseCodexPricing(JSON.stringify({ [alias]: entry })), /Invalid Codex model pricing/, alias);
});

test("a direct override of a pattern-legal alias id wins over the canonical entry", () => {
  const base = { input: 2, cacheWrite: 3, cacheRead: 1, output: 4 };
  const own = { input: 20, cacheWrite: 30, cacheRead: 10, output: 40 };
  const entry = (r) => ({ short_context_limit: 1000, regional: { short: r, long: r } });
  const prices = parseCodexPricing(JSON.stringify({
    "moonshot.kimi-k2-thinking": entry(own),
    "qwen.qwen3-vl-235b-a22b": entry(own), "qwen.qwen3-vl-235b-a22b-instruct": entry(base),
  }));
  const cost = (model) => priceCodexUsage({ ...usage, backend: "bedrock-runtime", model, context_tier: "short" }, prices).cost_usd;
  assert.equal(cost("moonshot.kimi-k2-thinking"), 0.00291);         // direct alias override
  assert.equal(cost("moonshotai.kimi-k2-thinking"), 0.000135);      // canonical default untouched
  assert.equal(cost("qwen.qwen3-vl-235b-a22b"), 0.00291);           // direct alias override beats the canonical override
  assert.equal(cost("qwen.qwen3-vl-235b-a22b-instruct"), 0.000291); // canonical override
  assert.equal(parseCodexPricing(undefined), DEFAULT_CODEX_PRICING); // no override: defaults, aliases included
  for (const [alias, id] of Object.entries(RUNTIME_ID_ALIASES))
    assert.equal(DEFAULT_CODEX_PRICING[alias], DEFAULT_CODEX_PRICING[id], alias);
});

test("GPT-5.5 prices both In-Region context tiers", () => {
  for (const [tier, expected] of [["short", 0.001342], ["long", 0.002189]]) {
    const row = priceCodexUsage({ ...usage, backend: "bedrock-runtime", model: "openai.gpt-5.5", context_tier: tier });
    assert.equal(row.cost_usd, expected, tier);
    assert.equal(row.unpriced, false, tier);
  }
});

test("every runtime-vs-mantle alias id prices like its canonical id on both backends", () => {
  for (const [model, expected] of [
    ["moonshotai.kimi-k2-thinking", 0.000135], ["moonshot.kimi-k2-thinking", 0.000135],
    ["openai.gpt-oss-120b", 0.000033], ["openai.gpt-oss-120b-1:0", 0.000033],
    ["openai.gpt-oss-20b", 0.000016], ["openai.gpt-oss-20b-1:0", 0.000016],
    ["qwen.qwen3-32b", 0.000033], ["qwen.qwen3-32b-v1:0", 0.000033],
    ["qwen.qwen3-coder-30b-a3b-instruct", 0.000033], ["qwen.qwen3-coder-30b-a3b-v1:0", 0.000033],
    ["qwen.qwen3-vl-235b-a22b-instruct", 0.0001328], ["qwen.qwen3-vl-235b-a22b", 0.0001328],
  ]) {
    for (const backend of ["bedrock-runtime", "bedrock-mantle"]) {
      const row = priceCodexUsage({ ...usage, backend, model, context_tier: "short" });
      assert.equal(row.cost_usd, expected, `${backend}/${model}`);
      assert.equal(row.unpriced, false, `${backend}/${model}`);
      assert.equal(row.price_source, undefined, `${backend}/${model}`);
    }
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
  for (const prefix of ["us.", "eu.", "apac.", "jp.", "au.", "in.", "global."])
    assert.throws(() => parseCodexPricing(JSON.stringify({ [prefix + "openai.gpt-6-astra"]: value })));
});

test("India profiles normalize for lookup and retain request tiers and scope checks", () => {
  assert.equal(codexModel("in.anthropic.claude-haiku-5-5"), "anthropic.claude-haiku-5-5");
  assert.match(codexModelSql("model"), /jp\|au\|in\|global/);
  for (const context_tier of ["short", "long"]) {
    const indian = priceCodexUsage({ ...usage, model: "in.anthropic.claude-haiku-5-5",
      backend: "bedrock-runtime", context_tier });
    const regional = priceCodexUsage({ ...usage, model: "us.anthropic.claude-haiku-5-5",
      backend: "bedrock-runtime", context_tier });
    assert.equal(indian.cost_usd, regional.cost_usd);
    assert.equal(indian.unpriced, false);
    assert.equal(indian.price_source, undefined, "The request-tier Codex entry wins over flat Claude fallback.");
  }
  assert.equal(priceCodexUsage({ ...usage, model: "in.openai.gpt-6-astra" }).unpriced_reason, "scope");
  assert.equal(priceCodexUsage({ ...usage, model: "in.openai.unknown", backend: "bedrock-runtime" })
    .unpriced_reason, "unknown_model");
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

test("the Claude-table fallback adds the 10% regional premium only to regional 4.5+ routes", () => {
  const regional = priceCodexUsage({ ...usage, backend: "bedrock-runtime", model: "us.anthropic.claude-fable-5-1" });
  assert.equal(regional.cost_usd, 0.002442);
  assert.equal(regional.price_source, "claude_table");
  const legacy = priceCodexUsage({ ...usage, backend: "bedrock-runtime", model: "us.anthropic.claude-opus-4-1" });
  assert.equal(legacy.cost_usd, priceCodexUsage({ ...usage, backend: "bedrock-runtime",
    model: "global.anthropic.claude-opus-4-1" }).cost_usd);
});

test("added OpenAI and xAI defaults price each route at its model-card rate", () => {
  for (const [backend, model, context_tier, expected] of [
    ["bedrock-mantle", "openai.gpt-6-sol", "short", 0.00047685],
    ["bedrock-runtime", "global.openai.gpt-6-sol", "long", 0.000717],
    ["bedrock-mantle", "openai.gpt-6-luna", "short", 0.0000238425],
    ["bedrock-runtime", "global.openai.gpt-5.6-sol", "short", 0.000867],
    ["bedrock-mantle", "openai.gpt-5.6-terra", "long", 0.0008877],
    ["bedrock-runtime", "global.xai.grok-4.6", "short", 0.00032],
  ]) {
    const row = priceCodexUsage({ ...usage, backend, model, context_tier });
    assert.equal(row.cost_usd, expected, `${model}/${context_tier}`);
  }
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

// AWS Price List layer (ADR-017 amendment 2026-10-28). Layers always carry fresh rate objects:
// merging marks them as Price List rates, so tests never pass the code table's own objects.
const flatRates = (input, output) => ({ input, cacheWrite: input, cacheRead: input, output });
const copyRates = (rates) => ({ ...rates });

test("a Price List scope replaces the code scope and keeps the code context limit", () => {
  const code = DEFAULT_CODEX_PRICING["moonshotai.kimi-k3"];
  const listed = { regional: { short: { input: 1, cacheWrite: 2, cacheRead: 0.5, output: 3 } } };
  const merged = mergeCodexPriceList(DEFAULT_CODEX_PRICING, { "moonshotai.kimi-k3": listed });
  const kimi = merged["moonshotai.kimi-k3"];
  assert.equal(kimi.short_context_limit, code.short_context_limit);
  assert.equal(kimi.regional.short, listed.regional.short);
  assert.equal(kimi.regional.long, listed.regional.short, "a flat code entry keeps long equal to short");
  assert.equal(kimi.global, code.global, "a scope the Price List lacks keeps the code rates");
  assert.equal(code.regional.short.input, 3.3, "the code table itself is never mutated");
});

test("Price List long-context rows set the long tier; without them tiered code rates are kept", () => {
  const short = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
  const long = { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 7.5 };
  const notes = [];
  const merged = mergeCodexPriceList(DEFAULT_CODEX_PRICING,
    { "openai.gpt-6-astra": { regional: { short, long }, global: { short: copyRates(short) } } }, notes);
  assert.deepEqual(merged["openai.gpt-6-astra"].regional, { short, long });
  assert.equal(merged["openai.gpt-6-astra"].global, DEFAULT_CODEX_PRICING["openai.gpt-6-astra"].global);
  assert.deepEqual(notes, ["openai.gpt-6-astra global: no long-context rows; keeping the code table's tiered rates"]);
});

test("a model new to the code table prices flat at its short rates and is labelled", () => {
  const short = flatRates(0.2, 0.6), long = flatRates(0.4, 1.2);
  const notes = [];
  const merged = mergeCodexPriceList(DEFAULT_CODEX_PRICING, { "acme.new-model": { regional: { short, long } } }, notes);
  assert.deepEqual(merged["acme.new-model"], { short_context_limit: FLAT_CONTEXT_LIMIT, regional: { short, long: short } });
  assert.match(notes[0], /^acme\.new-model regional: no known context limit/);
  const row = priceCodexUsage({ ...usage, model: "acme.new-model" }, merged);
  assert.equal(row.cost_usd, 0.000038); // (49 + 40 + 11) x 0.2 + 30 x 0.6, per 1M
  assert.equal(row.price_source, "aws_price_list");
});

test("price_source names the AWS Price List only for rates that came from it", () => {
  const astra = DEFAULT_CODEX_PRICING["openai.gpt-6-astra"];
  const prices = parseCodexPricing(undefined, { "openai.gpt-6-astra":
    { global: { short: copyRates(astra.global.short), long: copyRates(astra.global.long) } } });
  const globalUsage = { ...usage, backend: "bedrock-runtime", model: "global.openai.gpt-6-astra" };
  const listed = priceCodexUsage(globalUsage, prices);
  assert.equal(listed.price_source, "aws_price_list");
  assert.equal(listed.cost_usd, priceCodexUsage(globalUsage).cost_usd);
  assert.equal(priceCodexUsage(usage, prices).price_source, undefined, "regional rates still come from code");
  assert.equal(priceCodexUsage(globalUsage).price_source, undefined);
  assert.equal(priceCodexUsage({ ...globalUsage, output_tokens: undefined }, prices).price_source, undefined);
});

test("CODEX_PRICING_JSON entries beat the Price List and runtime aliases follow the merged entry", () => {
  const own = { short_context_limit: 1000, regional: { short: flatRates(9, 9), long: flatRates(9, 9) } };
  const prices = parseCodexPricing(JSON.stringify({ "zai.glm-4.7": own }), {
    "zai.glm-4.7": { regional: { short: flatRates(0.5, 2) } },
    "openai.gpt-oss-120b": { regional: { short: flatRates(0.5, 2) } },
  });
  assert.deepEqual(prices["zai.glm-4.7"], own);
  assert.equal(prices["openai.gpt-oss-120b"].regional.short.output, 2);
  assert.equal(prices["openai.gpt-oss-120b-1:0"], prices["openai.gpt-oss-120b"]);
  assert.equal(DEFAULT_CODEX_PRICING["openai.gpt-oss-120b-1:0"], DEFAULT_CODEX_PRICING["openai.gpt-oss-120b"]);
  assert.equal(DEFAULT_CODEX_PRICING["openai.gpt-oss-120b"].regional.short.output, 0.6);
});

test("without CODEX_PRICING_JSON, runtime aliases still follow a Price List entry", () => {
  const prices = parseCodexPricing(undefined, { "openai.gpt-oss-120b": { regional: { short: flatRates(0.5, 2) } } });
  assert.equal(prices["openai.gpt-oss-120b"].regional.short.output, 2);
  assert.equal(prices["openai.gpt-oss-120b-1:0"], prices["openai.gpt-oss-120b"]);
  assert.notEqual(prices, DEFAULT_CODEX_PRICING);
});

test("bare model ids resolve to a unique vendor entry and stay unpriced when ambiguous", () => {
  assert.equal(bareModelAlias("kimi-k3"), "moonshotai.kimi-k3");
  assert.equal(bareModelAlias("global.kimi-k3"), "global.moonshotai.kimi-k3");
  assert.equal(bareModelAlias("grok-4.6"), "xai.grok-4.6");
  assert.equal(bareModelAlias("kimi-k2-thinking"), "moonshotai.kimi-k2-thinking", "a runtime alias id is not a second vendor");
  for (const model of ["moonshotai.kimi-k3", "claude-haiku-5-5", "unknown-model", "", undefined])
    assert.equal(bareModelAlias(model), null, String(model));
  const entry = DEFAULT_CODEX_PRICING["zai.glm-4.7"];
  const table = { "aa.shared": entry, "bb.shared": entry, "cc.unique": entry, direct: entry, "dd.direct": entry };
  assert.equal(bareModelAlias("shared", table), null);
  assert.equal(bareModelAlias("unique", table), "cc.unique");
  assert.equal(bareModelAlias("direct", table), null, "an id the table prices directly needs no alias");
});
