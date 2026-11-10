// Pure helpers for the task trace overlay (TaskTraceOverlay.jsx) over the
// /api/users/tasks/detail payload. Unknown values stay null; nothing here fills a zero.
import { observedNumber } from "./clientPresentation.js";

const AGENT_ICONS = new Set(["main", "general-purpose", "Explore", "fork", "custom"]);
const TOOL_ICONS = new Set(["Bash", "Read", "Edit", "Write", "Grep", "Glob", "WebFetch", "WebSearch"]);
const TOOL_ALIASES = { MultiEdit: "Edit", NotebookEdit: "Edit" };

// Icon key for an agent kind (kind = "agent": unknown -> custom) or a tool/span name
// (unknown -> tool). MCP tools (mcp__<server>__<tool>) share one icon.
export function iconFor(name, kind = "tool") {
  if (typeof name !== "string" || name === "") return kind === "agent" ? "custom" : "tool";
  if (AGENT_ICONS.has(name)) return name;
  if (name === "wait") return "wait";
  if (name.startsWith("mcp__")) return "mcp";
  if (TOOL_ICONS.has(name)) return name;
  if (TOOL_ALIASES[name]) return TOOL_ALIASES[name];
  return kind === "agent" ? "custom" : "tool";
}

// Display name for a lane. A lane whose spawning span is missing (custom, label null) is a
// generic subagent, never a guessed custom agent name.
export function laneName(lane) {
  if (lane.kind === "main" || lane.id === "main") return "메인 세션";
  return lane.label || "서브에이전트";
}

const startOf = (s) => observedNumber(s.start_ms);
const endOf = (s) => {
  const start = startOf(s);
  if (start === null) return null;
  return start + (observedNumber(s.duration_ms) ?? 0);
};

// Main first, then lanes by their first span start; lanes without a placed span keep their
// payload order after those.
export function laneOrder(lanes, spans = []) {
  const first = new Map();
  for (const s of spans) {
    const t = startOf(s);
    if (t === null) continue;
    if (!first.has(s.lane) || t < first.get(s.lane)) first.set(s.lane, t);
  }
  const index = new Map(lanes.map((l, i) => [l.id, i]));
  const rank = (l) => (l.id === "main" ? -Infinity : first.has(l.id) ? first.get(l.id) : Infinity);
  return [...lanes].sort((a, b) => rank(a) - rank(b) || index.get(a.id) - index.get(b.id));
}

// End of the drawn time axis: the task duration or the last span end, whichever is later.
export function timelineEnd(spans, durationMs = null) {
  let end = observedNumber(durationMs) ?? 0;
  for (const s of spans) {
    const e = endOf(s);
    if (e !== null && e > end) end = e;
  }
  return end;
}

// Stacked cumulative cost per lane at `buckets + 1` evenly spaced times over [0, end]. A call
// counts once it has finished (start + duration). Only llm spans carrying a `cost_usd` key are
// priced calls (a Codex sampling span without a linked completion has none). A lane becomes
// null from the first unknown-cost call on, and for the whole axis if an unknown or known
// call cannot be placed in time; `total` is null whenever any lane is null.
export function cumulativeByLane(spans, lanes, buckets = 120, durationMs = null) {
  const end = timelineEnd(spans, durationMs);
  const calls = new Map(lanes.map((l) => [l.id, []]));
  const unplaced = new Set();
  for (const s of spans) {
    if (s.kind !== "llm" || !Object.prototype.hasOwnProperty.call(s, "cost_usd")) continue;
    if (!calls.has(s.lane)) calls.set(s.lane, []);
    const at = endOf(s);
    if (at === null) { unplaced.add(s.lane); continue; }
    calls.get(s.lane).push({ at, cost: s.cost_usd === null ? null : observedNumber(s.cost_usd) });
  }
  for (const list of calls.values()) list.sort((a, b) => a.at - b.at);
  const points = [];
  const n = Math.max(1, buckets);
  for (let i = 0; i <= n; i++) {
    const t = i === n ? end : (end * i) / n;
    const byLane = {};
    let total = 0;
    for (const [id, list] of calls) {
      let sum = unplaced.has(id) ? null : 0;
      for (const c of list) {
        if (sum === null || c.at > t) break;
        sum = c.cost === null ? null : sum + c.cost;
      }
      byLane[id] = sum;
      total = total === null || sum === null ? null : total + sum;
    }
    points.push({ t_ms: t, total, by_lane: byLane });
  }
  return points;
}

