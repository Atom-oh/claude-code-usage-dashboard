import { GROUP_ORDER } from "./colors.js";

// [{t, group, value}] → [{t, bedrock: v, enterprise: v}] — Recharts wants one row per x-tick.
export function pivotByGroup(rows, xKey, valueKey) {
  const byX = new Map();
  for (const r of rows || []) {
    if (!byX.has(r[xKey])) byX.set(r[xKey], { [xKey]: r[xKey] });
    byX.get(r[xKey])[r.group] = Number(r[valueKey]);
  }
  return [...byX.values()].sort((a, b) => new Date(a[xKey]) - new Date(b[xKey]));
}

export function groupsPresent(rows) {
  const seen = new Set((rows || []).map((r) => r.group));
  return GROUP_ORDER.filter((g) => seen.has(g));
}
