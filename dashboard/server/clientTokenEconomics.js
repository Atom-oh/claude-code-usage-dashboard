import { query, toChDateTime } from "./clickhouse.js";
import { ValidationError } from "./http.js";
import { validateClientFilters, effectiveClientEnd, clientBucketSeconds, buildCodexQuery, priceClaudeUsage } from "./clientMetrics.js";
import { clientQueryBatch } from "./clientQueryBatch.js";
import { priceCodexUsage } from "./codexPricing.js";
import { codexPrices } from "./priceCatalog.js";
import { costSourceForRange } from "./codexCostSource.js";
import { isRejectedRequestGroup } from "./codexRequests.js";
import { normalizeModelId } from "./pricing.js";
import * as queries from "./queries.js";
import { turnsReadFrom, turnsReadiness, turnsSql } from "./tokenEconomicsSource.js";
import {
  TERMS, BUNDLES, chain, lmdi, matchSessions, summarize, unitTrend, modelEconomics, outcomeCost, exemplars,
} from "./tokenEconomics.js";

// GET /api/clients/token-economics (docs/api-reference.md#get-apiclientstoken-economics,
// formulas in docs/metrics.md#token-economics). Per enabled client: the six-term cost chain over
// the matched population of the current and the preceding equal-length window, its LMDI
// decomposition, coverage, unit trend, model economics, outcome cost and exemplar users.
const HOUR = 3600;
const ROW_LIMIT = 50000;
const DEFAULT_BASIS = { claude: "client_reported", codex: "aws_list_estimate" };

export const defaultDeps = {
  query, clientClaudeRows: queries.clientClaudeRows, now: () => new Date(), readFrom: turnsReadFrom,
};

const floorHour = (d) => new Date(Math.floor(d.getTime() / (HOUR * 1000)) * HOUR * 1000);
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// The response window: hour-aligned (the turns table's grain) inside the overview's effective
// end. Buckets are whole hours, at least one, so usage and turn buckets share one grid.
export function tokenEconomicsWindow(from, to, clients, intervalHours) {
  const start = floorHour(from);
  const end = floorHour(effectiveClientEnd(start, to, clients));
  const length = Math.max(0, end - start);
  const requested = length > 0 ? clientBucketSeconds(start, end, intervalHours) : HOUR;
  const bucketSeconds = Math.max(HOUR, Math.ceil(requested / HOUR) * HOUR);
  return { from: start, to: end, length, bucketSeconds,
    previous: { from: new Date(start - length), to: start } };
}

