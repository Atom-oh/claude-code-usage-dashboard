import { query as rawQuery, toChDateTime } from "./clickhouse.js";
import { normalizeModelId } from "./pricing.js";
import { codexModel, parseCodexPricing, priceCodexUsage } from "./codexPricing.js";
import { resolveBackend } from "./backend.js";

// ADR-018: Claude Code prices models it does not know (OpenAI, xAI, Z.ai, ... on Bedrock) with
// its default Opus rates, so its cost.usage counter is not a usable report for them (measured
// 2-18x over AWS list price). For those models only, Claude spend is rescaled to the AWS
// list-price estimate: per (session, model), factor = sum(per-request AWS estimate) /
// sum(per-request reported cost_usd), both from api_request logs in the query window, and
// counters' cost.usage increments are multiplied by it. Claude Code's report is a fixed rate
// times tokens, so the ratio carries each request's 272K context tier exactly, and duplicate
// log deliveries cancel. No usable factor (no logs, an unpriced request, zero report) yields 0,
// which the existing report_zero_with_tokens rule surfaces as unavailable, never a guess.

const prices = parseCodexPricing(process.env.CODEX_PRICING_JSON);

// Anthropic models normalize to claude-*; an empty model keeps its report unchanged.
export function isNonAnthropicModel(model) {
  const normalized = normalizeModelId(model);
  return normalized !== "" && !normalized.startsWith("claude-");
}
export const nonAnthropicSql = (normModelExpr) =>
  `(${normModelExpr} != '' AND NOT startsWith(${normModelExpr}, 'claude-'))`;

// Cost-counter value with the factor applied. Callers pass the session expression and an
// already-normalized model expression (queries.js normModel()).
export function nacCostSql(valueExpr, sessionExpr, normModelExpr) {
  return `if(${nonAnthropicSql(normModelExpr)},
    ${valueExpr} * transform(concat(${sessionExpr}, '|', ${normModelExpr}),
      {nacKeys:Array(String)}, {nacFactors:Array(Float64)}, toFloat64(0)),
    ${valueExpr})`;
}
export const NAC_PLACEHOLDER = "{nacKeys:Array(String)}";

const count = (value) => {
  const n = Number(value);
  return value !== "" && value !== null && value !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : null;
};

// Pure fold, exported for tests. rows: one per api_request log with raw model and counts.
export function foldFactors(rows, normalize = normalizeModelId, priceTable = prices) {
  const groups = new Map();
  for (const row of rows) {
    const model = String(row.model || "");
    if (!isNonAnthropicModel(model)) continue;
    const key = `${row.session}|${normalize(model)}`;
    const g = groups.get(key) || { estimate: 0, reported: 0, unpriced: false };
    const input = count(row.input_tokens), read = count(row.cache_read_tokens);
    const write = count(row.cache_creation_tokens), output = count(row.output_tokens);
    const reported = Number(row.cost_usd);
    // Claude input excludes cache; the Codex pricer takes the inclusive total and subsets.
    const total = input === null || read === null || write === null ? null : input + read + write;
    const limit = priceTable[codexModel(model)]?.short_context_limit;
    const priced = total === null || output === null ? null : priceCodexUsage({
      model, backend: resolveBackend(model, ""),
      context_tier: limit !== undefined && total > limit ? "long" : "short",
      input_tokens_total: total, cache_read_tokens: read, cache_write_tokens: write,
      output_tokens: output, reasoning_tokens: 0,
    }, priceTable).cost_usd;
    if (priced === null || priced === undefined || !Number.isFinite(reported) || reported < 0) g.unpriced = true;
    else { g.estimate += priced; g.reported += reported; }
    groups.set(key, g);
  }
  const keys = [], factors = [];
  for (const [key, g] of groups) {
    keys.push(key);
    factors.push(!g.unpriced && g.reported > 0 ? g.estimate / g.reported : 0);
  }
  return { keys, factors };
}

// Factors for the query window [from, to). Memoized briefly: one dashboard view issues several
// queries over the same window.
const cache = new Map();
const CACHE_MS = 60_000;
export async function nonAnthropicFactors(from, to, run = rawQuery) {
  const key = `${from.toISOString()}|${to.toISOString()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const rows = await run(
    `SELECT SessionId AS session, LogAttributes['model'] AS model,
        LogAttributes['input_tokens'] AS input_tokens, LogAttributes['output_tokens'] AS output_tokens,
        LogAttributes['cache_read_tokens'] AS cache_read_tokens,
        LogAttributes['cache_creation_tokens'] AS cache_creation_tokens,
        toFloat64OrNull(LogAttributes['cost_usd']) AS cost_usd
     FROM claude_code.otel_logs
     WHERE Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime}
       AND EventName IN ('api_request', 'claude_code.api_request')
       AND LogAttributes['model'] != ''
       AND NOT startsWith(replaceRegexpOne(replaceRegexpOne(LogAttributes['model'],
         '^(us|us-gov|eu|apac|jp|au|global)\\\\.', ''), '^anthropic\\\\.', ''), 'claude-')`,
    { from: toChDateTime(from), to: toChDateTime(to) });
  const value = foldFactors(rows);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return value;
}

// ClickHouse DateTime param text ('YYYY-MM-DD HH:MM:SS', UTC) → Date.
const parseCh = (text) => new Date(String(text).replace(" ", "T") + "Z");

// Adds the factor params when a query references them. The window spans every period the query
// prices: [prevFrom ?? from, to).
export async function withNacParams(sql, params, run = rawQuery) {
  if (!sql.includes(NAC_PLACEHOLDER)) return params;
  const from = parseCh(params.prevFrom ?? params.from), to = parseCh(params.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
    throw new Error("non-Anthropic cost factors need from/to params");
  const { keys, factors } = await nonAnthropicFactors(from, to, run);
  // The client omits empty array params; a key no session|model can equal keeps them bound.
  return keys.length ? { ...params, nacKeys: keys, nacFactors: factors }
    : { ...params, nacKeys: ["|"], nacFactors: [0] };
}

// Tests insert logs between queries over the same window.
export function clearNonAnthropicFactorCache() {
  cache.clear();
}
