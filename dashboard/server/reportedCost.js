// Report coverage is independent of diagnostic model prices. Dimension queries require
// in-window evidence for zero; legacy per-user/model rows retain their zero contract.
export function knownReportedCost(rows, { requireObservedZero = false } = {}) {
  let total = 0;
  let known = false;
  let unknown = false;
  for (const row of rows) {
    const raw = row.reported_cost;
    const report = typeof raw === "number" || (typeof raw === "string" && raw.trim())
      ? Number(raw) : NaN;
    const hasTokens = ["tokens", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]
      .some((key) => Number(row[key]) > 0);
    const hasCounter = Number(row.cost_counter_rows) > 0;
    if (row.reported_unpriced !== true && Number.isFinite(report) && report >= 0
      && (report > 0 || (!hasTokens && (!requireObservedZero || hasCounter)))) {
      known = true;
      total += report;
    } else if (!requireObservedZero || hasCounter || hasTokens) {
      unknown = true;
    }
  }
  const cost = known && Number.isFinite(total) ? total : null;
  return { known_reported_cost: cost, reported_partial: cost !== null && unknown };
}
