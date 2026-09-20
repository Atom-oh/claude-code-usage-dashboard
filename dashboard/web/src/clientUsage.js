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

// An explicit unknown observation must never fall back to canonical usage.
export function observedTokens(row = {}) {
  const n = observed(Object.hasOwn(row, "observed_tokens") ? row.observed_tokens : row.tokens);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// Display known subtotals; canonical usage stays separate for ratio derivation.
export function clientTimeline(rows, { bucketHours, effectiveRange } = {}) {
  const buckets = new Map();
  for (const row of rows) {
    const t = row.t.replace("T", " ").replace(/(?:\.\d+)?Z$/, "");
    const bucket = buckets.get(t) || { t };
    for (const [field, suffix] of [["tokens", "tokens"], ["cost_usd", "cost"]]) {
      const key = `${row.client}_${suffix}`;
      const n = field === "tokens" ? observedTokens(row) : observed(row[field]);
      const value = n !== null && n >= 0 ? n : null;
      bucket[key] = value === null ? bucket[key] ?? null : (bucket[key] ?? 0) + value;
    }
    buckets.set(t, bucket);
  }
  const ordered = [...buckets.values()].sort((a, b) => a.t.localeCompare(b.t));
  const bucketMs = bucketHours * 3600000;
  if (!Number.isInteger(bucketMs) || bucketMs < 1000) return ordered;
  const from = Date.parse(effectiveRange?.from), to = Date.parse(effectiveRange?.to);
  if (Number.isFinite(from) && Number.isFinite(to) && from < to
      && Math.ceil((to - from) / bucketMs) <= 5000 && ordered.length) {
    const clients = [...new Set(rows.map(row => row.client))].sort();
    const grid = new Map(buckets);
    // Zero here is the sum of recorded usage in an empty bucket, not a claim
    // that collection was complete. Explicit unavailable values remain null.
    for (let time = from; time < to; time = (Math.floor(time / bucketMs) + 1) * bucketMs) {
      const t = new Date(time).toISOString().slice(0, 19).replace("T", " ");
      if (!grid.has(t)) grid.set(t, { t });
    }
    return [...grid.values()].sort((a, b) => a.t.localeCompare(b.t)).map(row => {
      const empty_clients = clients.filter(client => !Object.hasOwn(row, `${client}_tokens`));
      return { ...Object.fromEntries(clients.flatMap(client =>
        [[`${client}_tokens`, 0], [`${client}_cost`, 0]])), ...row, empty_clients };
    });
  }
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
