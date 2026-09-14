// USD per million tokens; AWS GPT-6 Astra model card, verified 2026-09-14.
// Rates already include the commercial regional fee. Never add it again.
export const DEFAULT_CODEX_PRICING = {
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
};

const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
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
        const prices = value[scope]?.[tier];
        if (!object(prices) || !["input", "cacheWrite", "cacheRead", "output"].every(
          (key) => typeof prices[key] === "number" && Number.isFinite(prices[key]) && prices[key] >= 0))
          throw new Error("Codex pricing requires finite nonnegative rates for every token bucket");
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
  const rates = prices[codexModel(rawModel)]?.[scope]?.[row.context_tier];
  const available = valid && knownBackend && validScope && rates;
  const amount = available ? ((input - read - write) * rates.input + read * rates.cacheRead
    + write * rates.cacheWrite + output * rates.output) / 1e6 : null;
  const rounded = amount === null ? null : Math.round(amount * 1e12) / 1e12;
  const cost = Number.isFinite(rounded) ? rounded : null;
  return {
    ...row,
    input_tokens: valid ? input - read - write : null,
    cache_read_tokens: read, cache_write_tokens: write, output_tokens: output,
    reasoning_tokens: reasoning, tokens: valid ? input + output : null,
    cost_usd: cost,
    cost_basis: "aws_list_estimate", unpriced: cost === null, invalid: !valid,
  };
}
