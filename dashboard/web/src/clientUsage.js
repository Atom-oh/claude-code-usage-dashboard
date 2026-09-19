function observed(value) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatObserved(value) {
  const n = observed(value);
  return n === null ? "—" : n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

export function formatClientCost(value) {
  const n = observed(value);
  if (n === null) return "—";
  return `$${n.toLocaleString("en-US", n > 0 && n < 1
    ? { maximumSignificantDigits: 8 }
    : { maximumFractionDigits: 2 })}`;
}

// Costs sum known values; token completeness still propagates within each bucket.
export function clientTimeline(rows, { bucketHours } = {}) {
  const buckets = new Map();
  for (const row of rows) {
    const t = row.t.replace("T", " ").replace(/(?:\.\d+)?Z$/, "");
    const bucket = buckets.get(t) || { t };
    for (const [field, suffix] of [["tokens", "tokens"], ["cost_usd", "cost"]]) {
      const key = `${row.client}_${suffix}`;
      const n = observed(row[field]);
      const value = n !== null && n >= 0 ? n : null;
      bucket[key] = field === "cost_usd"
        ? value === null ? bucket[key] ?? null : (bucket[key] ?? 0) + value
        : value === null || bucket[key] === null ? null : (bucket[key] ?? 0) + value;
    }
    buckets.set(t, bucket);
  }
  const ordered = [...buckets.values()].sort((a, b) => a.t.localeCompare(b.t));
  const bucketMs = bucketHours * 3600000;
  if (!Number.isInteger(bucketMs) || bucketMs < 1000) return ordered;
  // One empty marker breaks a missing run. A continuous time axis gives that
  // run its actual width; no synthetic zero values or dense expansion is needed.
  return ordered.flatMap((row, index) => {
    const next = ordered[index + 1];
    const boundary = (Math.floor(parseUtc(row.t).getTime() / bucketMs) + 1) * bucketMs;
    return next && Number.isFinite(boundary) && parseUtc(next.t).getTime() > boundary
      ? [row, { t: new Date(boundary).toISOString().slice(0, 19).replace("T", " ") }]
      : [row];
  });
}
import { parseUtc } from "./fmt.js";
