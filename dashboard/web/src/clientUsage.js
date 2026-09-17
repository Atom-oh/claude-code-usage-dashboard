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
export function clientTimeline(rows) {
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
  return [...buckets.values()].sort((a, b) => a.t.localeCompare(b.t));
}
