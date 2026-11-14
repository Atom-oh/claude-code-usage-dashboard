import { translate, useLocale } from "../i18n/index.js";
// Partial-preserving model cost stacked area: known amounts are drawn, unavailable and no-data
// buckets break the areas instead of dipping to zero, and each bucket carries a state mark. SeriesBarChart keeps its all-or-nothing policy.
import { useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { makeTickFmt } from "../fmt.js";
import { buildModelCostFrame, chartTheme, formatAxisUsd, formatUsd, formatUsdPrecise, OTHERS_COLOR_KEY,
  OTHERS_KEY, REASON_GROUPS, reasonLabel, STATE_LABELS, trendColor, trendStrokeColor } from "../modelCostTrend.js";
import { useConfig } from "../ConfigContext.jsx";
import { useRange } from "../RangeContext.jsx";
import { useChartColors, axisTick, tooltipStyles } from "../useChartColors.js";
import EmptyState from "./EmptyState.jsx";
import { SegmentedControl } from "./SegmentedControl.jsx";
import { useDragZoom } from "./GroupCharts.jsx";

// Same look as Card, but the header wraps: on narrow screens the controls drop below the title
// instead of squeezing it (Card keeps its right slot shrink-0 for its other callers).
function TrendCard({ title, subtitle, help, right, children, accent }) {
  const _locale = useLocale();
  return (
    <div data-model-trend data-client-accent={accent}
      className={`bg-card border border-ink-100 rounded-lg shadow-card overflow-hidden${accent ? " border-t-[3px]" : ""}`}
      style={accent ? { borderTopColor: accent } : undefined}>
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
  const _locale = useLocale();
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
      <g data-state="partial" role="img" aria-label={translate("m2d5bfb444eb6", [tick])}>
        <circle cx={cx} cy={cy} r={6} fill="var(--warning-surface)" stroke="var(--warning-text)" strokeWidth={1.2} />
        <text x={cx} y={cy + 3.5} {...MARK_TEXT} fill="var(--warning-text)">!</text>
      </g>
    );
  }
  if (state === "unavailable") {
    return (
      <g data-state="unavailable" role="img" aria-label={translate("m6a9bcb1669f7", [tick])}>
        <circle cx={cx} cy={cy} r={6} fill="none" stroke={axis} strokeWidth={1.2} strokeDasharray="2 2" />
        <text x={cx} y={cy + 3.5} {...MARK_TEXT} fill={axis}>?</text>
      </g>
    );
  }
  if (state === "zero") {
    return (
      <g data-state="zero" role="img" aria-label={translate("mfbc9fd94847e", [tick])}>
        <rect x={x} y={base - 2} width={width} height={2} fill={axis} />
      </g>
    );
  }
  return (
    <g data-state="idle" role="img" aria-label={translate("md6b010ac8999", [tick])}>
      <line x1={x} x2={x + width} y1={base - 1} y2={base - 1} stroke={axis} strokeDasharray="1 3" />
    </g>
  );
}

// Distinct reason-group labels for the reasons with a positive count, in REASON_GROUPS order.
// Areas need two neighbours to show any width, so a known point between gaps gets a dot.
// A zero contribution (no usage for that series) gets no dot.
function IsolatedDot({ cx, cy, index, dataKey, rows, fill }) {
  const _locale = useLocale();
  const has = (i) => rows[i] != null && rows[i][dataKey] != null;
  if (!(rows[index]?.[dataKey] > 0) || !Number.isFinite(cx) || !Number.isFinite(cy)
    || has(index - 1) || has(index + 1)) return null;
  return <circle data-isolated cx={cx} cy={cy} r={2.5} fill={fill} />;
}

function reasonLabels(reasons) {
  const present = new Set(Object.entries(reasons || {}).filter(([, n]) => n > 0).map(([key]) => reasonLabel(key)));
  return REASON_GROUPS.map((g) => g.label).filter((label) => present.has(label)).join(" / ");
}

