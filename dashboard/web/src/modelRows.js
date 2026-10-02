// Model lists omit models with a known zero token total and no positive cost; they carry no
// usage to compare. Unknown token totals (null) stay visible: unavailable is not zero.
const TOKEN_KEYS = ["observed_tokens", "tokens", "input_tokens", "output_tokens"];
const COST_KEYS = ["cost", "cost_usd", "reported_cost", "computed_cost"];

function amount(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function isZeroTokenModel(row) {
  const tokens = TOKEN_KEYS.map((key) => amount(row?.[key])).filter((n) => n !== null);
  if (tokens.length === 0 || tokens.some((n) => n > 0)) return false;
  return !COST_KEYS.some((key) => (amount(row?.[key]) ?? 0) > 0);
}

export const withoutZeroTokenModels = (rows) => (rows || []).filter((row) => !isZeroTokenModel(row));
