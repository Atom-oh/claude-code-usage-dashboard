// Partial-preserving model cost stacked bar: known amounts are drawn, unavailable is never drawn
// as zero, and each bucket carries a state mark. SeriesBarChart keeps its all-or-nothing policy.
import { useId, useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { makeTickFmt } from "../fmt.js";
import { buildModelCostFrame, chartTheme, formatAxisUsd, formatUsd, formatUsdPrecise, OTHERS_COLOR_KEY,
  OTHERS_KEY, REASON_GROUPS, reasonLabel, STATE_LABELS, trendColor } from "../modelCostTrend.js";
import { useRange } from "../RangeContext.jsx";
import { useChartColors, axisTick, tooltipStyles } from "../useChartColors.js";
import EmptyState from "./EmptyState.jsx";
import { useDragZoom } from "./GroupCharts.jsx";

// Same look as Card, but the header wraps: on narrow screens the controls drop below the title
// instead of squeezing it (Card keeps its right slot shrink-0 for its other callers).
function TrendCard({ title, subtitle, help, right, children }) {
  return (
    <div className="bg-card border border-ink-100 rounded-lg shadow-card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4 pb-3 border-b border-ink-100">
        <div className="min-w-0 flex-1 basis-40">
          <div className="flex items-center gap-1 min-w-0">
            <div className="text-[14px] font-semibold text-ink-800 truncate">{title}</div>
            {help && <Info size={12} className="shrink-0 text-ink-400" title={help} aria-label={help} />}
          </div>
          {subtitle != null && <div className="text-[12px] text-ink-500 mt-0.5">{subtitle}</div>}
        </div>
        {right != null && <div className="max-w-full">{right}</div>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

const MARK_TEXT = { textAnchor: "middle", fontSize: 9.5, fontWeight: 700 };
const TABLE_CLASS = "mt-3 w-full text-[12px] tabular-nums [&_th]:py-1 [&_th]:pr-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-ink-600 [&_td]:py-1 [&_td]:pr-2 [&_tbody_tr]:border-t [&_tbody_tr]:border-ink-100";
// Memo keys for bounds: a Date, ISO string or epoch ms becomes epoch ms (NaN when unparsable).
const boundMs = (v) => (v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN);

// Recharts calls this once per row with the row as payload and the full plot band as
// background, so the mark sits above the stack regardless of the bucket's values.
function BucketMark({ x, width, payload, background, fmtTick, axis }) {
  const bucket = payload.__bucket;
  const state = bucket.state;
  if (state !== "partial" && state !== "unavailable" && state !== "zero" && state !== "idle") {
    return <g data-state={state} />;
  }
  const tick = fmtTick(bucket.t);
  const cx = x + width / 2;
  const cy = background.y - 12;
  const base = background.y + background.height;
  if (state === "partial") {
    return (
      <g data-state="partial" role="img" aria-label={`${tick} 부분합 — 일부 비용 확인 불가`}>
        <circle cx={cx} cy={cy} r={6} fill="var(--warning-surface)" stroke="var(--warning-text)" strokeWidth={1.2} />
        <text x={cx} y={cy + 3.5} {...MARK_TEXT} fill="var(--warning-text)">!</text>
      </g>
    );
  }
  if (state === "unavailable") {
    return (
      <g data-state="unavailable" role="img" aria-label={`${tick} 비용 확인 불가`}>
        <circle cx={cx} cy={cy} r={6} fill="none" stroke={axis} strokeWidth={1.2} strokeDasharray="2 2" />
        <text x={cx} y={cy + 3.5} {...MARK_TEXT} fill={axis}>?</text>
      </g>
    );
  }
  if (state === "zero") {
    return (
      <g data-state="zero" role="img" aria-label={`${tick} $0 (측정값)`}>
        <rect x={x} y={base - 2} width={width} height={2} fill={axis} />
      </g>
    );
  }
  return (
    <g data-state="idle" role="img" aria-label={`${tick} 기록된 사용 없음`}>
      <line x1={x} x2={x + width} y1={base - 1} y2={base - 1} stroke={axis} strokeDasharray="1 3" />
    </g>
  );
}

// Distinct reason-group labels for the reasons with a positive count, in REASON_GROUPS order.
function reasonLabels(reasons) {
  const present = new Set(Object.entries(reasons || {}).filter(([, n]) => n > 0).map(([key]) => reasonLabel(key)));
  return REASON_GROUPS.map((g) => g.label).filter((label) => present.has(label)).join(" / ");
}

function TrendTooltip({ active, payload, frame, fmtTick, c }) {
  if (!active || !payload || payload.length === 0) return null;
  const b = payload[0].payload.__bucket;
  if (b.state === "nodata") return null;
  const entries = frame.series
    .filter((s) => b.segments[s.key] !== null)
    .map((s) => ({ key: s.key, label: s.label, value: b.segments[s.key], partial: b.partialSeries.includes(s.key) }));
  if (b.others !== null) {
    entries.push({ key: OTHERS_KEY, label: frame.others.label, value: b.others, partial: b.othersPartial });
  }
  entries.sort((a, z) => z.value - a.value);
  const total = b.state === "unavailable" ? "확인 불가" : b.state === "idle" ? "기록된 사용 없음" : formatUsd(b.total);
  return (
    <div data-mct-tooltip style={{ ...tooltipStyles(c).contentStyle, color: c.tooltipFg, fontSize: 12 }}>
      <div data-tooltip-label style={{ fontSize: 11, marginBottom: 2 }}>{fmtTick(b.t)}</div>
      <ul>
        {entries.map((e) => (
          <li key={e.key} data-entry={e.key}>
            <span data-label>{e.partial ? `${e.label} ⚠` : e.label}</span> <span data-value>{formatUsd(e.value)}</span>
          </li>
        ))}
      </ul>
      <div data-tooltip-total>{`알려진 합계${b.state === "partial" ? " (부분합)" : ""} ${total}`}</div>
      {b.issues.length > 0 && (
        <div data-tooltip-note>{`확인 필요: ${b.issues.map((i) => `${i.label} (${reasonLabels(i.reasons)})`).join(", ")}`}</div>
      )}
      {b.state === "idle" && <div data-tooltip-note>기록된 사용 없음 — 수집 누락일 수 있습니다</div>}
    </div>
  );
}

export function ModelCostTrend({ title, subtitle, help, right, cells, xKey = "t", bucketHours, bounds,
  pinned, top = 6, basis, tickFormatter, zoomDisabled = false, height = 260 }) {
  const c = useChartColors();
  // One bucket-size fallback (the global interval, as useDragZoom uses) for zoom, ticks and grid.
  const { intervalHours } = useRange();
  const hours = bucketHours > 0 ? bucketHours : intervalHours;
  const zoom = useDragZoom(undefined, hours, undefined, zoomDisabled);
  const [showTable, setShowTable] = useState(false);
  const pid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const theme = chartTheme(c.surface);
  const fmtTick = tickFormatter ?? makeTickFmt(hours);
  const hasCells = Array.isArray(cells);
  // Memoized on value keys: a 90-day hourly frame took ~56 ms (host-measured) and drags re-render.
  const pinnedKey = JSON.stringify(pinned ?? []);
  const fromMs = boundMs(bounds?.from), toMs = boundMs(bounds?.to);
  const frame = useMemo(() => (Array.isArray(cells)
    ? buildModelCostFrame(cells, { top, pinned: JSON.parse(pinnedKey), bounds: { from: fromMs, to: toMs }, bucketHours: hours })
    : null), [cells, top, pinnedKey, fromMs, toMs, hours]);

  const chip = basis ? <span className="rounded-full border border-ink-200 px-2 py-0.5 text-[11px] text-ink-600">{basis}</span> : null;
  const toggle = hasCells && cells.length > 0 ? (
    <button
      type="button"
      aria-pressed={showTable}
      onClick={() => setShowTable((v) => !v)}
      className="rounded-md border border-ink-200 px-2 py-0.5 text-[11px] text-ink-600"
    >
      표 보기
    </button>
  ) : null;
  const header = chip || toggle || right != null
    ? <div className="flex flex-wrap items-center justify-end gap-2">{chip}{toggle}{right}</div>
    : undefined;

  if (!hasCells) {
    return (
      <TrendCard title={title} subtitle={subtitle} help={help} right={header}>
        <div role="status" className="text-sm text-ink-500">모델별 비용 정보가 없어 추이를 확인할 수 없습니다.</div>
      </TrendCard>
    );
  }
  if (cells.length === 0) {
    return (
      <TrendCard title={title} subtitle={subtitle} help={help} right={header}>
        <EmptyState />
      </TrendCard>
    );
  }

  const { series, totals } = frame;
  const showOthers = frame.others.count > 0 || frame.buckets.some((b) => b.others !== null);
  const othersColor = trendColor(OTHERS_COLOR_KEY, theme);
  const rows = frame.buckets.map((b) => {
    const row = { [xKey]: b.t };
    for (const s of series) row[s.key] = b.segments[s.key] ?? 0;
    row[OTHERS_KEY] = b.others ?? 0;
    row.__mark = 0;
    row.__bucket = b;
    return row;
  });

  const status = (
    <div role="status" className="mt-3 space-y-1 text-[12px] text-ink-500">
      {frame.allUnavailable && <p data-status-all-unavailable>선택한 기간의 비용을 모두 확인할 수 없습니다.</p>}
      <p data-status-headline>
        {totals.issues.length > 0
          ? `확인 필요 ${totals.reviewBuckets}개 버킷 · ${totals.identityCount}개 항목`
          : "확인이 필요한 버킷이 없습니다."}
      </p>
      {totals.issues.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5">
          {totals.issues.map((group) => (
            <li key={group.key} data-reason={group.key}>
              {`${group.label} ${group.count}건 — ${group.identities.map((i) => `${i.label}${i.inOthers ? " (기타)" : ""} ${i.count}건`).join(", ")}`}
            </li>
          ))}
        </ul>
      )}
      {totals.issues.length > 0 && (
        <p data-status-note>알려진 금액만 막대에 포함했고, 확인할 수 없는 금액은 0으로 그리지 않았습니다.</p>
      )}
      {totals.idleBuckets > 0 && (
        <p data-status-idle>{`기록된 사용 없음 ${totals.idleBuckets}개 버킷 — 수집이 완전하다는 뜻은 아닙니다.`}</p>
      )}
    </div>
  );

  const tables = showTable ? (
    <>
      <table aria-label="버킷별 비용 표" className={TABLE_CLASS}>
        <thead>
          <tr>
            <th>버킷</th>
            {series.map((s) => <th key={s.key}>{s.label}</th>)}
            {showOthers && <th>{frame.others.label}</th>}
            <th>알려진 합계</th>
            <th>상태</th>
          </tr>
        </thead>
        <tbody>
          {frame.buckets.map((b) => (
            <tr key={b.t} data-bucket={b.t}>
              <td>{fmtTick(b.t)}</td>
              {series.map((s) => (
                <td key={s.key}>{formatUsdPrecise(b.segments[s.key]) + (b.partialSeries.includes(s.key) ? " ⚠" : "")}</td>
              ))}
              {showOthers && <td>{formatUsdPrecise(b.others) + (b.othersPartial ? " ⚠" : "")}</td>}
              <td>{formatUsdPrecise(b.state === "idle" ? 0 : b.total)}</td>
              <td>{STATE_LABELS[b.state]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {frame.othersBreakdown.length > 0 && (
        <table aria-label="기타 모델 내역" className={TABLE_CLASS}>
          <thead>
            <tr><th>모델</th><th>채널/백엔드</th><th>알려진 비용</th><th>확인 불가</th></tr>
          </thead>
          <tbody>
            {frame.othersBreakdown.map((entry) => (
              <tr key={`${entry.model}\u0000${entry.channel}`}>
                <td className="break-words">{entry.label}</td>
                <td>{entry.channel ?? "—"}</td>
                <td>{formatUsdPrecise(entry.known)}</td>
                <td>{entry.unavailable > 0 ? `${entry.unavailable}건` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  ) : null;

  if (frame.allUnavailable) {
    return (
      <TrendCard title={title} subtitle={subtitle} help={help} right={header}>
        {status}
        {tables}
      </TrendCard>
    );
  }

  const hatched = series.filter((s) => s.hatch);
  return (
    <TrendCard title={title} subtitle={subtitle} help={help} right={header}>
      <ResponsiveContainer width="100%" height={height} className={zoom.className}>
        <BarChart data={rows} margin={{ top: 24, right: 8, left: 8, bottom: 0 }} {...zoom.handlers}>
          <defs>
            {hatched.map((s) => (
              <pattern key={s.key} id={`${pid}-${s.key}`} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width={5} height={5} fill={c.surface} />
                <rect width={2.2} height={5} fill={trendColor(s.colorKey, theme)} />
              </pattern>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="2 4" stroke={c.grid} vertical={false} />
          <XAxis dataKey={xKey} tick={axisTick(c)} tickLine={false} axisLine={{ stroke: c.grid }} tickFormatter={fmtTick} minTickGap={24} />
          <YAxis tick={axisTick(c)} tickLine={false} axisLine={false} width={56} tickFormatter={formatAxisUsd} />
          <Tooltip content={<TrendTooltip frame={frame} fmtTick={fmtTick} c={c} theme={theme} />} />
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="a"
              fill={s.hatch ? `url(#${pid}-${s.key})` : trendColor(s.colorKey, theme)}
              stroke={c.surface}
              strokeWidth={1}
              isAnimationActive={false}
            />
          ))}
          {showOthers && (
            <Bar dataKey={OTHERS_KEY} name={frame.others.label} stackId="a" fill={othersColor} stroke={c.surface} strokeWidth={1} isAnimationActive={false} />
          )}
          <Bar dataKey="__mark" stackId="a" isAnimationActive={false} legendType="none" shape={<BucketMark fmtTick={fmtTick} axis={c.axis} />} />
          {zoom.overlay}
        </BarChart>
      </ResponsiveContainer>
      <ul aria-label="범례" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-500">
        {series.map((s) => {
          const color = trendColor(s.colorKey, theme);
          const style = s.hatch
            ? { background: `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 4px)`, border: `1px solid ${color}` }
            : { background: color };
          return (
            <li key={s.key} className="flex items-center gap-1.5">
              <span aria-hidden="true" data-swatch={s.hatch ? "hatch" : "solid"} className="inline-block h-2.5 w-2.5 rounded-sm" style={style} />
              {s.label}
            </li>
          );
        })}
        {showOthers && (
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" data-swatch="others" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: othersColor }} />
            {frame.others.label}
          </li>
        )}
      </ul>
      {status}
      {tables}
    </TrendCard>
  );
}
