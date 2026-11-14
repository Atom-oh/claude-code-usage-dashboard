import { translate, useLocale } from "../i18n/index.js";
// Context size of one task (/api/users/tasks/detail `context`): one line per lane of per-call
// input context (input + cache read + cache write; Codex: input incl. cache), Claude Code
// compaction marks (pre → post tokens) and, for Codex, the auto-compaction limit the
// conversation reported. Claude Code reports no context window, so no share of it is drawn.
// The time axis matches the lane timeline above it (same X0/PLOT_W/end).
import { useState } from "react";
import { formatObserved } from "../clientUsage.js";
import { observedNumber } from "../clientPresentation.js";
import { compactCount, contextLines, contextSummary, laneColor, laneName } from "../taskTrace.js";
import { formatTaskDuration } from "./TaskList.jsx";
import { TimeAxis, PLOT_W, VIEW_W, X0 } from "./TaskTimeline.jsx";

const VIEW_H = 210, TOP = 14, BASE = 184, LEGEND_ROW = 18;
const COMPACTION = "var(--warning)", LIMIT = "var(--warning-text)";
// A positive share below 1% reads "<1%", never 0%.
const pct = (v) => (v > 0 && v < 0.01 ? "<1%" : `${Math.round(v * 100)}%`);
const tokensText = (v) => compactCount(v) ?? translate("m08a739493081");

function niceMax(v) {
  if (!(v > 0)) return 1;
  const step = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / step) * step;
}