// Input context of one call: uncached input plus both cache subsets (ADR-014 disjoint parts).
export function contextOf(tokens) {
  const parts = ["input", "cache_read", "cache_write"].map((k) => observedNumber(tokens?.[k]));
  return parts.some((v) => v === null) ? null : parts.reduce((a, b) => a + b, 0);
}

export function compactCount(value) {
  const n = observedNumber(value);
  if (n === null) return null;
  const trim = (v) => String(Number(v.toFixed(1)));
  if (n >= 1e9) return `${trim(n / 1e9)}B`;
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  if (n >= 1e3) return `${trim(n / 1e3)}K`;
  return String(Math.round(n));
}

const labelOf = (v) => (typeof v === "string" && v !== "" ? v : null);

// Model of an llm span as the side panel shows it (span attr, else the linked Codex
// completion's model) and its allowlisted call source. Unknown stays null.
export function modelOf(span) {
  return { model: labelOf(span?.attrs?.model) ?? labelOf(span?.completion?.model),
    source: labelOf(span?.attrs?.query_source_safe) };
}

// Stable group key of an llm span for modelBreakdown and timeline highlighting.
export function modelKey(span) {
  const { model, source } = modelOf(span);
  return JSON.stringify([model, source]);
}

// LLM calls grouped by (model, call source), most calls first. `cost_usd` sums known call
// costs (null when none is known) and `cost_partial` flags any call without a known cost
// (a Codex sampling span without a linked completion has no `cost_usd` key). Tokens are the
// sum of calls whose four canonical components are all known, flagged partial otherwise.
export function modelBreakdown(spans = []) {
  const groups = new Map();
  for (const s of spans) {
    if (s?.kind !== "llm") continue;
    const key = modelKey(s);
    let g = groups.get(key);
    if (!g) {
      g = { key, ...modelOf(s), calls: 0, lanes: [], cost_usd: null, cost_partial: false,
        observed_tokens: null, tokens_partial: false };
      groups.set(key, g);
    }
    g.calls++;
    if (!g.lanes.includes(s.lane)) g.lanes.push(s.lane);
    const cost = Object.prototype.hasOwnProperty.call(s, "cost_usd") ? observedNumber(s.cost_usd) : null;
    if (cost === null) g.cost_partial = true;
    else g.cost_usd = (g.cost_usd ?? 0) + cost;
    const parts = ["input", "cache_read", "cache_write", "output"].map((k) => observedNumber(s.tokens?.[k]));
    if (parts.some((v) => v === null)) g.tokens_partial = true;
    else g.observed_tokens = (g.observed_tokens ?? 0) + parts.reduce((a, b) => a + b, 0);
  }
  // Unknown labels sort after known ones on ties.
  const byLabel = (x, y) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x.localeCompare(y));
  return [...groups.values()].sort((a, b) => b.calls - a.calls
    || byLabel(a.model, b.model) || byLabel(a.source, b.source));
}

// Summary of the detail's `context` (per-call input context, Claude compactions, Codex
// limits). Unknown inputs stay null: no peak without a known point, no share without a limit.
export function contextSummary(context) {
  const points = (context?.points || []).filter((p) => observedNumber(p.tokens) !== null);
  let peak = null;
  for (const p of points) if (!peak || p.tokens > peak.tokens) peak = p;
  const main = points.filter((p) => p.lane === "main" && observedNumber(p.start_ms) !== null)
    .sort((a, b) => a.start_ms - b.start_ms);
  const compactions = context?.compactions ?? null;
  let biggest = null;
  for (const c of compactions || []) {
    const pre = observedNumber(c.pre_tokens), post = observedNumber(c.post_tokens);
    if (pre === null || post === null) continue;
    if (!biggest || pre - post > biggest.pre_tokens - biggest.post_tokens) biggest = { ...c, pre_tokens: pre, post_tokens: post };
  }
  const limit = observedNumber(context?.limits?.auto_compact_token_limit);
  const window = observedNumber(context?.limits?.context_window);
  const share = (v) => (peak && v ? peak.tokens / v : null);
  return {
    points: points.length, missing: observedNumber(context?.missing) ?? 0, partial: Boolean(context?.partial),
    peak, mainFirst: main[0]?.tokens ?? null, mainLast: main.length > 1 ? main.at(-1).tokens : null,
    compactions: compactions === null ? null : compactions.length, biggestCompaction: biggest,
    autoCompactLimit: limit, contextWindow: window, limitShare: share(limit), windowShare: share(window),
  };
}
