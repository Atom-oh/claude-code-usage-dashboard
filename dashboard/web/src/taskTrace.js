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
