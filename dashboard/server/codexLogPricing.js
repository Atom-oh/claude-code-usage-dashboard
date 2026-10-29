import { VALID_BACKENDS } from "./backend.js";
import { CODEX_ROUTING_PATTERN } from "./codexPricing.js";
import { resolvedRatesTable, NO_REGIONAL_PREMIUM, REGIONAL_MODEL_PATTERN } from "./pricing.js";

// Rates repeat across models, tiers and backends. Share their bound parameters
// so the catalog stays within the query request URL budget.
function ratesSql(params, rates) {
  return ["input", "cacheRead", "cacheWrite", "output"].map((field) => {
    const value = rates[field];
    const name = `rate${String(value).replace(/\W/g, "_")}`;
    params[name] = value;
    return `{${name}:Float64}`;
  });
}

const literalStrings = (values) => `[${values.map((value) => `'${value}'`).join(",")}]`;

/**
 * Select an ordered rate tuple before doing token arithmetic. Repeating the
 * arithmetic in each model branch also repeats expanded token/parser aliases
 * in ClickHouse's expression planning.
 *
 * Tuple: source (1 Codex, 2 Claude), model, backend (empty = generic),
 * scope (1 regional, 2 global), context limit, tier (1 short, 2 long), rates.
 * arrayFirst's default tuple has source 0: an unmatched rate stays unavailable.
 */
export function codexLogPricingSql(prices, params, claudeRates = resolvedRatesTable()) {
  const rows = [];
  const codexModels = [];
  Object.entries(prices).forEach(([model, entry], index) => {
    params[`aggregateModel${index}`] = model;
    // Context limits repeat across models: share one parameter per value, like the rates.
    const threshold = `aggregateThreshold${entry.short_context_limit}`;
    params[threshold] = entry.short_context_limit;
    const modelSql = `{aggregateModel${index}:String}`;
    codexModels.push(modelSql);
    // Specific backend rates precede generic rates, exactly as in the old
    // multiIf catalog. Missing specific scope/tier rates may use generic ones.
    for (const backend of [...VALID_BACKENDS, null]) {
      const source = backend ? entry.backends?.[backend] : entry;
      if (!source) continue;
      for (const [scopeIndex, scope] of ["regional", "global"].entries()) {
        for (const [tierIndex, tier] of ["short", "long"].entries()) {
          const rates = source[scope]?.[tier];
          if (!rates) continue;
          rows.push(`tuple(toUInt8(1),${modelSql},'${backend || ""}',
            toUInt8(${scopeIndex + 1}),{${threshold}:UInt64},
            toUInt8(${tierIndex + 1}),${ratesSql(params, rates).join(",")})`);
        }
      }
    }
  });
  Object.entries(claudeRates).forEach(([model, entry], index) => {
    params[`claudeModel${index}`] = model;
    for (const backend of VALID_BACKENDS) {
      rows.push(`tuple(toUInt8(2),{claudeModel${index}:String},'${backend}',
        toUInt8(0),toUInt64(0),toUInt8(0),${ratesSql(params, entry.backends[backend]).join(",")})`);
    }
  });
  const notCodexEntry = codexModels.length ? `NOT has([${codexModels.join(",")}],base_model)` : "1";
  const selection = rows.length ? `arrayFirst(rate -> ifNull(
    (rate.3 = '' OR rate.3 = backend) AND (
      (rate.1 = 1 AND rate.2 = base_model
        AND rate.4 = if(startsWith(model,'global.'),2,1)
        AND if(rate.6 = 1,input_value <= rate.5,input_value > rate.5))
      OR (rate.1 = 2 AND rate.2 = claude_model AND ${notCodexEntry})
    ),0),[${rows.join(",")}])` : `tuple(toUInt8(0),'','',toUInt8(0),toUInt64(0),
      toUInt8(0),toFloat64(0),toFloat64(0),toFloat64(0),toFloat64(0))`;
  // Claude fallback rates are global. Codex catalog rates already include
  // regional adjustments, so only source 2 receives the Claude premium.
  const regional = `if(price_row.1 = 2
    AND match(model,'${REGIONAL_MODEL_PATTERN.replace(/\\/g, "\\\\")}')
    AND NOT has(${literalStrings(NO_REGIONAL_PREMIUM)},claude_model),1.1,1)`;
  const amount = `if(has_usage AND usage_valid
    AND backend IN ('bedrock-mantle','bedrock-runtime')
    AND NOT startsWith(model,'us-gov.')
    AND NOT (backend = 'bedrock-mantle' AND match(model,'${CODEX_ROUTING_PATTERN.replace(/\\/g, "\\\\")}'))
    AND price_row.1 != 0,
    ${regional} * ((input_value - read_value - write_value) * price_row.7
      + read_value * price_row.8 + write_value * price_row.9
      + output_value * price_row.10) / 1000000,NULL)`;
  return { selection, amount };
}