// Legend identities: a series by its model/user key (stable across rank changes), Others by its key.
const legendId = (s) => `s:${s.model}`;
const OTHERS_ID = `o:${OTHERS_KEY}`;

// Grafana-style: a click isolates the item (or restores all when it is already the only one
// shown); Ctrl/Cmd/Shift toggles just that item. Hiding every item restores all instead.
export function nextHidden(hidden, id, ids, toggle) {
  const visible = ids.filter((x) => !hidden.has(x));
  let next;
  if (toggle) {
    next = new Set(hidden);
    if (next.has(id)) next.delete(id); else next.add(id);
  } else {
    next = visible.length === 1 && visible[0] === id ? new Set() : new Set(ids.filter((x) => x !== id));
  }
  return ids.every((x) => next.has(x)) ? new Set() : next;
}

function TrendTooltip({ active, payload, frame, fmtTick, c, hidden }) {
  const _locale = useLocale();
  if (!active || !payload || payload.length === 0) return null;
  const b = payload[0].payload.__bucket;
  if (b.state === "nodata") return null;
  const entries = frame.series
    .filter((s) => b.segments[s.key] !== null && !hidden.has(legendId(s)))
    .map((s) => ({ key: s.key, label: s.label, value: b.segments[s.key], partial: b.partialSeries.includes(s.key) }));
  if (b.others !== null && !hidden.has(OTHERS_ID)) {
    entries.push({ key: OTHERS_KEY, label: frame.others.label, value: b.others, partial: b.othersPartial });
  }
  entries.sort((a, z) => z.value - a.value);
  const filtered = hidden.size > 0;
  // Shown subtotal follows the bucket rules for the shown items only: unavailable when nothing
  // shown is known but something shown is, partial when some shown cost is unavailable.
  const shownUnavailable = frame.series.some((s) => !hidden.has(legendId(s)) && b.partialSeries.includes(s.key))
    || (!hidden.has(OTHERS_ID) && b.othersPartial);
  const shownText = entries.length === 0
    ? (shownUnavailable ? translate("m298859a04696") : translate("m5eef64646a1b"))
    : `${shownUnavailable ? translate("m9665243ca13b") : ""}${formatUsd(entries.reduce((sum, e) => sum + e.value, 0))}`;
  const total = b.state === "unavailable" ? translate("m298859a04696") : b.state === "idle" ? translate("m5eef64646a1b") : formatUsd(b.total);
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
      {filtered && b.state !== "unavailable" && b.state !== "idle" && (
        <div data-tooltip-shown>{translate("mb885dbfb5796", [shownText])}</div>
      )}
      <div data-tooltip-total>{translate("m4e39720cce24", [filtered ? translate("m3445c6df4502") : "", b.state === "partial" ? translate("m830e860c2bd2") : "", total])}</div>
      {b.hasEstimate && <div data-tooltip-estimate>{translate("mada64dc4372b")}</div>}
      {b.issues.length > 0 && (
        <div data-tooltip-note>{translate("m704897fb1f91", [b.issues.map((i) => `${i.label} (${reasonLabels(i.reasons)})`).join(", ")])}</div>
      )}
      {b.state === "idle" && <div data-tooltip-note>{translate("ma0ff51d7b53b")}</div>}
    </div>
  );
}

