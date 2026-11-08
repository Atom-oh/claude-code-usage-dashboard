// Pure helpers for the unified per-user detail (Claude Code + Codex).
// Unknown values stay null and are never rendered as zero.

function num(value) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Sum known values; all-unknown stays null. `partial` is true when any part is
// flagged partial, or when unknown and known parts are mixed.
function sumKnown(values, flags = []) {
  const known = values.filter(v => v !== null);
  return {
    total: known.length ? known.reduce((a, b) => a + b, 0) : null,
    partial: flags.some(Boolean) || (known.length > 0 && known.length < values.length),
  };
}

// One row per identity across the selected clients. Rows with an empty user are
// never merged across clients because they do not identify the same person.
export function combineUsers(userRows, clients) {
  const selected = new Set(clients || []);
  const groups = new Map();
  for (const row of userRows || []) {
    if (!selected.has(row.client)) continue;
    const user = row.user || "";
    const key = user ? `u:${user}` : `c:${row.client}`;
    if (!groups.has(key)) groups.set(key, { user, parts: [] });
    groups.get(key).parts.push(row);
  }
  return [...groups.values()].map(({ user, parts }) => {
    const cost = sumKnown(parts.map(p => num(p.cost_usd)), parts.map(p => p.cost_partial));
    const tokens = sumKnown(parts.map(p => num(p.observed_tokens)), parts.map(p => p.tokens_partial));
    return {
      user,
      clients: [...new Set(parts.map(p => p.client))].sort(),
      // Session IDs are client-scoped and disjoint, so per-client counts add.
      sessions: sumKnown(parts.map(p => num(p.sessions))).total,
      observed_tokens: tokens.total,
      tokens_partial: tokens.partial,
      cost_usd: cost.total,
      cost_partial: cost.partial,
      parts,
    };
  });
}

// Timezone-less API timestamps are UTC.
function utcDay(t) {
  if (typeof t !== "string") return null;
  let s = t.trim().replace(" ", "T");
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += "Z";
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

// Sessions per UTC day, with the per-client split. A client whose values are all
// unknown for a day stays null; the day total is null only if every client is.
export function heatmapDays(timeseries, clients) {
  const selected = new Set(clients || []);
  const days = new Map();
  for (const row of timeseries || []) {
    if (!selected.has(row.client)) continue;
    const day = utcDay(row.t);
    if (!day) continue;
    const byClient = days.get(day) || {};
    const n = num(row.sessions);
    byClient[row.client] = n === null ? byClient[row.client] ?? null : (byClient[row.client] ?? 0) + n;
    days.set(day, byClient);
  }
  return [...days.keys()].sort().map(day => ({
    day,
    sessions: sumKnown(Object.values(days.get(day))).total,
    by_client: days.get(day),
  }));
}

export function claudeOnlyFields(clients) {
  const list = clients || [];
  return { show: list.includes("claude"), codexUnavailable: list.includes("codex") };
}
