import { knownReportedCost } from "./reportedCost.js";

// Overview session turns (docs/metrics.md#session-turns). A turn is one deduplicated
// user_prompt event. A session's cost is the ADR-013 known reported subtotal of its counter
// rows; sessions without counters or usable reports stay unavailable, never zero. Ratios use
// sessions with both a known cost and at least one observed turn; the rest are counted.
export const SESSION_TURNS_TOP = 20;

const ratio = (numerator, denominator) =>
  denominator > 0 && Number.isFinite(numerator) ? numerator / denominator : null;

// Median averages the middle pair; p90 uses the nearest rank.
function quantiles(values) {
  if (!values.length) return { median: null, p90: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    p90: sorted[Math.ceil(0.9 * sorted.length) - 1],
  };
}

// Totals over a set of sessions; partial also marks excluded unavailable sessions.
function totals(sessions) {
  let turns = 0, known = 0, knownSessions = 0, eligibleCost = 0, eligibleTurns = 0;
  let unavailable = 0, partial = false;
  for (const s of sessions) {
    turns += s.turns;
    if (s.known_cost === null) { unavailable += 1; continue; }
    known += s.known_cost;
    knownSessions += 1;
    partial ||= s.cost_partial;
    if (s.turns > 0) { eligibleCost += s.known_cost; eligibleTurns += s.turns; }
  }
  const knownCost = knownSessions ? known : null;
  return {
    turns, unavailable, known_cost: knownCost,
    cost_partial: knownCost !== null && (partial || unavailable > 0),
    cost_per_turn: ratio(eligibleCost, eligibleTurns),
    cost_per_session: knownCost === null ? null : ratio(known, knownSessions),
  };
}

const byKnownCost = (key) => (a, b) =>
  (a.known_cost === null) - (b.known_cost === null)
  || (b.known_cost ?? 0) - (a.known_cost ?? 0)
  || b.turns - a.turns
  || String(a[key]).localeCompare(String(b[key]));

export function foldSessionTurns(counterRows, logRows, { limit = SESSION_TURNS_TOP } = {}) {
  const sessions = new Map();
  const entry = (row) => {
    const id = String(row.session);
    let s = sessions.get(id);
    if (!s) {
      s = { session: id, user: "", group: "", started: null, turns: 0, model_calls: 0, rows: [] };
      sessions.set(id, s);
    }
    if (!s.user && row.user) s.user = String(row.user);
    if (!s.group && row.group) s.group = String(row.group);
    return s;
  };
  for (const row of counterRows || []) entry(row).rows.push(row);
  for (const row of logRows || []) {
    const s = entry(row);
    s.turns += Number(row.turns) || 0;
    s.model_calls += Number(row.model_calls) || 0;
    if (row.started && (!s.started || row.started < s.started)) s.started = String(row.started);
  }

  const list = [...sessions.values()].map(({ rows, ...s }) => {
    const cost = rows.length ? knownReportedCost(rows, { requireObservedZero: true })
      : { known_reported_cost: null, reported_partial: false };
    const known = cost.known_reported_cost;
    return { ...s, known_cost: known, cost_partial: cost.reported_partial,
      cost_per_turn: known !== null && s.turns > 0 ? known / s.turns : null };
  });

  const withTurns = list.filter((s) => s.turns > 0);
  const all = totals(list);
  const { median, p90 } = quantiles(withTurns.map((s) => s.turns));
  const callTurns = withTurns.reduce((n, s) => n + s.turns, 0);
  const summary = {
    sessions: list.length,
    sessions_with_turns: withTurns.length,
    turns: all.turns,
    median_turns_per_session: median,
    p90_turns_per_session: p90,
    known_cost: all.known_cost,
    cost_partial: all.cost_partial,
    cost_per_turn: all.cost_per_turn,
    model_calls_per_turn: ratio(withTurns.reduce((n, s) => n + s.model_calls, 0), callTurns),
    sessions_without_turns: list.length - withTurns.length,
    sessions_cost_unavailable: all.unavailable,
  };

  const byUser = new Map();
  for (const s of list) {
    if (!byUser.has(s.user)) byUser.set(s.user, []);
    byUser.get(s.user).push(s);
  }
  const users = [...byUser.entries()].map(([user, rows]) => {
    const t = totals(rows);
    return { user, sessions: rows.length, turns: t.turns, known_cost: t.known_cost,
      cost_partial: t.cost_partial, cost_per_turn: t.cost_per_turn, cost_per_session: t.cost_per_session };
  });

  return {
    summary,
    users: users.sort(byKnownCost("user")).slice(0, limit),
    sessions: list.sort(byKnownCost("session")).slice(0, limit),
  };
}
