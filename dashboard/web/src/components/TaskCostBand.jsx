// Cumulative cost of one task stacked by lane colour, with a hover tooltip of every lane's
// cumulative cost at that time. Once any lane's cost becomes unknown the stack stops and the
// rest of the axis is drawn as "미수집" rather than a lower total.
import { useMemo, useState } from "react";
import { formatClientCost } from "../clientUsage.js";
import { cumulativeByLane, laneColor, laneName } from "../taskTrace.js";
import { formatTaskDuration } from "./TaskList.jsx";
import { TimeAxis, PLOT_W, VIEW_W, X0 } from "./TaskTimeline.jsx";
import { tooltipStyles, useChartColors } from "../useChartColors.js";

const BUCKETS = 120, LEGEND_TOP = 28, LEGEND_ROW = 18, AXIS_GAP = 20;
// Height grows with the lane count so every legend row (swatch, name, final cost) stays inside
// the viewBox; the plot fills the height above the time axis.
export const bandHeight = (laneCount) => Math.max(150, LEGEND_TOP + laneCount * LEGEND_ROW + AXIS_GAP);
const money = (v) => (v === null ? "미수집" : formatClientCost(v));

export function TaskCostBand({ lanes, spans, end, durationMs }) {
  const c = useChartColors();
  const points = useMemo(() => cumulativeByLane(spans, lanes, BUCKETS, durationMs), [spans, lanes, durationMs]);
  const [hover, setHover] = useState(null);
  const VIEW_H = bandHeight(lanes.length), BASE = VIEW_H - AXIS_GAP, H = BASE - 20;
  const known = points.findIndex((p) => p.total === null);
  const lastKnown = known === -1 ? points.length - 1 : known - 1;
  const max = Math.max(...points.slice(0, lastKnown + 1).map((p) => p.total), 0);
  const final = points.at(-1);
  const xAt = (i) => X0 + (i / BUCKETS) * PLOT_W;
  const y = (v) => BASE - (max > 0 ? (v / max) * H : 0);

  const areas = [];
  if (lastKnown >= 0) {
    const below = new Array(lastKnown + 1).fill(0);
    for (const l of lanes) {
      const top = below.map((b, i) => b + (points[i].by_lane[l.id] ?? 0));
      let d = "";
      for (let i = 0; i <= lastKnown; i++) d += `${i ? "L" : "M"}${xAt(i).toFixed(1)} ${y(top[i]).toFixed(1)}`;
      for (let i = lastKnown; i >= 0; i--) d += `L${xAt(i).toFixed(1)} ${y(below[i]).toFixed(1)}`;
      areas.push(<path key={l.id} d={`${d}Z`} style={{ fill: laneColor(l), opacity: 0.8, stroke: c.surface, strokeWidth: 0.5 }} />);
      top.forEach((v, i) => { below[i] = v; });
    }
  }

  const onMove = (e) => {
    const svg = e.currentTarget.closest("svg");
    const box = svg?.getBoundingClientRect();
    if (!box || !box.width) return;
    const vx = ((e.clientX - box.left) / box.width) * VIEW_W;
    const p = Math.max(0, Math.min(1, (vx - X0) / PLOT_W));
    setHover(Math.round(p * BUCKETS));
  };
  const point = hover === null ? null : points[hover];
  const title = `누적 비용 ${money(final.total)}`;

  return <div className="relative">
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" className="block" role="img" aria-label={`에이전트별 ${title}`}>
      <text x={8} y={16} style={{ fill: "var(--text-primary)", fontSize: 12, fontWeight: 600 }}>{title}</text>
      {lanes.map((l, i) => <g key={l.id} data-band-lane={i} aria-hidden="true">
        <rect data-band-legend="" x={8} y={LEGEND_TOP + i * LEGEND_ROW} width={10} height={10} rx={2}
          style={{ fill: laneColor(l) }} />
        <text x={24} y={LEGEND_TOP + 9 + i * LEGEND_ROW} style={{ fill: "var(--text-primary)", fontSize: 11 }}>{laneName(l)}</text>
        <text x={190} y={LEGEND_TOP + 9 + i * LEGEND_ROW} textAnchor="end" style={{ fill: "var(--text-secondary)", fontSize: 11 }}>
          {money(final.by_lane[l.id] ?? null)}</text>
      </g>)}
      {areas}
      {lastKnown < BUCKETS && <g aria-hidden="true">
        <rect x={xAt(Math.max(0, lastKnown))} y={BASE - H} width={X0 + PLOT_W - xAt(Math.max(0, lastKnown))} height={H}
          style={{ fill: "var(--ink-100)" }} />
        <text x={X0 + PLOT_W - 6} y={BASE - H + 14} textAnchor="end" style={{ fill: "var(--text-secondary)", fontSize: 11 }}>
          비용 미수집 구간</text>
      </g>}
      {point && <line x1={xAt(hover)} x2={xAt(hover)} y1={BASE - H} y2={BASE} style={{ stroke: "var(--ink-600)", strokeDasharray: "2 3" }} />}
      <rect data-band-hit="" x={X0} y={0} width={PLOT_W} height={BASE} style={{ fill: "transparent" }}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      <TimeAxis end={end} y={VIEW_H - 4} />
    </svg>
    {point && <div role="tooltip" className="pointer-events-none absolute top-6"
      style={{ ...tooltipStyles(c).contentStyle, color: c.tooltipFg, fontSize: 12,
        left: `${Math.min(70, (xAt(hover) / VIEW_W) * 100)}%` }}>
      <div style={{ fontSize: 11, marginBottom: 2 }}>{`+${formatTaskDuration(point.t_ms)} · 합계 ${money(point.total)}`}</div>
      {lanes.map((l) => <div key={l.id}>{`${laneName(l)} ${money(point.by_lane[l.id] ?? null)}`}</div>)}
    </div>}
  </div>;
}
