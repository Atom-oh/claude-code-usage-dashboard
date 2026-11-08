import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { axisTick, tooltipStyles, useChartColors } from "../useChartColors.js";
import { validChatChart } from "../chatCharts.js";
import { parseUtc } from "../fmt.js";
import { basisLabel } from "../clientPresentation.js";

function formatValue(value, unit) {
  if (value === null) return "— (알 수 없음)";
  if (unit === "usd" && value !== 0 && Math.abs(value) < 0.000001) return `$${value.toExponential(2)}`;
  if (unit === "usd") return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.01 ? 6 : 2 })}`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit === "percent" ? "%" : ""}`;
}

function parseTime(value) {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(String(value)) ? new Date(value) : parseUtc(value);
}

function Chart({ chart }) {
  const colors = useChartColors();
  const effective = chart.effective_range;
  const hasRange = typeof effective?.from === "string" && typeof effective?.to === "string"
    && Number.isFinite(parseTime(effective.from).getTime()) && Number.isFinite(parseTime(effective.to).getTime());
  const shortened = hasRange && typeof effective.requested_to === "string"
    && parseTime(effective.requested_to).getTime() > parseTime(effective.to).getTime();
  const timeLabel = value => {
    if (chart.x_type !== "time") return value;
    const date = parseTime(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
  };
  const Frame = chart.type === "line" ? LineChart : BarChart;
  const Series = chart.type === "line" ? Line : Bar;
  return (
    <figure className="my-3 min-w-0 rounded-lg border border-ink-200 bg-card p-3">
      <figcaption className="mb-2 text-[12px] font-semibold text-ink-800">{chart.title}</figcaption>
      <div className="text-[10px] text-ink-500">
        {chart.source === "dashboard" ? "대시보드 집계" : "SQL 조회 결과 · 커버리지 미확인"} · {chart.unit === "usd"
          ? `USD · ${chart.cost_bases?.length ? chart.cost_bases.map(basis => basisLabel(basis === "unknown" ? undefined : basis)).join(" / ") : "비용 기준 미제공"}`
          : chart.unit === "tokens" ? "토큰" : chart.unit === "percent" ? "%" : "건수"}
        {chart.truncated && " · 표시 행 제한"}
        {chart.partial && " · 부분 집계"}
      </div>
      {hasRange && <div className="mt-1 text-[10px] text-ink-500">
        집계 기간: {parseTime(effective.from).toLocaleString()} ~ {parseTime(effective.to).toLocaleString()}
        {shortened && " · 요청 종료 시각보다 짧은 집계"}
      </div>}
      <div className="mt-2 h-[220px] w-full" aria-label={`${chart.title} 차트`}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <Frame data={chart.data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }} accessibilityLayer>
            <CartesianGrid stroke={colors.grid} vertical={false} />
            <XAxis dataKey={chart.x} tick={axisTick(colors)} tickFormatter={timeLabel} minTickGap={20} />
            <YAxis tick={axisTick(colors)} width={55} />
            <Tooltip {...tooltipStyles(colors)} filterNull={false} labelFormatter={timeLabel}
              formatter={(value, name) => [formatValue(value, chart.unit), name]} />
            <Legend wrapperStyle={{ fontSize: 11 }} formatter={value => <span style={{ color: colors.ink }}>{value}</span>} />
            {chart.series.map((s, i) => <Series key={s.key} dataKey={s.key} name={s.label}
              fill={colors.palette[i]} stroke={colors.palette[i]}
              {...(chart.type === "stacked_bar" ? { stackId: "total" } : {})}
              {...(chart.type === "line" ? { connectNulls: false, dot: false } : {})}
              isAnimationActive={false} />)}
          </Frame>
        </ResponsiveContainer>
      </div>
      <details className="mt-2 text-[11px] text-ink-600">
        <summary className="cursor-pointer">데이터 보기</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left">
            <caption className="sr-only">{chart.title} 데이터</caption>
            <thead><tr><th scope="col">{chart.x}</th>{chart.series.map(s => <th key={s.key} scope="col">{s.label}</th>)}</tr></thead>
            <tbody>{chart.data.map((row, i) => <tr key={i}><th scope="row" className="pr-3 font-normal">{timeLabel(row[chart.x])}</th>
              {chart.series.map(s => <td key={s.key} className="pr-3 tabular-nums">{formatValue(row[s.key], chart.unit)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

export function ChatCharts({ charts = [] }) {
  if (!Array.isArray(charts)) return null;
  return charts.slice(0, 3).filter(validChatChart).map((chart, i) => <Chart key={i} chart={chart} />);
}
