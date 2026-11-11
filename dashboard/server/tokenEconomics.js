import { normalizeModelId } from "./pricing.js";

export const TERMS = ["users", "sessions_per_user", "turns_per_session", "requests_per_turn", "tokens_per_request", "cost_per_token"];
export const BUNDLES = {
  growth: ["users", "sessions_per_user"],
  waste: ["turns_per_session", "requests_per_turn", "tokens_per_request"],
  price: ["cost_per_token"],
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Zero denominators yield 0, never NaN/Infinity; lmdi reports the zero as zero_factor.
const ratio = (a, b) => (b > 0 ? a / b : 0);

export function chain(totals = {}) {
  const t = {
    users: num(totals.users), sessions: num(totals.sessions), turns: num(totals.turns),
    requests: num(totals.requests), tokens: num(totals.tokens), cost: num(totals.cost),
  };
  const unavailable = t.sessions === 0 ? "no_matched_sessions" : t.users === 0 ? "no_users" : null;
  if (unavailable) return { ...t, factors: null, cost_per_million_tokens: null, unavailable };
  return {
    ...t,
    factors: {
      users: t.users,
      sessions_per_user: ratio(t.sessions, t.users),
      turns_per_session: ratio(t.turns, t.sessions),
      requests_per_turn: ratio(t.requests, t.turns),
      tokens_per_request: ratio(t.tokens, t.requests),
      cost_per_token: ratio(t.cost, t.tokens),
    },
    cost_per_million_tokens: t.tokens > 0 ? (t.cost / t.tokens) * 1e6 : null,
    unavailable: null,
  };
}

export function lmdi(previous, current) {
  if (!previous || !current || previous.unavailable || current.unavailable || !previous.factors || !current.factors) {
    return { contributions: null, bundles: null, total_change: null, unavailable: "no_previous" };
  }
  const c0 = previous.cost, c1 = current.cost;
  const positive = (v) => Number.isFinite(v) && v > 0;
  if (!positive(c0) || !positive(c1) || TERMS.some((k) => !positive(previous.factors[k]) || !positive(current.factors[k]))) {
    return { contributions: null, bundles: null, total_change: num(c1) - num(c0), unavailable: "zero_factor" };
  }
  // log1p keeps the denominator nonzero for near-equal costs; fall back to the L = C1 limit if still degenerate.
  const logRatio = Math.log1p((c1 - c0) / c0);
  let L = c1 === c0 || logRatio === 0 ? c1 : (c1 - c0) / logRatio;
  if (!Number.isFinite(L)) L = c1;
  const contributions = {};
  for (const k of TERMS) contributions[k] = L * Math.log(current.factors[k] / previous.factors[k]);
  const bundles = {};
  for (const [name, keys] of Object.entries(BUNDLES)) bundles[name] = keys.reduce((s, k) => s + contributions[k], 0);
  return { contributions, bundles, total_change: c1 - c0, unavailable: null };
}

// ---- Matched-session facts (Task 4) ----
export const SMALL_MODEL_FAMILIES = ["haiku", "luna"];
export function isSmallModel(model) {
  const id = normalizeModelId(model).toLowerCase();
  return SMALL_MODEL_FAMILIES.some((f) => id.includes(f));
}

const EXCLUSIONS = ["no_turns", "no_requests", "cost_incomplete", "tokens_invalid"];
const nn = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const sumKnown = (rows, key) => rows.reduce((s, r) => s + (nn(r[key]) ?? 0), 0);
const div = (a, b) => (b > 0 ? a / b : null);

// bucket "" is the window: every usage row plus window-level turn rows; otherwise that bucket only.
export function matchSessions(usage = [], turns = [], { bucket = "" } = {}) {
  const key = (r) => `${r.client}\u0000${r.session}`;
  const sessions = new Map();
  const get = (r) => {
    const k = key(r);
    if (!sessions.has(k)) sessions.set(k, { client: r.client, session: r.session, usage: [], turns: [] });
    return sessions.get(k);
  };
  for (const r of usage) if (bucket === "" || r.bucket === bucket) get(r).usage.push(r);
  for (const r of turns) if ((r.bucket ?? "") === bucket) get(r).turns.push(r);

  return [...sessions.values()].map((s) => {
    const codex = s.client === "codex";
    const turnN = sumKnown(s.turns.filter((r) => r.kind === "turn"), "n");
    const reqRows = s.turns.filter((r) => r.kind === "request");
    const user = s.turns.find((r) => r.user)?.user || s.usage.find((r) => r.user)?.user || "";
    const requests = codex ? sumKnown(s.usage, "requests") : sumKnown(reqRows, "n");

    const models = new Map();
    const model = (m) => {
      const id = normalizeModelId(m);
      if (!models.has(id)) models.set(id, { model: id, cost: 0, tokens: 0, requests: 0 });
      return models.get(id);
    };
    for (const r of s.usage) {
      const m = model(r.model);
      m.cost += nn(r.cost_usd) ?? 0;
      m.tokens += nn(r.tokens) ?? 0;
      if (codex) m.requests += nn(r.requests) ?? 0;
    }
    if (!codex) for (const r of reqRows) model(r.model).requests += nn(r.n) ?? 0;
    const modelList = [...models.values()];
    const small = modelList.filter((m) => isSmallModel(m.model)).reduce((a, m) => a + m.requests, 0);

    let exclusion = null;
    if (turnN === 0) exclusion = "no_turns";
    else if (requests === 0) exclusion = "no_requests";
    else if (!s.usage.length || s.usage.some((r) => nn(r.cost_usd) === null)) exclusion = "cost_incomplete";
    else if (s.usage.some((r) => nn(r.tokens) === null)) exclusion = "tokens_invalid";

    const bases = [...new Set(s.usage.map((r) => r.cost_basis).filter(Boolean))];
    return {
      client: s.client, session: s.session, user, turns: turnN, requests, small_requests: small,
      tokens: sumKnown(s.usage, "tokens"), cache_read: sumKnown(s.usage, "cache_read"),
      cache_den: sumKnown(s.usage, "cache_den"), cost: sumKnown(s.usage, "cost_usd"),
      cost_basis: bases.length > 1 ? "mixed" : bases[0] || "",
      models: modelList, matched: exclusion === null, exclusion,
    };
  });
}

const matchedTotals = (matched) => ({
  users: new Set(matched.map((f) => f.user).filter(Boolean)).size,
  sessions: matched.length,
  turns: matched.reduce((s, f) => s + f.turns, 0),
  requests: matched.reduce((s, f) => s + f.requests, 0),
  tokens: matched.reduce((s, f) => s + f.tokens, 0),
  cost: matched.reduce((s, f) => s + f.cost, 0),
});

export function summarize(facts = []) {
  const matched = facts.filter((f) => f.matched);
  const excluded = Object.fromEntries(EXCLUSIONS.map((r) => [r, 0]));
  for (const f of facts) if (f.exclusion) excluded[f.exclusion] += 1;
  return {
    totals: matchedTotals(matched),
    coverage: {
      sessions: facts.length, matched_sessions: matched.length, excluded,
      cost_known: facts.reduce((s, f) => s + f.cost, 0),
      cost_matched: matched.reduce((s, f) => s + f.cost, 0),
    },
  };
}

export function unitTrend(usage, turns, buckets = []) {
  return buckets.map((t) => {
    const matched = matchSessions(usage, turns, { bucket: t }).filter((f) => f.matched);
    const c = chain(matchedTotals(matched));
    const ok = !c.unavailable;
    const cacheRead = matched.reduce((s, f) => s + f.cache_read, 0);
    const cacheDen = matched.reduce((s, f) => s + f.cache_den, 0);
    return {
      t,
      cost_per_user: ok ? div(c.cost, c.users) : null,
      cost_per_session: ok ? div(c.cost, c.sessions) : null,
      cost_per_1k_requests: ok ? div(c.cost, c.requests / 1000) : null,
      tokens_per_request: ok ? div(c.tokens, c.requests) : null,
      cache_hit_rate: ok ? div(cacheRead, cacheDen) : null,
    };
  });
}

export function modelEconomics(facts = []) {
  const models = new Map();
  for (const f of facts) {
    if (!f.matched) continue;
    for (const m of f.models) {
      const acc = models.get(m.model) || { model: m.model, cost: 0, requests: 0, tokens: 0 };
      acc.cost += m.cost; acc.requests += m.requests; acc.tokens += m.tokens;
      models.set(m.model, acc);
    }
  }
  const rows = [...models.values()];
  const totalRequests = rows.reduce((s, m) => s + m.requests, 0);
  return rows
    .map((m) => ({
      ...m,
      request_share: div(m.requests, totalRequests),
      cost_per_million_tokens: m.tokens > 0 ? (m.cost / m.tokens) * 1e6 : null,
      small: isSmallModel(m.model),
    }))
    .sort((a, b) => b.cost - a.cost || (a.model < b.model ? -1 : 1));
}

export function outcomeCost(facts = [], outcomes = null, cost = 0) {
  // Missing outcome data is unavailable (null), not zero; an empty array is a real zero count.
  if (!Array.isArray(outcomes)) {
    return { commits: null, prs: null, loc_added: null, cost_per_commit: null, cost_per_pr: null, cost_per_kloc: null };
  }
  const ids = new Set(facts.filter((f) => f.matched).map((f) => f.session));
  let commits = 0, prs = 0, loc = 0;
  for (const o of outcomes) {
    if (!ids.has(o.session)) continue;
    commits += nn(o.commits) ?? 0; prs += nn(o.prs) ?? 0; loc += nn(o.loc_added) ?? 0;
  }
  return {
    commits, prs, loc_added: loc,
    cost_per_commit: div(cost, commits), cost_per_pr: div(cost, prs), cost_per_kloc: div(cost, loc / 1000),
  };
}

const LEVERS = [
  { lever: "tokens_per_request", direction: "lower", num: (a) => a.tokens, den: (a) => a.requests },
  { lever: "requests_per_turn", direction: "lower", num: (a) => a.requests, den: (a) => a.turns },
  { lever: "cache_hit_rate", direction: "higher", num: (a) => a.cache_read, den: (a) => a.cache_den },
  { lever: "small_model_share", direction: "higher", num: (a) => a.small_requests, den: (a) => a.requests },
];

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function exemplars(facts = [], outcomes = null, { minSessions = 5, minTurns = 20, top = 3 } = {}) {
  const commitsBySession = new Map();
  if (Array.isArray(outcomes)) for (const o of outcomes) commitsBySession.set(o.session, (commitsBySession.get(o.session) || 0) + (nn(o.commits) ?? 0));
  const users = new Map();
  for (const f of facts) {
    if (!f.matched || !f.user) continue;
    const a = users.get(f.user) || { user: f.user, sessions: 0, turns: 0, requests: 0, tokens: 0, cache_read: 0, cache_den: 0, small_requests: 0, commits: 0 };
    a.sessions += 1; a.turns += f.turns; a.requests += f.requests; a.tokens += f.tokens;
    a.cache_read += f.cache_read; a.cache_den += f.cache_den; a.small_requests += f.small_requests;
    a.commits += commitsBySession.get(f.session) || 0;
    users.set(f.user, a);
  }
  const eligible = [...users.values()].filter((u) => u.sessions >= minSessions && u.turns >= minTurns);
  const levers = LEVERS.map(({ lever, direction, num, den }) => {
    const scored = eligible
      .filter((u) => den(u) > 0)
      .map((u) => ({ user: u.user, value: num(u) / den(u), sessions: u.sessions, turns: u.turns, commits: Array.isArray(outcomes) ? u.commits : null }));
    scored.sort((a, b) => (direction === "lower" ? a.value - b.value : b.value - a.value) || (a.user < b.user ? -1 : a.user > b.user ? 1 : 0));
    return { lever, direction, median: median(scored.map((s) => s.value)), top: scored.slice(0, top) };
  });
  return { eligible_users: eligible.length, levers };
}