const gridBucket = (t, from, bucketSeconds) => {
  const ms = Date.parse(String(t).replace(/(?:\.\d+)?Z?$/, "Z"));
  const size = bucketSeconds * 1000, start = from.getTime();
  return iso(start + Math.max(0, Math.floor((ms - start) / size)) * size);
};
const num = (v) => (v === null || v === undefined || String(v).trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function claudeUsageRows(rows, from, bucketSeconds) {
  const active = rows.filter((r) => Number(r.timeline_only) !== 1);
  if (active.length > ROW_LIMIT) throw new ValidationError("too much client data", "narrow the requested date range");
  return active.map((row) => {
    const priced = priceClaudeUsage(row);
    // A row whose cost was observed without token samples has no canonical tokens (ADR-014).
    const valid = priced.tokens !== null && Number(row.token_observed ?? 1) !== 0;
    const read = num(row.cache_read_tokens);
    return { client: "claude", session: row.session || "", user: row.user || "",
      bucket: gridBucket(row.t, from, bucketSeconds), model: row.model || "", backend: row.backend || "unknown",
      tokens: valid ? priced.tokens : null, cache_read: valid ? read : null,
      cache_den: valid ? num(row.input_tokens) + read + num(row.cache_write_tokens) : null,
      cost_usd: priced.cost_usd, cost_basis: priced.cost_basis, requests: null };
  });
}

// Codex usage rows are deduplicated usage-bearing response.completed records (buildCodexQuery);
// their count is the request term. Other kinds only mark missing usage the way the overview
// fold does: a non-rejected scope without any usage row makes its session's cost incomplete.
function codexUsageRows(rows, from, bucketSeconds, prices) {
  if (rows.length > ROW_LIMIT) throw new ValidationError("too much client data", "narrow the requested date range");
  const scope = (r, model = r.model || "") => JSON.stringify(model === null
    ? [r.session, r.user || "", r.project || ""] : [r.session, r.user || "", r.project || "", r.backend || "unknown", model]);
  const usageScopes = new Set(), usageSessions = new Set(), requiring = new Set(), requiringSessions = new Set();
  for (const r of rows) {
    if (!r.session) continue;
    if (!isRejectedRequestGroup(r)) { requiring.add(scope(r)); requiringSessions.add(scope(r, null)); }
    if (r.kind === "usage") { usageScopes.add(scope(r)); usageSessions.add(scope(r, null)); }
  }
  const out = [];
  for (const r of rows) {
    const base = { client: "codex", session: r.session || "", user: r.user || "", bucket: gridBucket(r.t, from, bucketSeconds),
      model: r.model || "", backend: r.backend || "unknown" };
    // Sessionless usage stays as known cost outside the matched population (windowData).
    if (r.kind === "usage") {
      const priced = priceCodexUsage(r, prices);
      const valid = priced.tokens !== null;
      out.push({ ...base, tokens: priced.tokens, cache_read: valid ? num(r.cache_read_tokens) : null,
        cache_den: valid ? num(r.input_tokens_total) : null, cost_usd: priced.cost_usd,
        cost_basis: priced.cost_basis, requests: num(r.count) ?? 0 });
      continue;
    }
    if (!r.session) continue;
    const missing = (!isRejectedRequestGroup(r) || requiring.has(scope(r)) || (!r.model && requiringSessions.has(scope(r, null))))
      && !usageScopes.has(scope(r)) && !(!r.model && usageSessions.has(scope(r, null)));
    if (missing) out.push({ ...base, tokens: null, cache_read: null, cache_den: null, cost_usd: null,
      cost_basis: "aws_list_estimate", requests: 0 });
  }
  return out;
}

const turnRow = (r) => ({ client: r.client, session: r.session, user: r.user || "", bucket: r.bucket || "",
  kind: r.kind, model: r.model || "", n: num(r.n) ?? 0 });

// Model/backend filters select whole sessions: a session stays when at least one of its usage rows
// matches (normalized model substring/exact for Claude as claudeProductivityScope; raw model for
// Codex as buildCodexQuery). Team/user filters are applied by the sources.
function sessionScope(client, filters) {
  const claude = client === "claude";
  const term = claude ? normalizeModelId(filters.model || "") : filters.model || "";
  const exact = claude ? normalizeModelId(filters.modelExact || "") : filters.modelExact || "";
  return (r) => (!term || String(r.model).toLowerCase().includes(term.toLowerCase()))
    && (!exact || r.model === exact) && (!filters.backend || r.backend === filters.backend);
}

// Claude user filters use the turns' log identity (user.email, else enduser.id), as
// /api/clients/productivity does: counters often lack UserEmail on Bedrock (ADR-002), so
// Claude usage is read without the user filter and kept for sessions whose turns matched.
const userMatch = (filters) => (user) => (!filters.user || String(user).toLowerCase().includes(filters.user.toLowerCase()))
  && (!filters.userExact || user === filters.userExact);

function windowData(client, usage, turns, filters) {
  const scoped = Boolean(filters.model || filters.modelExact || filters.backend);
  const inScope = sessionScope(client, filters);
  const claudeUser = client === "claude" && Boolean(filters.user || filters.userExact);
  // Sessionless usage cannot meet the turn source; its known cost (rows in the model/backend
  // scope, and for a Claude user filter rows whose counter identity matches) still counts as
  // outside the matched population.
  const unattributed = usage.filter((r) => !r.session && (!scoped || inScope(r)) && (!claudeUser || userMatch(filters)(r.user)))
    .reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  let turnRows = turns.filter((r) => r.client === client);
  let rows = usage.filter((r) => r.session);
  if (claudeUser) {
    const sessions = new Set(turnRows.map((r) => r.session));
    rows = rows.filter((r) => sessions.has(r.session));
  }
  if (scoped) {
    const keep = new Set(rows.filter(inScope).map((r) => r.session));
    rows = rows.filter((r) => keep.has(r.session));
  }
  // Turns are not team/model/backend filtered at the source: other teams' sessions must not enter coverage.
  if (scoped || filters.team) {
    const sessions = new Set(rows.map((r) => r.session));
    turnRows = turnRows.filter((r) => sessions.has(r.session));
  }
  const facts = matchSessions(rows, turnRows);
  const { totals, coverage } = summarize(facts);
  return { usage: rows, turns: turnRows, facts, totals,
    coverage: { ...coverage, cost_known: coverage.cost_known + unattributed, cost_unattributed: unattributed } };
}

const emptyDecomposition = (reason) => ({ contributions: null, bundles: null, total_change: null, unavailable: reason });

function unavailableClient(client, reason) {
  return { client, cost_basis: DEFAULT_BASIS[client], current: null, previous: null,
    decomposition: emptyDecomposition(reason),
    unavailable: { chain: reason, decomposition: reason, outcome: client === "codex" ? "not_collected" : reason },
    coverage: null, previous_coverage: null, trend: null, models: null,
    outcome: null, previous_outcome: null, exemplars: null };
}

function basis(client, facts) {
  const bases = [...new Set(facts.filter((f) => f.matched).map((f) => f.cost_basis).filter(Boolean))];
  return bases.length === 1 ? bases[0] : bases.length > 1 ? "mixed" : DEFAULT_BASIS[client];
}

// Trend buckets are matched independently; group rows once instead of rescanning per bucket.
function trend(usage, turns, buckets) {
  const by = (rows, pick) => rows.reduce((m, r) => {
    const k = pick(r);
    if (k) (m.get(k) || m.set(k, []).get(k)).push(r);
    return m;
  }, new Map());
  const u = by(usage, (r) => r.bucket), t = by(turns, (r) => r.bucket);
  return buckets.flatMap((b) => unitTrend(u.get(b) || [], t.get(b) || [], [b]));
}

// `prev` is null when the previous window is gated (`previousGate`): the current sections stay,
// the decomposition carries the gate. A missing current chain is the decomposition's own reason.
function clientResult(client, cur, prev, outcomes, buckets, previousGate = null) {
  const c = chain(cur.totals), p = prev ? chain(prev.totals) : null;
  const current = c.unavailable ? null : c, previous = p && !p.unavailable ? p : null;
  const decomposition = c.unavailable ? emptyDecomposition(c.unavailable)
    : prev ? lmdi(p, c) : emptyDecomposition(previousGate);
  const claude = client === "claude";
  const outcome = claude && current ? outcomeCost(cur.facts, outcomes.current, current.cost) : null;
  const previousOutcome = claude && previous ? outcomeCost(prev.facts, outcomes.previous, previous.cost) : null;
  return { client, cost_basis: basis(client, cur.facts), current, previous, decomposition,
    unavailable: { chain: c.unavailable, decomposition: decomposition.unavailable,
      outcome: claude ? c.unavailable : "not_collected" },
    coverage: cur.coverage, previous_coverage: prev ? prev.coverage : null,
    trend: trend(cur.usage, cur.turns, buckets), models: modelEconomics(cur.facts),
    outcome, previous_outcome: previousOutcome,
    exemplars: exemplars(cur.facts, claude ? outcomes.current : null) };
}

// Combined: no cross-client chain (identities differ). Cost sums per-client matched costs; the
// decomposition sums per-term contributions and is unavailable if any client's is.
// `unavailable_clients` names each blocking client and its reason (empty when combined).
function combine(byClient) {
  const sum = (pick) => (byClient.every((c) => pick(c) !== null) ? byClient.reduce((s, c) => s + pick(c), 0) : null);
  const cost = sum((c) => c.current?.cost ?? null), previousCost = sum((c) => c.previous?.cost ?? null);
  const blocked = byClient.filter((c) => c.decomposition.unavailable)
    .map((c) => ({ client: c.client, reason: c.decomposition.unavailable }));
  if (blocked.length) {
    return { cost, previous_cost: previousCost, unavailable_clients: blocked,
      decomposition: { ...emptyDecomposition(blocked[0].reason),
        total_change: cost !== null && previousCost !== null ? cost - previousCost : null } };
  }
  const contributions = Object.fromEntries(TERMS.map((t) => [t, byClient.reduce((s, c) => s + c.decomposition.contributions[t], 0)]));
  const bundles = Object.fromEntries(Object.entries(BUNDLES).map(([name, keys]) => [name, keys.reduce((s, k) => s + contributions[k], 0)]));
  return { cost, previous_cost: previousCost, unavailable_clients: [], decomposition: { contributions, bundles,
    total_change: byClient.reduce((s, c) => s + c.decomposition.total_change, 0), unavailable: null } };
}

export async function clientTokenEconomics(from, to, raw, enabledClients, signal, deps = defaultDeps) {
  signal?.throwIfAborted();
  const { query: run, clientClaudeRows, now, readFrom } = { ...defaultDeps, ...deps };
  const filters = validateClientFilters(raw, enabledClients);
  const clients = filters.clients;
  const w = tokenEconomicsWindow(from, to, clients, raw.intervalHours);
  const head = {
    effective_range: { from: w.from.toISOString(), to: w.to.toISOString() },
    previous_range: { from: w.previous.from.toISOString(), to: w.previous.to.toISOString() },
    bucket_hours: w.bucketSeconds / HOUR,
  };
  // Gate each window before any query. A short window, or a current window the turns table cannot
  // answer, makes every section unavailable. A gated previous window is not queried; only the
  // decomposition (and previous values) are unavailable.
  const at = now();
  const gate = w.length < HOUR * 1000 ? "window_too_short" : turnsReadiness(w.from, at, readFrom);
  if (gate) {
    const byClient = clients.map((client) => unavailableClient(client, gate));
    return { ...head, by_client: byClient, combined: combine(byClient) };
  }
  const previousGate = turnsReadiness(w.previous.from, at, readFrom);

  const windows = { current: { from: w.from, to: w.to }, ...(previousGate ? {} : { previous: w.previous }) };
  // Sources ignore model/backend; sessions are selected afterwards (sessionScope).
  const sourceFilters = { ...filters, model: "", modelExact: undefined, backend: "" };
  // Claude counters are read without the user filter; windowData applies it via turn identity.
  const claudeFilters = { ...sourceFilters, user: "", userExact: undefined };
  const prices = codexPrices();
  const jobs = [], slots = [];
  const add = (slot, job) => { slots.push(slot); jobs.push(job); };
  for (const [name, win] of Object.entries(windows)) {
    const params = { from: toChDateTime(win.from), to: toChDateTime(win.to), clients,
      clientUser: filters.user || "", clientUserExact: filters.userExact || "",
      // The previous window needs only window rows; one bucket per session keeps the grouping set small.
      bucketSeconds: name === "current" ? w.bucketSeconds : w.length / 1000 };
    add([name, "turns"], (s) => run(turnsSql(), params, s));
    for (const client of clients) {
      if (client === "claude") {
        add([name, "claude"], (s) => clientClaudeRows(win.from, win.to, claudeFilters, HOUR, s, prices));
        const outcome = queries.claudeOutcomeBySessionSql(win.from, win.to);
        add([name, "outcomes"], (s) => run(outcome.sql, outcome.params, s));
      } else {
        // The previous window needs only window totals; coarse buckets keep its rows few.
        const { sql, params: codexParams } = buildCodexQuery(win.from, win.to, sourceFilters, prices, "codex",
          name === "current" ? HOUR : w.length / 1000,
          { costView: true, costSource: costSourceForRange(win.from) });
        add([name, "codex"], (s) => run(sql, codexParams, s));
      }
    }
  }
  const results = await clientQueryBatch(jobs, signal);
  const got = { current: {}, previous: {} };
  slots.forEach(([name, part], i) => {
    if (!Array.isArray(results[i])) throw new Error(`token economics ${name} ${part}: query returned no row list`);
    got[name][part] = results[i];
  });

  const buckets = [];
  for (let t = w.from.getTime(); t < w.to.getTime(); t += w.bucketSeconds * 1000) buckets.push(iso(t));
  const byClient = clients.map((client) => {
    const data = (name) => {
      const win = windows[name], size = name === "current" ? w.bucketSeconds : w.length / 1000;
      const usage = client === "claude" ? claudeUsageRows(got[name].claude, win.from, size)
        : codexUsageRows(got[name].codex, win.from, size, prices);
      return windowData(client, usage, got[name].turns.map(turnRow), filters);
    };
    const outcomes = { current: got.current.outcomes ?? null, previous: got.previous.outcomes ?? null };
    return clientResult(client, data("current"), previousGate ? null : data("previous"), outcomes, buckets, previousGate);
  });
  return { ...head, by_client: byClient, combined: combine(byClient) };
}