export function TaskContextChart({ context, lanes, end, numbers, client, selectedId, onSelect, sourceOf = () => null }) {
  const _locale = useLocale();
  const [focused, setFocused] = useState(null);
  const s = contextSummary(context);
  if (!s.points) return <p className="text-sm text-ink-500">{translate("m7df1673873b6")}</p>;
  const points = context.points.filter((p) => observedNumber(p.tokens) !== null && observedNumber(p.start_ms) !== null);
  // A compaction can land just outside the drawn spans (e.g. right after the last call
  // ends); it is clamped to the axis edge rather than dropped.
  const compactions = (context.compactions || []).filter((c) => observedNumber(c.start_ms) !== null);
  // The limit is drawn when it is within reach of the data; otherwise it is stated in text.
  const limitInChart = s.autoCompactLimit !== null && s.autoCompactLimit <= s.peak.tokens * 2.5;
  const yMax = niceMax(Math.max(s.peak.tokens, limitInChart ? s.autoCompactLimit : 0,
    ...compactions.map((c) => observedNumber(c.pre_tokens) ?? 0)) * 1.05);
  const x = (ms) => X0 + (end > 0 ? (Math.max(0, Math.min(ms, end)) / end) * PLOT_W : 0);
  const y = (v) => BASE - (v / yMax) * (BASE - TOP);
  const shown = lanes.filter((l) => points.some((p) => p.lane === l.id));
  const lines = contextLines(points, sourceOf);
  const sideSources = [...new Set([...lines.values()].flatMap((g) => g.sideSources))];
  const sideExample = sideSources.find((v) => v !== null) ?? translate("m283f54a8487c");
  const ticks = [0, 0.5, 1].map((f) => f * yMax);
  const label = (p) => {
    const lane = lanes.find((l) => l.id === p.lane);
    const n = p.span ? numbers.get(p.span) : null;
    return translate("m1bf11e2e47f8", [n ? translate("m187e5a1cadcd", [n]) : translate("m5570150cd696"), lane ? laneName(lane) : translate("m7d688dae8673"), tokensText(p.tokens)])
      + ` · +${formatTaskDuration(p.start_ms)}`;
  };
  const stats = [
    translate("m3528f9e48b06", [tokensText(s.peak.tokens), s.peak.span && numbers.get(s.peak.span) ? translate("m21b99a2fe9bf", [numbers.get(s.peak.span)]) : ""]),
    s.mainFirst !== null && s.mainLast !== null ? translate("m74c11bc77657", [tokensText(s.mainFirst), tokensText(s.mainLast)]) : null,
    client === "codex" ? null : s.compactions === null ? translate("m5269a015879b") : s.compactions === 0 ? translate("m038c7026e148")
      : translate("m235439579f37", [formatObserved(s.compactions), s.biggestCompaction ? ` (${s.biggestCompaction.trigger ?? translate("m8eccada106ef")} ${
        tokensText(s.biggestCompaction.pre_tokens)} → ${tokensText(s.biggestCompaction.post_tokens)})` : ""]),
    s.limitShare !== null ? translate("m95ef57e2dacc", [tokensText(s.autoCompactLimit), pct(s.limitShare)]) : null,
    s.windowShare !== null ? translate("m295d47a93ce2", [tokensText(s.contextWindow), pct(s.windowShare)]) : null,
  ].filter(Boolean);

  return <section aria-label={translate("m9600ced928a8")}>
    <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 className="text-[13px] font-semibold text-ink-800">{translate("m9600ced928a8")}</h3>
      <span className="text-[12px] text-ink-500">{client === "codex" ? translate("m666aa5edcbbf")
        : translate("mf883a64ab489")}</span>
    </div>
    <ul aria-label={translate("m86199426f3bc")} className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-700">
      {stats.map((t) => <li key={t} className="tabular-nums">{t}</li>)}
    </ul>
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" className="block" role="group"
      aria-label={translate("m66ad2daffb39", [tokensText(s.peak.tokens)])}>
      {shown.map((l, i) => <g key={l.id} aria-hidden="true">
        <rect x={8} y={TOP + i * LEGEND_ROW} width={10} height={3} rx={1} style={{ fill: laneColor(l) }} />
        <text x={24} y={TOP + 5 + i * LEGEND_ROW} style={{ fill: "var(--text-primary)", fontSize: 11 }}>{laneName(l)}</text>
      </g>)}
      {ticks.map((v) => <g key={v} aria-hidden="true">
        <line x1={X0} x2={X0 + PLOT_W} y1={y(v)} y2={y(v)} style={{ stroke: "var(--chart-grid)", strokeDasharray: "2 4" }} />
        <text x={X0 - 6} y={y(v) + 4} textAnchor="end" style={{ fill: "var(--chart-axis)", fontSize: 11 }}>{compactCount(v)}</text>
      </g>)}
      {limitInChart && <g data-context-limit="" aria-hidden="true">
        <line x1={X0} x2={X0 + PLOT_W} y1={y(s.autoCompactLimit)} y2={y(s.autoCompactLimit)}
          style={{ stroke: LIMIT, strokeWidth: 1.5, strokeDasharray: "6 4" }} />
        <text x={X0 + PLOT_W} y={y(s.autoCompactLimit) - 5} textAnchor="end" style={{ fill: LIMIT, fontSize: 11, fontWeight: 600 }}>
          {translate("ma319161131c0", [tokensText(s.autoCompactLimit)])}</text>
      </g>}
      {compactions.map((c, i) => <g key={`c${i}`} data-compaction="" aria-hidden="true">
        <line x1={x(c.start_ms)} x2={x(c.start_ms)} y1={TOP} y2={BASE} style={{ stroke: COMPACTION, strokeWidth: 1.5, strokeDasharray: "5 4" }} />
        <text x={x(c.start_ms) + 4} y={TOP + 10 + (i % 3) * 13} style={{ fill: "var(--warning-text)", fontSize: 11, fontWeight: 600 }}>
          {translate("m0d145e525a4a", [tokensText(c.pre_tokens), tokensText(c.post_tokens)])}</text>
      </g>)}
      {shown.map((l) => {
        const own = lines.get(l.id)?.line ?? [];
        return own.length > 1 && <polyline key={l.id} data-context-line={l.id} aria-hidden="true" fill="none"
          points={own.map((p) => `${x(p.start_ms).toFixed(1)},${y(p.tokens).toFixed(1)}`).join(" ")}
          style={{ stroke: laneColor(l), strokeWidth: 2, strokeLinejoin: "round", strokeLinecap: "round" }} />;
      })}
      {points.map((p, i) => {
        const lane = lanes.find((l) => l.id === p.lane);
        const color = laneColor(lane);
        const key = p.span ?? `p${i}`;
        const side = Boolean(p.span && lines.get(p.lane)?.side.has(p.span));
        const active = p.span && (p.span === selectedId || key === focused);
        const props = p.span ? { role: "button", tabIndex: 0, "aria-label": label(p), "aria-pressed": p.span === selectedId,
          className: "cursor-pointer outline-none", onClick: () => onSelect(p.span), onFocus: () => setFocused(key),
          onBlur: () => setFocused((f) => (f === key ? null : f)),
          onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(p.span); } } }
          : { "aria-hidden": "true" };
        return <circle key={key} {...props} data-context-point="" data-context-side={side ? "" : undefined}
          cx={x(p.start_ms)} cy={y(p.tokens)} r={active ? 5 : 3.5}
          style={{ fill: active ? color : "var(--surface-card)", stroke: color, strokeWidth: 1.5,
            strokeDasharray: side ? "2 1.5" : undefined }}>
          <title>{label(p)}</title>
        </circle>;
      })}
      <TimeAxis end={end} y={VIEW_H - 4} />
    </svg>
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-500">
      <span>{translate("m4ba48b128574")}</span>
      {sideSources.length > 0 && <span>{translate("m230a4032eef1", [sideExample])}</span>}
      {s.missing > 0 && <span>{translate("m6dcc5db48d2f", [formatObserved(s.missing)])}</span>}
      {s.partial && <span>{translate("me3ce4065ae02")}</span>}
      {compactions.length > 0 && <span>{translate("m42a70e109062")}</span>}
      {client !== "codex" && <span>{translate("m31448e365072")}</span>}
      {client === "codex" && s.autoCompactLimit === null && s.contextWindow === null && <span>{translate("m5682cbb5ee40")}</span>}
      {client === "codex" && s.autoCompactLimit !== null && !limitInChart
        && <span>{translate("m9ce6db5143da", [tokensText(s.autoCompactLimit)])}</span>}
    </div>
  </section>;
}