export function ModelCostTrend({ title, subtitle, help, right, cells, xKey = "t", bucketHours, bounds,
  pinned, top = 6, basis, tickFormatter, zoomDisabled = false, height = 260, clampRange, accent, dimension = "model", userSuffix }) {
  const _locale = useLocale();
  const noun = dimension === "user" ? translate("m1ac6e422b7dc") : dimension === "team" ? translate("m321639b7ad86") : translate("mf9f4d4113aa1");
  const c = useChartColors();
  // One bucket-size fallback (the global interval, as useDragZoom uses) for zoom, ticks and grid.
  const { intervalHours } = useRange();
  const hours = bucketHours > 0 ? bucketHours : intervalHours;
  // The zoom stays within the range cap and never starts before the range: an explicit clampRange
  // ([from, to|null]; a null end is not clamped), else the response bounds (a live window).
  const { rangeCapDays } = useConfig();
  const [clampFrom, clampTo] = clampRange ?? (bounds?.from && bounds?.to ? [bounds.from, bounds.to] : []);
  const clamp = { from: clampFrom, to: clampTo, maxSpanMs: rangeCapDays * 86400000 };
  const zoom = useDragZoom(undefined, hours, undefined, zoomDisabled, clamp);
  const [showTable, setShowTable] = useState(false);
  const [stacked, setStacked] = useState(true);
  const [hiddenIds, setHiddenIds] = useState(() => new Set());
  const theme = chartTheme(c.surface);
  const fmtTick = tickFormatter ?? makeTickFmt(hours);
  const hasCells = Array.isArray(cells);
  // Memoized on value keys: a 90-day hourly frame took ~56 ms (host-measured) and drags re-render.
  const pinnedKey = JSON.stringify(pinned ?? []);
  const fromMs = boundMs(bounds?.from), toMs = boundMs(bounds?.to);
  const frame = useMemo(() => (Array.isArray(cells)
    ? buildModelCostFrame(cells, { top, pinned: JSON.parse(pinnedKey), bounds: { from: fromMs, to: toMs }, bucketHours: hours, dimension, userSuffix })
    : null), [cells, top, pinnedKey, fromMs, toMs, hours, dimension, userSuffix, _locale]);

  const chip = basis ? <span className="rounded-full border border-ink-200 px-2 py-0.5 text-[11px] text-ink-600"
    style={accent ? { borderColor: accent } : undefined}>{basis}</span> : null;
  const toggle = hasCells && cells.length > 0 ? (
    <button
      type="button"
      aria-pressed={showTable}
      onClick={() => setShowTable((v) => !v)}
      className="rounded-md border border-ink-200 px-2 py-0.5 text-[11px] text-ink-600"
    >{translate("m5e2e0e812c63")}</button>
  ) : null;
  const modeToggle = hasCells && cells.length > 0 && !frame.allUnavailable ? (
    <SegmentedControl className="[&_button]:h-[22px] [&_button]:px-2 [&_button]:text-[11px]"
      options={[{ value: "stacked", label: translate("m8daa76940700") }, { value: "lines", label: translate("m3603b4581160") }]}
      value={stacked ? "stacked" : "lines"} onChange={(v) => setStacked(v === "stacked")} />
  ) : null;
  const header = chip || toggle || modeToggle || right != null
    ? <div className="flex flex-wrap items-center justify-end gap-2">{chip}{modeToggle}{toggle}{right}</div>
    : undefined;

  if (!hasCells) {
    return (
      <TrendCard title={title} subtitle={subtitle} help={help} right={header} accent={accent}>
        <div role="status" className="text-sm text-ink-500">{translate("mdc6b9ec18451", [noun])}</div>
      </TrendCard>
    );
  }
  if (cells.length === 0) {
    return (
      <TrendCard title={title} subtitle={subtitle} help={help} right={header} accent={accent}>
        <EmptyState />
      </TrendCard>
    );
  }

  const { series, totals } = frame;
  const showOthers = frame.others.count > 0 || frame.buckets.some((b) => b.others !== null);
  const othersColor = trendColor(OTHERS_COLOR_KEY, theme);
  const rows = frame.buckets.map((b) => {
    const row = { [xKey]: b.t };
    // Unavailable and no-data buckets are gaps, never a drawn $0. Inside a partial bucket a series
    // whose cost is unavailable (no known amount) is a gap too; a series with no usage stacks as 0.
    const gap = b.state === "unavailable" || b.state === "nodata";
    for (const s of series) {
      const known = b.segments[s.key];
      row[s.key] = gap || (known === null && b.partialSeries.includes(s.key)) ? null : known ?? 0;
    }
    row[OTHERS_KEY] = gap || (b.others === null && b.othersPartial) ? null : b.others ?? 0;
    row.__mark = 0;
    row.__bucket = b;
    return row;
  });

  const status = (
    <div role="status" className="mt-3 space-y-1 text-[12px] text-ink-500">
      {frame.allUnavailable && <p data-status-all-unavailable>{translate("m0ab525212cfa")}</p>}
      <p data-status-headline>
        {totals.issues.length > 0
          ? translate("m96a78c04043f", [totals.reviewBuckets, totals.identityCount])
          : translate("m5f3ef071dadd")}
      </p>
      {totals.issues.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5">
          {totals.issues.map((group) => (
            <li key={group.key} data-reason={group.key}>
              {translate("m4c512c3116b1", [group.label, group.count, group.identities.map((i) => translate("m7724e60d3127", [i.label, i.inOthers ? translate("m62221ecf0b2b") : "", i.count])).join(", ")])}
            </li>
          ))}
        </ul>
      )}
      {totals.issues.length > 0 && (
        <p data-status-note>{translate("m941b97e751a8")}</p>
      )}
      {totals.idleBuckets > 0 && (
        <p data-status-idle>{translate("m33c0bea9747c", [totals.idleBuckets])}</p>
      )}
      {totals.estimateBuckets > 0 && (
        <p data-status-estimate>{translate("mb922216b3a42", [totals.estimateBuckets])}</p>
      )}
    </div>
  );

  const tables = showTable ? (
    <div role="region" aria-label={typeof title === "string" && title ? translate("mb96d90c8f577", [title]) : translate("m9e734340b9ff", [noun])} tabIndex={0}
      className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-500">
      <table aria-label={translate("m072bf5b38ceb")} className={TABLE_CLASS}>
        <thead>
          <tr>
            <th className="whitespace-nowrap">{translate("mce101f7dd9ff")}</th>
            {series.map((s) => <th key={s.key}>{s.label}</th>)}
            {showOthers && <th>{frame.others.label}</th>}
            <th>{translate("mc67d7cf662cf")}</th>
            <th>{translate("me10195a1239f")}</th>
          </tr>
        </thead>
        <tbody>
          {frame.buckets.map((b) => (
            <tr key={b.t} data-bucket={b.t}>
              <td className="whitespace-nowrap">{fmtTick(b.t)}</td>
              {series.map((s) => (
                <td key={s.key}>{formatUsdPrecise(b.segments[s.key]) + (b.partialSeries.includes(s.key) ? " ⚠" : "")}</td>
              ))}
              {showOthers && <td>{formatUsdPrecise(b.others) + (b.othersPartial ? " ⚠" : "")}</td>}
              <td>{formatUsdPrecise(b.state === "idle" ? 0 : b.total)}</td>
              <td>{STATE_LABELS[b.state] + (b.hasEstimate ? translate("m8c415723e11e") : "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {frame.othersBreakdown.length > 0 && (
        <table aria-label={translate("m447c5c7e8815", [noun])} className={TABLE_CLASS}>
          <thead>
            <tr><th>{noun}</th>{dimension === "model" && <th>{translate("mee55b8dd6e2d")}</th>}<th>{translate("m3813ba066940")}</th><th>{translate("m298859a04696")}</th></tr>
          </thead>
          <tbody>
            {frame.othersBreakdown.map((entry) => (
              <tr key={`${entry.model}\u0000${entry.channel}`}>
                <td className="break-words">{entry.label}</td>
                {dimension === "model" && <td>{entry.channel ?? "—"}</td>}
                <td>{formatUsdPrecise(entry.known)}</td>
                <td>{entry.unavailable > 0 ? translate("mefd506fcc7af", [entry.unavailable]) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  ) : null;

  if (frame.allUnavailable) {
    return (
      <TrendCard title={title} subtitle={subtitle} help={help} right={header} accent={accent}>
        {status}
        {tables}
      </TrendCard>
    );
  }

  const items = [
    ...series.map((s) => ({ id: legendId(s), key: s.key, label: s.label, color: trendColor(s.colorKey, theme), swatch: "solid" })),
    ...(showOthers ? [{ id: OTHERS_ID, key: OTHERS_KEY, label: frame.others.label, color: othersColor, swatch: "others" }] : []),
  ].map((item) => ({ ...item, stroke: trendStrokeColor(item.color, c.surface) }));
  const ids = items.map((item) => item.id);
  // Ids from an earlier frame that no longer exist do not count as hidden, and a frame change that
  // would leave nothing shown restores all.
  const current = ids.filter((id) => hiddenIds.has(id));
  const hidden = new Set(current.length === ids.length ? [] : current);
  const onLegend = (id) => (event) =>
    setHiddenIds(nextHidden(hidden, id, ids, event.ctrlKey || event.metaKey || event.shiftKey));
  // Stacked areas sum the shown series; "기본" draws each shown series as its own line.
  const plot = ({ key, label, color, stroke }) => stacked ? (
    <Area key={key} type="monotone" dataKey={key} name={label} stackId="a" fill={color} fillOpacity={0.78}
      stroke={stroke} strokeWidth={1.2} connectNulls={false} dot={<IsolatedDot rows={rows} fill={stroke} />}
      activeDot={{ r: 3, stroke: c.surface, strokeWidth: 1 }} isAnimationActive={false} />
  ) : (
    <Line key={key} type="monotone" dataKey={key} name={label} stroke={stroke} strokeWidth={2}
      connectNulls={false} dot={<IsolatedDot rows={rows} fill={stroke} />}
      activeDot={{ r: 3, stroke: c.surface, strokeWidth: 1 }} isAnimationActive={false} />
  );
  return (
    <TrendCard title={title} subtitle={subtitle} help={help} right={header} accent={accent}>
      <ResponsiveContainer width="100%" height={height} className={zoom.className}>
        <ComposedChart data={rows} margin={{ top: 24, right: 8, left: 8, bottom: 0 }} {...zoom.handlers}>
          {zoom.controller}
          <CartesianGrid strokeDasharray="2 4" stroke={c.grid} vertical={false} />
          <XAxis dataKey={xKey} tick={axisTick(c)} tickLine={false} axisLine={{ stroke: c.grid }} tickFormatter={fmtTick} minTickGap={24} />
          <YAxis tick={axisTick(c)} tickLine={false} axisLine={false} width={56} tickFormatter={formatAxisUsd} />
          <Tooltip content={<TrendTooltip frame={frame} fmtTick={fmtTick} c={c} theme={theme} hidden={hidden} />} />
          {items.filter((item) => !hidden.has(item.id)).map(plot)}
          {/* An invisible zero-height bar carries each bucket's state mark above the plot band. */}
          <Bar dataKey="__mark" stackId="marks" isAnimationActive={false} legendType="none" shape={<BucketMark fmtTick={fmtTick} axis={c.axis} />} />
          {zoom.overlay}
        </ComposedChart>
      </ResponsiveContainer>
      <ul aria-label={translate("m96b68d6b8f83")} className="mt-2 flex flex-wrap gap-x-1 gap-y-1 text-[11px] text-ink-500">
        {items.map((item) => {
          const shown = !hidden.has(item.id);
          return (
            <li key={item.id}>
              <button type="button" aria-pressed={shown} data-legend={item.key} onClick={onLegend(item.id)}
                title={translate("m7999a820160f")}
                className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-ink-50 ${shown ? "" : "opacity-40 line-through"}`}>
                <span aria-hidden="true" data-swatch={item.swatch}
                  className={`inline-block h-2.5 w-2.5 ${item.swatch === "others" ? "rounded-sm" : "rounded-[3px]"}`}
                  style={{ background: stacked ? item.color : item.stroke }} />
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
      {hidden.size > 0 && (
        <p data-legend-filtered className="mt-1 text-[11px] text-ink-500">
          {translate("m5a43e42ab8d1", [hidden.size])}
          <button type="button" className="underline" onClick={() => setHiddenIds(new Set())}>{translate("m75e8bb70f13a")}</button>
        </p>
      )}
      {status}
      {tables}
    </TrendCard>
  );
}
