// Price Claude request logs independently of the primary counter-based spend.
import { isNonAnthropicModel, priceRequestUsage } from "./nonAnthropicCost.js";
import { DEFAULT_CODEX_PRICING } from "./codexPricing.js";
import { claudeCostParts, normalizeModelId } from "./pricing.js";

const attr = key => `if(match(a['${key}'], '^[0-9]{1,16}$')
  AND toUInt64OrZero(a['${key}']) <= 9007199254740991, toUInt64OrNull(a['${key}']), NULL)`;

// Split at every catalog context boundary before summing. The JS pricer can then
// select the model's actual boundary using any inclusive input in the group.
export function claudeRequestCostSql(prices, params) {
  params.componentLimits = [...new Set([DEFAULT_CODEX_PRICING["anthropic.claude-haiku-5-5"].short_context_limit,
    ...Object.values(prices).map(entry => entry.short_context_limit)])];
  const fields = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens",
    "cache_creation_5m_tokens", "cache_creation_1h_tokens"];
  const names = ["cin", "cout", "cread", "cwrite", "c5", "c1"];
  return {
    typed: `${fields.map((field, i) => `${attr(field)} AS ${names[i]}`).join(", ")},
      (event_name = 'api_request') AS component_request,
      if(component_request, a['model'], '') AS component_model,
      if(component_request, r['user.email'], '') AS component_user,
      (component_request AND isNotNull(cin) AND isNotNull(cout) AND isNotNull(cread) AND isNotNull(cwrite)) AS component_valid,
      (ifNull(c5, 0) + ifNull(c1, 0) <= cwrite) AS split_valid,
      (ifNull(cin, 0) + ifNull(cread, 0) + ifNull(cwrite, 0)) AS component_input_total,
      if(component_valid AND (model = 'claude-haiku-5-5' OR NOT startsWith(model, 'claude-')),
        arrayCount(lim -> component_input_total > lim, {componentLimits:Array(UInt64)}), 0) AS component_band,`,
    group: ", component_request, component_model, component_user, component_valid, component_band",
    select: `component_request, component_model, component_user, component_valid,
      max(component_input_total) AS max_request_input,
      sum(toFloat64(cin)) AS component_input, sum(toFloat64(cout)) AS component_output,
      sum(toFloat64(cread)) AS component_read, sum(toFloat64(cwrite)) AS component_write,
      sumIf(toFloat64(c5), split_valid) AS component_5m, sumIf(toFloat64(c1), split_valid) AS component_1h,
      countIf(isNotNull(c5) AND split_valid) AS seen_5m,
      countIf(isNotNull(c1) AND split_valid) AS seen_1h,`,
  };
}

export function claudeRequestParts(row, prices) {
  if (!Number(row.component_valid)) return null;
  const model = row.component_model;
  const input = Number(row.component_input), output = Number(row.component_output);
  const read = Number(row.component_read), write = Number(row.component_write);
  if (![input, output, read, write, input + read + write].every(Number.isSafeInteger)) return null;
  if (isNonAnthropicModel(model)) {
    return priceRequestUsage({ model, input_tokens: input, output_tokens: output, cache_read_tokens: read,
      cache_creation_tokens: write }, prices, { maxRequestInput: Number(row.max_request_input), includeParts: true })?.cost_parts;
  }
  // Every Haiku 5.5 token rate has the same long/short ratio, including cache
  // writes (both TTLs are multiples of input). Apply it before combining bands.
  const haiku = DEFAULT_CODEX_PRICING["anthropic.claude-haiku-5-5"];
  const longHaiku = normalizeModelId(model) === "claude-haiku-5-5" && Number(row.max_request_input) > haiku.short_context_limit;
  return claudeCostParts(model, row.backend, { input, output, cacheRead: read, cacheWrite: write },
    Number(row.seen_5m) ? Number(row.component_5m) : null,
    Number(row.seen_1h) ? Number(row.component_1h) : null,
    longHaiku ? haiku.global.long.input / haiku.global.short.input : 1);
}

export function addCostParts(target, parts) {
  // Keep the previous known subtotal if a request would overflow the USD
  // precision used by the response. Never accept only part of one request.
  if (!parts || Object.entries(parts).some(([key, value]) =>
    value != null && !Number.isFinite(((target[key] ?? 0) + value) * 1e12))) {
    target.partial = true;
    return;
  }
  for (const [key, value] of Object.entries(parts)) {
    if (value != null) target[key] = (target[key] ?? 0) + value;
  }
}
