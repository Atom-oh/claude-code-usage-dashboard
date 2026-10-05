// Model lists omit models whose usage is a complete, known zero: every present token total is
// a known 0, nothing is partial or unpriced, and no cost is positive. Unknown or partial totals
// stay visible: unavailable is not zero, and missingness is the row's only disclosure.
const TOTAL_KEYS = ["tokens", "observed_tokens"];
const COMPONENT_KEYS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"];
const COST_KEYS = ["cost", "cost_usd", "reported_cost", "computed_cost"];

function amount(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function isZeroTokenModel(row) {
  if (!row || row.tokens_partial === true || row.cost_partial === true) return false;
  if (row.unpriced === true || row.reported_unpriced === true || (amount(row.unpriced) ?? 0) > 0) return false;
  const totals = TOTAL_KEYS.filter((key) => key in row);
  if (totals.length === 0 || totals.some((key) => amount(row[key]) !== 0)) return false;
  if (COMPONENT_KEYS.some((key) => (amount(row[key]) ?? 0) > 0)) return false;
  return !COST_KEYS.some((key) => (amount(row[key]) ?? 0) > 0);
}

export const withoutZeroTokenModels = (rows) => (rows || []).filter((row) => !isZeroTokenModel(row));
