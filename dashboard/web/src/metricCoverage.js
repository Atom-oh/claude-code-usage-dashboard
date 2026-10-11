// Numeric counter totals alone do not prove that a metric was observed.
// Keep aggregate absence visible if any returned channel lacks evidence.
export function sumObservedMetric(rows, key) {
  if (!rows?.length || rows.some((row) =>
    !(row[`${key}_observed`] === true || row[`${key}_observed`] === 1)
    || !["number", "string"].includes(typeof row[key]) || String(row[key]).trim() === ""
    || !Number.isFinite(Number(row[key])) || Number(row[key]) < 0)) return null;
  const total = rows.reduce((sum, row) => sum + Number(row[key]), 0);
  return Number.isFinite(total) ? total : null;
}
