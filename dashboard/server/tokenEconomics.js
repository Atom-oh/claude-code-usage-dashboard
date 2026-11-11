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
  const L = c1 === c0 ? c1 : (c1 - c0) / (Math.log(c1) - Math.log(c0));
  const contributions = {};
  for (const k of TERMS) contributions[k] = L * Math.log(current.factors[k] / previous.factors[k]);
  const bundles = {};
  for (const [name, keys] of Object.entries(BUNDLES)) bundles[name] = keys.reduce((s, k) => s + contributions[k], 0);
  return { contributions, bundles, total_change: c1 - c0, unavailable: null };
}
