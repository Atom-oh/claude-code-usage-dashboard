// Context size of one task (/api/users/tasks/detail `context`): one line per lane of per-call
// input context (input + cache read + cache write; Codex: input incl. cache), Claude Code
// compaction marks (pre → post tokens) and, for Codex, the auto-compaction limit the
// conversation reported. Claude Code reports no context window, so no share of it is drawn.
// The time axis matches the lane timeline above it (same X0/PLOT_W/end).
import { useState } from "react";
import { laneColorFor } from "../colors.js";
import { formatObserved } from "../clientUsage.js";
import { observedNumber } from "../clientPresentation.js";
import { compactCount, contextSummary, laneName } from "../taskTrace.js";
import { formatTaskDuration } from "./TaskList.jsx";
import { TimeAxis, PLOT_W, VIEW_W, X0 } from "./TaskTimeline.jsx";

const VIEW_H = 210, TOP = 14, BASE = 184, LEGEND_ROW = 18;
const COMPACTION = "var(--warning)", LIMIT = "var(--warning-text)";
// A positive share below 1% reads "<1%", never 0%.
const pct = (v) => (v > 0 && v < 0.01 ? "<1%" : `${Math.round(v * 100)}%`);
const tokensText = (v) => compactCount(v) ?? "미수집";

function niceMax(v) {
  if (!(v > 0)) return 1;
  const step = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / step) * step;
}

export function TaskContextChart({ context, lanes, end, numbers, client, selectedId, onSelect }) {
  const [focused, setFocused] = useState(null);
  const s = contextSummary(context);
  if (!s.points) return <p className="text-sm text-ink-500">컨텍스트 크기 미수집</p>;
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
  const ticks = [0, 0.5, 1].map((f) => f * yMax);
  const label = (p) => {
    const lane = lanes.find((l) => l.id === p.lane);
    const n = p.span ? numbers.get(p.span) : null;
    return `${n ? `LLM 호출 #${n}` : "LLM 호출"} · ${lane ? laneName(lane) : "서브에이전트"} · 컨텍스트 ${tokensText(p.tokens)}`
      + ` · +${formatTaskDuration(p.start_ms)}`;
  };
  const stats = [
    `최대 ${tokensText(s.peak.tokens)}${s.peak.span && numbers.get(s.peak.span) ? ` (호출 #${numbers.get(s.peak.span)})` : ""}`,
    s.mainFirst !== null && s.mainLast !== null ? `메인 ${tokensText(s.mainFirst)} → ${tokensText(s.mainLast)}` : null,
    client === "codex" ? null : s.compactions === null ? "컴팩션 미수집" : s.compactions === 0 ? "컴팩션 없음"
      : `컴팩션 ${formatObserved(s.compactions)}회${s.biggestCompaction ? ` (${s.biggestCompaction.trigger ?? "trigger 미수집"} ${
        tokensText(s.biggestCompaction.pre_tokens)} → ${tokensText(s.biggestCompaction.post_tokens)})` : ""}`,
    s.limitShare !== null ? `자동 컴팩션 한도 ${tokensText(s.autoCompactLimit)}의 ${pct(s.limitShare)}` : null,
    s.windowShare !== null ? `컨텍스트 창 ${tokensText(s.contextWindow)}의 ${pct(s.windowShare)}` : null,
  ].filter(Boolean);

  return <section aria-label="컨텍스트 크기">
    <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 className="text-[13px] font-semibold text-ink-800">컨텍스트 크기</h3>
      <span className="text-[12px] text-ink-500">{client === "codex" ? "응답별 입력 토큰 (캐시 포함)"
        : "호출별 입력 합계 (입력 + 캐시 읽기 + 캐시 쓰기)"}</span>
    </div>
    <ul aria-label="컨텍스트 요약" className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-700">
      {stats.map((t) => <li key={t} className="tabular-nums">{t}</li>)}
    </ul>
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" className="block" role="group"
      aria-label={`레인별 컨텍스트 크기, 최대 ${tokensText(s.peak.tokens)}`}>
      {shown.map((l, i) => <g key={l.id} aria-hidden="true">
        <rect x={8} y={TOP + i * LEGEND_ROW} width={10} height={3} rx={1} style={{ fill: laneColorFor(l.kind) }} />
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
          {`자동 컴팩션 한도 ${tokensText(s.autoCompactLimit)}`}</text>
      </g>}
      {compactions.map((c, i) => <g key={`c${i}`} data-compaction="" aria-hidden="true">
        <line x1={x(c.start_ms)} x2={x(c.start_ms)} y1={TOP} y2={BASE} style={{ stroke: COMPACTION, strokeWidth: 1.5, strokeDasharray: "5 4" }} />
        <text x={x(c.start_ms) + 4} y={TOP + 10 + (i % 3) * 13} style={{ fill: "var(--warning-text)", fontSize: 11, fontWeight: 600 }}>
          {`컴팩션 ${tokensText(c.pre_tokens)} → ${tokensText(c.post_tokens)}`}</text>
      </g>)}
      {shown.map((l) => {
        const own = points.filter((p) => p.lane === l.id);
        return own.length > 1 && <polyline key={l.id} data-context-line={l.id} aria-hidden="true" fill="none"
          points={own.map((p) => `${x(p.start_ms).toFixed(1)},${y(p.tokens).toFixed(1)}`).join(" ")}
          style={{ stroke: laneColorFor(l.kind), strokeWidth: 2, strokeLinejoin: "round", strokeLinecap: "round" }} />;
      })}
      {points.map((p, i) => {
        const lane = lanes.find((l) => l.id === p.lane);
        const color = laneColorFor(lane?.kind);
        const key = p.span ?? `p${i}`;
        const active = p.span && (p.span === selectedId || key === focused);
        const props = p.span ? { role: "button", tabIndex: 0, "aria-label": label(p), "aria-pressed": p.span === selectedId,
          className: "cursor-pointer outline-none", onClick: () => onSelect(p.span), onFocus: () => setFocused(key),
          onBlur: () => setFocused((f) => (f === key ? null : f)),
          onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(p.span); } } }
          : { "aria-hidden": "true" };
        return <circle key={key} {...props} data-context-point="" cx={x(p.start_ms)} cy={y(p.tokens)} r={active ? 5 : 3.5}
          style={{ fill: active ? color : "var(--surface-card)", stroke: color, strokeWidth: 1.5 }}>
          <title>{label(p)}</title>
        </circle>;
      })}
      <TimeAxis end={end} y={VIEW_H - 4} />
    </svg>
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-500">
      <span>점을 누르면 그 호출을 오른쪽 패널에서 봅니다</span>
      {s.missing > 0 && <span>{`토큰 미수집 호출 ${formatObserved(s.missing)}개는 그리지 않음`}</span>}
      {s.partial && <span>일부 호출 기준</span>}
      {compactions.length > 0 && <span>컴팩션 토큰은 Claude Code가 보고한 값으로, 호출별 입력 합계와 계산 기준이 다를 수 있습니다</span>}
      {client !== "codex" && <span>Claude Code는 컨텍스트 창 크기를 보내지 않아 창 대비 비율은 표시하지 않습니다</span>}
      {client === "codex" && s.autoCompactLimit === null && s.contextWindow === null && <span>이 대화의 한도를 찾지 못했습니다</span>}
      {client === "codex" && s.autoCompactLimit !== null && !limitInChart
        && <span>{`자동 컴팩션 한도 ${tokensText(s.autoCompactLimit)}은 차트 범위 밖`}</span>}
    </div>
  </section>;
}
