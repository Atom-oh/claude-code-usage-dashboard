import { observedTokenPair } from "./observedTokens.js";
import { computeCost as claudeComputedCost } from "./pricing.js";

// A model whose rates do not change with context length: the same rates for both tiers.
const flat = (rates) => ({ short: rates, long: rates });

// USD per million tokens; AWS model-card list prices.
// Rates already include the commercial regional fee. Never add it again.
export const DEFAULT_CODEX_PRICING = {
  // GPT-6 Astra model card, verified 2026-09-14.
  "openai.gpt-6-astra": {
    short_context_limit: 272000,
    regional: {
      short: { input: 11, cacheWrite: 13.75, cacheRead: 1.1, output: 55 },
      long: { input: 22, cacheWrite: 27.5, cacheRead: 2.2, output: 82.5 },
    },
    global: {
      short: { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
      long: { input: 20, cacheWrite: 25, cacheRead: 2, output: 75 },
    },
  },
  // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html
  // Verified 2026-10-02. Long-context rates apply to the full request above 272K input.
  "openai.gpt-6.1-sol": {
    short_context_limit: 272000,
    regional: {
      short: { input: 2.2, cacheWrite: 2.75, cacheRead: 0.11, output: 11 },
      long: { input: 4.4, cacheWrite: 5.5, cacheRead: 0.22, output: 16.5 },
    },
    global: {
      short: { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
      long: { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 15 },
    },
  },
  // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-sol.html
  // Verified 2026-10-02.
  "openai.gpt-6-sol": {
    short_context_limit: 272000,
    regional: {
      short: { input: 2.2, cacheWrite: 2.75, cacheRead: 0.22, output: 11 },
      long: { input: 4.4, cacheWrite: 5.5, cacheRead: 0.44, output: 16.5 },
    },
    global: {
      short: { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
      long: { input: 4, cacheWrite: 5, cacheRead: 0.4, output: 15 },
    },
  },
  // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-luna.html
  // Verified 2026-10-02.
  "openai.gpt-6-luna": {
    short_context_limit: 272000,
    regional: {
      short: { input: 0.11, cacheWrite: 0.1375, cacheRead: 0.011, output: 0.55 },
      long: { input: 0.22, cacheWrite: 0.275, cacheRead: 0.022, output: 0.825 },
    },
    global: {
      short: { input: 0.10, cacheWrite: 0.125, cacheRead: 0.01, output: 0.50 },
      long: { input: 0.20, cacheWrite: 0.25, cacheRead: 0.02, output: 0.75 },
    },
  },
  // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-sol.html
  // Verified 2026-10-02.
  "openai.gpt-5.6-sol": {
    short_context_limit: 272000,
    regional: {
      short: { input: 4.4, cacheWrite: 5.5, cacheRead: 0.44, output: 22 },
      long: { input: 8.8, cacheWrite: 11, cacheRead: 0.88, output: 33 },
    },
    global: {
      short: { input: 4, cacheWrite: 5, cacheRead: 0.4, output: 20 },
      long: { input: 8, cacheWrite: 10, cacheRead: 0.8, output: 30 },
    },
  },
  // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-terra.html
  // Verified 2026-10-02.
  "openai.gpt-5.6-terra": {
    short_context_limit: 272000,
    regional: {
      short: { input: 2.2, cacheWrite: 2.75, cacheRead: 0.22, output: 13.2 },
      long: { input: 4.4, cacheWrite: 5.5, cacheRead: 0.44, output: 19.8 },
    },
    global: {
      short: { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 12 },
      long: { input: 4, cacheWrite: 5, cacheRead: 0.4, output: 18 },
    },
  },
  // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-xai-grok-4-6.html
  // Verified 2026-10-02. One flat tier across the 500K window. The card publishes no
  // cache-write rate, so writes are priced as ordinary input.
  "xai.grok-4.6": {
    short_context_limit: 500000,
    regional: {
      short: { input: 2.2, cacheWrite: 2.2, cacheRead: 0.55, output: 6.6 },
      long: { input: 2.2, cacheWrite: 2.2, cacheRead: 0.55, output: 6.6 },
    },
    global: {
      short: { input: 2, cacheWrite: 2, cacheRead: 0.5, output: 6 },
      long: { input: 2, cacheWrite: 2, cacheRead: 0.5, output: 6 },
    },
  },
  // https://aws.amazon.com/bedrock/pricing/ (model card links there), verified 2026-10-07.
  // Cross-Region only (us./global.). One flat tier across the 1M window; cache write is the
  // published 30-minute rate.
  "zai.glm-5.3": {
    short_context_limit: 1000000,
    regional: {
      short: { input: 1.848, cacheWrite: 2.31, cacheRead: 0.3432, output: 5.808 },
      long: { input: 1.848, cacheWrite: 2.31, cacheRead: 0.3432, output: 5.808 },
    },
    global: {
      short: { input: 1.68, cacheWrite: 2.1, cacheRead: 0.312, output: 5.28 },
      long: { input: 1.68, cacheWrite: 2.1, cacheRead: 0.312, output: 5.28 },
    },
  },
  // Non-OpenAI models routed through Codex (e.g. via an inferplane gateway). Rates are Standard-tier
  // list prices from the model-comparision price data, refreshed 2026-10-08; context limits are the
  // Bedrock model-card windows. All are one flat tier. Models whose card publishes no cache rates
  // price cache reads and writes as ordinary input, as for grok-4.6 above.
  // Kimi K3 / Grok 4.7: cross-Region only, regional = US/Geo CRIS, global = Global CRIS.
  "moonshotai.kimi-k3": {
    short_context_limit: 1000000,
    regional: flat({ input: 3.3, cacheWrite: 4.125, cacheRead: 0.33, output: 16.5 }),
    global: flat({ input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 }),
  },
  "xai.grok-4.7": {
    short_context_limit: 500000,
    regional: flat({ input: 2.2, cacheWrite: 2.2, cacheRead: 0.55, output: 6.6 }),
    global: flat({ input: 2, cacheWrite: 2, cacheRead: 0.5, output: 6 }),
  },
  // In-Region only (us-east-1/2, us-west-2); no global rate, so a global.-prefixed model is unpriced.
  "qwen.qwen3-coder-next": { short_context_limit: 256000, regional: flat({ input: 0.5, cacheWrite: 0.5, cacheRead: 0.5, output: 1.2 }) },
  "qwen.qwen3-next-80b-a3b": { short_context_limit: 256000, regional: flat({ input: 0.14, cacheWrite: 0.14, cacheRead: 0.14, output: 1.2 }) },
  "zai.glm-5": { short_context_limit: 200000, regional: flat({ input: 1, cacheWrite: 1, cacheRead: 1, output: 3.2 }) },
  "zai.glm-4.7": { short_context_limit: 203000, regional: flat({ input: 0.6, cacheWrite: 0.6, cacheRead: 0.6, output: 2.2 }) },
  "google.gemma-4-31b": { short_context_limit: 256000, regional: flat({ input: 0.14, cacheWrite: 0.14, cacheRead: 0.14, output: 0.4 }) },
  "google.gemma-3-27b-it": { short_context_limit: 128000, regional: flat({ input: 0.23, cacheWrite: 0.23, cacheRead: 0.23, output: 0.38 }) },
  "google.gemma-3-12b-it": { short_context_limit: 128000, regional: flat({ input: 0.09, cacheWrite: 0.09, cacheRead: 0.09, output: 0.29 }) },
  "google.gemma-3-4b-it": { short_context_limit: 128000, regional: flat({ input: 0.04, cacheWrite: 0.04, cacheRead: 0.04, output: 0.08 }) },
  // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-luna.html
  // Verified 2026-09-17. The tier applies to each response's input context.
  "openai.gpt-5.6-luna": {
    short_context_limit: 272000,
    regional: {
      short: { input: 0.22, cacheWrite: 0.275, cacheRead: 0.022, output: 1.32 },
      long: { input: 0.44, cacheWrite: 0.55, cacheRead: 0.044, output: 1.98 },
    },
    global: {
      short: { input: 0.20, cacheWrite: 0.25, cacheRead: 0.02, output: 1.20 },
      long: { input: 0.40, cacheWrite: 0.50, cacheRead: 0.04, output: 1.80 },
    },
  },
};

const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const RATE_FIELDS = ["input", "cacheWrite", "cacheRead", "output"];
function validRates(prices) {
  return object(prices) && RATE_FIELDS.every(
    (key) => typeof prices[key] === "number" && Number.isFinite(prices[key]) && prices[key] >= 0);
}
export function parseCodexPricing(raw) {
  if (!raw) return DEFAULT_CODEX_PRICING;
  let additions;
  try { additions = JSON.parse(raw); } catch { throw new Error("CODEX_PRICING_JSON must be a JSON object"); }
  if (!object(additions) || Object.keys(additions).length > 32)
    throw new Error("CODEX_PRICING_JSON must contain at most 32 model entries");
  for (const [model, value] of Object.entries(additions)) {
    if (/^(us|global)\./.test(model))
      throw new Error("Codex pricing keys must omit us. and global. routing prefixes");
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(model) || !object(value)
        || !Number.isSafeInteger(value.short_context_limit) || value.short_context_limit <= 0
        || !object(value.regional))
      throw new Error("Invalid Codex model pricing or context limit");
    for (const scope of ["regional", "global"]) {
      if (scope === "global" && value[scope] === undefined) continue;
      for (const tier of ["short", "long"]) {
        if (!validRates(value[scope]?.[tier]))
          throw new Error("Codex pricing requires finite nonnegative rates for every token bucket");
      }
    }
    if (value.backends !== undefined) {
      if (!object(value.backends))
        throw new Error(`CODEX_PRICING_JSON["${model}"].backends must be an object`);
      for (const [backend, rates] of Object.entries(value.backends)) {
        if (!["bedrock-mantle", "bedrock-runtime"].includes(backend))
          throw new Error(`CODEX_PRICING_JSON["${model}"].backends key "${backend}" must be bedrock-mantle or bedrock-runtime`);
        if (!object(rates) || (rates.regional === undefined && rates.global === undefined))
          throw new Error(`CODEX_PRICING_JSON["${model}"].backends["${backend}"] must set regional and/or global rates`);
        for (const scope of ["regional", "global"]) {
          if (rates[scope] === undefined) continue;
          for (const tier of ["short", "long"]) {
            if (!validRates(rates[scope]?.[tier]))
              throw new Error(`CODEX_PRICING_JSON["${model}"].backends["${backend}"] requires finite nonnegative rates for every token bucket`);
          }
        }
      }
    }
  }
  return { ...DEFAULT_CODEX_PRICING, ...additions };
}

export function codexModel(model) {
  return String(model || "").replace(/^(us|global)\./, "");
}

function count(value) {
  if (value === undefined || value === null || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function priceCodexUsage(row, prices = DEFAULT_CODEX_PRICING) {
  const input = count(row.input_tokens_total);
  let read = count(row.cache_read_tokens);
  let write = count(row.cache_write_tokens);
  const output = count(row.output_tokens);
  let reasoning = count(row.reasoning_tokens);
  // Keep independently observed components, but never expose an impossible subset
  // as measured usage. SQL applies the same checks before combining response rows.
  if (input !== null && read !== null && write !== null && read + write > input) read = write = null;
  if (output !== null && reasoning !== null && reasoning > output) reasoning = null;
  const valid = [input, read, write, output, reasoning].every((x) => x !== null)
    && read + write <= input && reasoning <= output && !Number(row.invalid || 0);
  const rawModel = String(row.model || "");
  const knownBackend = ["bedrock-mantle", "bedrock-runtime"].includes(row.backend);
  const scope = rawModel.startsWith("global.") ? "global" : "regional";
  const validScope = !rawModel.startsWith("us-gov.")
    && !(row.backend === "bedrock-mantle" && /^(us|global)\./.test(rawModel));
  const entry = prices[codexModel(rawModel)]; // ADR-017 backend override, then base rate.
  const rates = entry?.backends?.[row.backend]?.[scope]?.[row.context_tier] ?? entry?.[scope]?.[row.context_tier];
  // ADR-017 Claude-table fallback; existing entry always wins.
  const claudeCost = !entry && knownBackend && validScope
    ? claudeComputedCost(rawModel, row.backend, { input: input - read - write, output, cacheRead: read, cacheWrite: write })
    : null;
  const available = valid && knownBackend && validScope && (rates || claudeCost !== null);
  const amount = available
    ? rates ? ((input - read - write) * rates.input + read * rates.cacheRead
      + write * rates.cacheWrite + output * rates.output) / 1e6
      : claudeCost
    : null;
  const rounded = amount === null ? null : Math.round(amount * 1e12) / 1e12;
  const cost = Number.isFinite(rounded) ? rounded : null;
  // One reason per unpriced response, checked in this order. A known model without a rate
  // for the response's scope/tier is a scope mismatch; a configured rate that still yields a
  // non-finite estimate has no usable rate.
  const unpriced_reason = cost !== null ? null
    : !knownBackend ? "unknown_backend"
    : !validScope || (entry && !rates) ? "scope"
    : !entry && claudeCost === null ? "unknown_model"
    : !valid ? "invalid_usage"
    : "unknown_model";
  return {
    ...row,
    input_tokens: valid ? input - read - write : null,
    cache_read_tokens: read, cache_write_tokens: write, output_tokens: output,
    reasoning_tokens: reasoning, tokens: valid ? input + output : null,
    observed_tokens: observedTokenPair(row.input_tokens_total, row.output_tokens),
    cost_usd: cost,
    cost_basis: "aws_list_estimate",
    ...(cost !== null && !rates ? { price_source: "claude_table" } : {}),
    unpriced: cost === null, unpriced_reason, invalid: !valid,
  };
}
