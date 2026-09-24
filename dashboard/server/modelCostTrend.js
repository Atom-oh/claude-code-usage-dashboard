// Rows arrive pre-aggregated per (day, group, model) from costByModelDailySql, which classifies
// every session scope in ClickHouse (usable, report_missing, report_zero_with_tokens), so
// per-session rows never leave the database. This fold maps one row to one output row.
// A row with no observed scope is no data, never a known $0. The output keeps the legacy keys
// (reported_cost, computed cost, token sums, unpriced) and avoids reported_unpriced, which web
// spend.js already interprets.
import { ValidationError } from "./http.js";
import { withComputedCost } from "./pricing.js";
import { createObservedTokens, addObservedTokens, finishObservedTokens } from "./observedTokens.js";

export const MODEL_COST_ROW_LIMIT = 50000;

const amount = (v) => ["number", "string"].includes(typeof v) && String(v).trim() !== ""
  && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const round = (n) => Number.isFinite(n * 1e12) ? Math.round(n * 1e12) / 1e12 : null;
const TOKEN_KEYS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"];

function mapCell(row) {
  const usable = amount(row.usable_scopes) ?? 0;
  const missing = amount(row.report_missing) ?? 0;
  const zero = amount(row.report_zero_with_tokens) ?? 0;
  if (usable + missing + zero === 0) return null;
  const known = amount(row.known_report);
  const reported_cost = usable > 0 && known !== null ? round(known) : null;
  const tokens = Object.fromEntries(TOKEN_KEYS.map((k) => [k, amount(row[k])]));
  const observed = createObservedTokens();
  if ((amount(row.observed_token_scopes) ?? 0) > 0) addObservedTokens(observed, row.observed_token_sum);
  if ((amount(row.unobserved_token_scopes) ?? 0) > 0) addObservedTokens(observed, null);
  // The model is constant within a row, so pricing the summed tokens equals the per-session sum.
  const [priced] = withComputedCost([{ model: row.model, ...tokens }]);
  const tokensKnown = TOKEN_KEYS.every((k) => tokens[k] !== null);
  return {
    day: row.day, group: row.group, model: row.model,
    reported_cost,
    reported_partial: missing + zero > 0 || (usable > 0 && reported_cost === null),
    reported_unavailable: missing + zero,
    reported_reasons: { report_missing: missing, report_zero_with_tokens: zero },
    reported_all_unavailable: usable === 0,
    ...tokens,
    ...finishObservedTokens(observed),
    cost: priced.unpriced || !tokensKnown ? null : round(priced.cost),
    unpriced: priced.unpriced,
  };
}

export function foldModelCostCells(rows) {
  if (rows.length > MODEL_COST_ROW_LIMIT)
    throw new ValidationError("too much model cost data", "narrow the requested date range or use a wider bucket");
  const out = [];
  for (const row of rows) {
    const cell = mapCell(row);
    if (cell) out.push(cell);
  }
  return out.sort((a, b) =>
    String(a.day).localeCompare(String(b.day))
    || String(a.group).localeCompare(String(b.group))
    || String(a.model).localeCompare(String(b.model)));
}
