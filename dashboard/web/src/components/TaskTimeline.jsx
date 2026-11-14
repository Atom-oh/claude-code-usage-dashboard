import { translate, useLocale } from "../i18n/index.js";
// Lane timeline of one task (mockup v3 option B): one row per agent lane with its icon, name
// and "N 호출 · $X", LLM bars shaded by input context, tool bars and permission-wait marks
// under the lane, dashed connectors from a spawning tool span to its subagent lane.
import { useState } from "react";
import { formatClientCost, formatObserved } from "../clientUsage.js";
import { observedNumber } from "../clientPresentation.js";
import { contextOf, iconFor, laneColor, laneName } from "../taskTrace.js";
import { formatTaskDuration } from "./TaskList.jsx";
import { TaskIconMark } from "./taskIcons.jsx";

export const X0 = 200, PLOT_W = 680, VIEW_W = 900;
const LANE_H = 64, TOP = 8, BAR_H = 22, MARK_H = 7, TICKS = 4;
const TOOL_FILL = "var(--ink-400)", WAIT_FILL = "var(--negative)";
// SVG bars get no reliable native focus outline, so the focused bar draws its own ring.
const FOCUS_STROKE = "var(--brand-600)", SELECTED_STROKE = "var(--ink-800)";
// Opacity factor for LLM bars outside an active highlight.
const DIM = 0.15;

export function laneStats(lane, truncated) {
  if (truncated) return translate("m8eb8ad978705");
  const calls = observedNumber(lane.llm_calls);
  const cost = observedNumber(lane.cost_usd);
  const callText = calls === null ? translate("mc555ba3f6bc2") : translate("mfeff7cd98688", [formatObserved(calls)]);
  const costText = cost === null ? translate("mc554f0409705") : `${formatClientCost(cost)}${lane.cost_partial ? translate("m830e860c2bd2") : ""}`;
  return `${callText} · ${costText}`;
}

export function spanLabel(span, laneLabel, number) {
  if (span.kind === "llm") return translate("m0b3849d9b065", [number, laneLabel]);
  if (span.kind === "wait") return translate("md56d85bb5889", [laneLabel]);
  return translate("m76c170c8e9e5", [span.attrs?.tool_name || span.name || translate("m36c416ead2ce"), laneLabel]);
}

export function TimeAxis({ end, y }) {
  const _locale = useLocale();
  return <g aria-hidden="true">
    {Array.from({ length: TICKS + 1 }, (_, i) => <text key={i} x={X0 + (i * PLOT_W) / TICKS} y={y} textAnchor="middle"
      style={{ fill: "var(--chart-axis)", fontSize: 11 }}>{formatTaskDuration((end * i) / TICKS)}</text>)}
  </g>;
}

// `highlight` (optional): a predicate over llm spans; when set, non-matching LLM bars are
// dimmed (data-dimmed). Tool and wait marks are unaffected. Omitted = nothing dimmed.
export function TaskTimeline({ lanes, spans, numbers, end, truncated, selectedId, onSelect, highlight = null }) {
  const _locale = useLocale();
  const x = (ms) => X0 + (end > 0 ? (ms / end) * PLOT_W : 0);
  const width = (ms) => Math.max(2, end > 0 ? ((observedNumber(ms) ?? 0) / end) * PLOT_W : 2);
  const row = new Map(lanes.map((l, i) => [l.id, TOP + i * LANE_H]));
  const names = new Map(lanes.map((l) => [l.id, laneName(l)]));
  const placed = spans.filter((s) => observedNumber(s.start_ms) !== null && row.has(s.lane));
  const contexts = placed.filter((s) => s.kind === "llm").map((s) => contextOf(s.tokens)).filter((v) => v !== null);
  const maxContext = Math.max(1, ...contexts);
  const byId = new Map(spans.map((s) => [s.id, s]));
  const height = TOP + lanes.length * LANE_H + 18;
  const [focusedId, setFocusedId] = useState(null);

  const bar = (s) => {
    const y = row.get(s.lane), color = laneColor(lanes.find((l) => l.id === s.lane));
    const ctx = s.kind === "llm" ? contextOf(s.tokens) : null;
    const common = {
      role: "button", tabIndex: 0, "aria-label": spanLabel(s, names.get(s.lane), numbers.get(s.id)),
      "aria-pressed": selectedId === s.id, "data-focused": focusedId === s.id ? "" : undefined,
      className: "cursor-pointer outline-none",
      onFocus: () => setFocusedId(s.id), onBlur: () => setFocusedId((f) => (f === s.id ? null : f)),
      onClick: () => onSelect(s.id),
      onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(s.id); } },
      style: focusedId === s.id ? { stroke: FOCUS_STROKE, strokeWidth: 2.5 }
        : { stroke: selectedId === s.id ? SELECTED_STROKE : "none", strokeWidth: 1.5 },
    };
    if (s.kind === "llm") {
      const dimmed = typeof highlight === "function" && !highlight(s);
      const opacity = (ctx === null ? 0.45 : 0.3 + 0.7 * (ctx / maxContext)) * (dimmed ? DIM : 1);
      return <rect key={s.id} {...common} data-dimmed={dimmed ? "" : undefined} x={x(s.start_ms)} y={y + 2}
        width={width(s.duration_ms)} height={BAR_H} rx={2} style={{ ...common.style, fill: color, opacity }} />;
    }
    return <rect key={s.id} {...common} x={x(s.start_ms)} y={y + BAR_H + 6} width={s.kind === "wait" ? Math.max(MARK_H, width(s.duration_ms))
      : width(s.duration_ms)} height={MARK_H} style={{ ...common.style, fill: s.kind === "wait" ? WAIT_FILL : TOOL_FILL }} />;
  };

  return <svg viewBox={`0 0 ${VIEW_W} ${height}`} width="100%" className="block" aria-label={translate("m5d7f51f4e267")}>
    {lanes.map((l) => {
      const y = row.get(l.id), color = laneColor(l);
      return <g key={l.id} role="group" aria-label={translate("m6cc3cfaaaeb1", [names.get(l.id)])}>
        <TaskIconMark icon={iconFor(l.kind, "agent")} x={8} y={y + 4} size={20} color={color} />
        <text x={36} y={y + 14} style={{ fill: "var(--text-primary)", fontSize: 12, fontWeight: 600 }}>{names.get(l.id)}</text>
        <text x={36} y={y + 30} style={{ fill: "var(--text-secondary)", fontSize: 11 }}>{laneStats(l, truncated)}</text>
        <rect x={X0} y={y + 2} width={PLOT_W} height={BAR_H} rx={3} style={{ fill: "var(--surface-sunken)" }} />
      </g>;
    })}
    {lanes.map((l) => {
      const spawn = l.spawned_by ? byId.get(l.spawned_by) : null;
      if (!spawn || observedNumber(spawn.start_ms) === null || !row.has(spawn.lane)) return null;
      const sx = x(spawn.start_ms);
      return <line key={`spawn-${l.id}`} data-spawn="" x1={sx} y1={row.get(spawn.lane) + BAR_H + 6} x2={sx} y2={row.get(l.id) + 2}
        style={{ stroke: laneColor(l), strokeDasharray: "3 3" }} aria-hidden="true" />;
    })}
    {placed.map(bar)}
    <TimeAxis end={end} y={height - 4} />
  </svg>;
}
