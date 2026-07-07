import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { colorFor } from "../colors.js";
import { pivotByGroup, pivotByKey, groupsPresent } from "../pivot.js";
import { useChartColors, axisTick, tooltipStyles } from "../useChartColors.js";
import { Card } from "./Card.jsx";

// 시계열, 그룹별 area 하나씩 — ../awsops AreaTrend와 같은 그라디언트 기법, 그룹 색상만 다중.
export function GroupAreaChart({ title, subtitle, right, rows, xKey, valueKey, height = 240, tickFormatter }) {
  const c = useChartColors();
  const data = pivotByGroup(rows, xKey, valueKey);
  const groups = groupsPresent(rows);
  return (
    <Card title={title} subtitle={subtitle} right={right}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            {groups.map((g) => (
              <linearGradient key={g} id={`area-${g}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colorFor(g)} stopOpacity={0.3} />
                <stop offset="100%" stopColor={colorFor(g)} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="2 4" stroke={c.grid} vertical={false} />
          <XAxis dataKey={xKey} tick={axisTick(c)} tickLine={false} axisLine={{ stroke: c.grid }} tickFormatter={tickFormatter} minTickGap={24} />
          <YAxis tick={axisTick(c)} tickLine={false} axisLine={false} width={56} />
          <Tooltip {...tooltipStyles(c)} labelFormatter={tickFormatter} />
          {groups.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {groups.map((g) => (
            <Area key={g} type="monotone" dataKey={g} name={g} stroke={colorFor(g)} strokeWidth={2} fill={`url(#area-${g})`} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </Card>
  );
}

// 그룹 간 단일 지표 비교 — 소수 카테고리 막대 비교. colorFn(row)이 없으면 그룹 색상을 그대로 씀
// (accept/reject처럼 "상태"가 카테고리인 경우엔 colorFn으로 status 팔레트를 넘긴다).
export function GroupBarChart({ title, subtitle, right, rows, xKey = "group", valueKey, height = 220, colorFn }) {
  const c = useChartColors();
  const data = rows || [];
  const fill = colorFn || ((r) => colorFor(r.group));
  return (
    <Card title={title} subtitle={subtitle} right={right}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ left: 8, right: 8 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={c.grid} vertical={false} />
          <XAxis dataKey={xKey} tick={axisTick(c)} tickLine={false} axisLine={{ stroke: c.grid }} />
          <YAxis tick={axisTick(c)} tickLine={false} axisLine={false} width={56} />
          <Tooltip {...tooltipStyles(c)} />
          <Bar dataKey={valueKey} radius={[4, 4, 0, 0]} maxBarSize={64}>
            {data.map((r, i) => (
              <Cell key={i} fill={fill(r)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}

// 임의 카테고리(예: model)별 일간 스택 바 — 그룹(bedrock/enterprise) 전용이 아닌 범용 버전.
export function SeriesBarChart({ title, subtitle, right, rows, xKey, seriesKey, valueKey, height = 260, tickFormatter, valuePrefix = "" }) {
  const c = useChartColors();
  const { data, series } = pivotByKey(rows, xKey, seriesKey, valueKey);
  const fmt = (v) => `${valuePrefix}${Number(v).toLocaleString()}`;
  return (
    <Card title={title} subtitle={subtitle} right={right}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ left: 8, right: 8 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={c.grid} vertical={false} />
          <XAxis dataKey={xKey} tick={axisTick(c)} tickLine={false} axisLine={{ stroke: c.grid }} tickFormatter={tickFormatter} />
          <YAxis tick={axisTick(c)} tickLine={false} axisLine={false} width={56} tickFormatter={fmt} />
          <Tooltip {...tooltipStyles(c)} labelFormatter={tickFormatter} formatter={(v) => fmt(v)} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {series.map((s, i) => (
            <Bar key={s} dataKey={s} name={s} stackId="a" fill={c.palette[i % c.palette.length]} radius={i === series.length - 1 ? [4, 4, 0, 0] : 0} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}

// 단위가 다른 두 지표를 한 화면에 — "도입률"(사용자 vs 세션), "사용자당 PR"처럼 좌/우 축이 다른 시계열.
// lines: [{key, label, color, axis: "left" | "right"}] — rows는 이미 xKey 기준으로 wide한 형태여야 함.
export function DualLineChart({ title, subtitle, right, rows, xKey, lines, height = 240, tickFormatter }) {
  const c = useChartColors();
  const hasRight = lines.some((l) => l.axis === "right");
  return (
    <Card title={title} subtitle={subtitle} right={right}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows || []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={c.grid} vertical={false} />
          <XAxis dataKey={xKey} tick={axisTick(c)} tickLine={false} axisLine={{ stroke: c.grid }} tickFormatter={tickFormatter} minTickGap={24} />
          <YAxis yAxisId="left" tick={axisTick(c)} tickLine={false} axisLine={false} width={48} />
          {hasRight && <YAxis yAxisId="right" orientation="right" tick={axisTick(c)} tickLine={false} axisLine={false} width={48} />}
          <Tooltip {...tooltipStyles(c)} labelFormatter={tickFormatter} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {lines.map((l, i) => (
            <Line
              key={l.key}
              yAxisId={l.axis === "right" ? "right" : "left"}
              type="monotone"
              dataKey={l.key}
              name={l.label || l.key}
              stroke={l.color || c.palette[i % c.palette.length]}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
}

// ../awsops DonutBreakdown 포팅 — innerRadius 55/outerRadius 80, 중앙 합계 라벨 + 사이드 범례.
export function DonutBreakdown({ title, subtitle, right, data, nameKey, valueKey, valuePrefix = "" }) {
  const c = useChartColors();
  const total = data.reduce((s, d) => s + (Number(d[valueKey]) || 0), 0);
  const fmt = (v) => (valuePrefix === "$" ? `$${Math.round(v).toLocaleString()}` : v.toLocaleString());

  return (
    <Card title={title} subtitle={subtitle} right={right}>
      <div className="flex items-center gap-4">
        <div className="relative shrink-0" style={{ width: 170, height: 170 }}>
          <PieChart width={170} height={170}>
            <Pie data={data} dataKey={valueKey} nameKey={nameKey} innerRadius={55} outerRadius={80} paddingAngle={2} stroke="none">
              {data.map((_, i) => (
                <Cell key={i} fill={c.palette[i % c.palette.length]} />
              ))}
            </Pie>
            <Tooltip {...tooltipStyles(c)} formatter={(v, n) => [fmt(Number(v)), n]} />
          </PieChart>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <div className="tabular text-[20px] font-semibold leading-none text-ink-800">{fmt(total)}</div>
            <div className="text-[10px] uppercase tracking-[0.04em] text-ink-400 mt-1">합계</div>
          </div>
        </div>
        <ul className="min-w-0 flex-1 space-y-1.5">
          {data.map((d, i) => (
            <li key={i} className="flex items-center gap-2 text-[12px]">
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.palette[i % c.palette.length] }} />
              <span className="min-w-0 flex-1 truncate text-ink-600">{String(d[nameKey])}</span>
              <span className="tabular shrink-0 font-medium text-ink-800">{fmt(Number(d[valueKey]))}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

// ../awsops HBarList 포팅 — recharts 아님, label / 트랙+채움 / 우측 정렬 금액의 단순 flex 리스트.
export function HBarList({ title, subtitle, right, data, labelKey, valueKey, valuePrefix = "" }) {
  const max = data.reduce((m, d) => Math.max(m, Number(d[valueKey]) || 0), 0);
  const fmt = (v) => `${valuePrefix}${Number(v).toLocaleString()}`;

  return (
    <Card title={title} subtitle={subtitle} right={right}>
      <ul className="space-y-2.5">
        {data.map((d, i) => {
          const n = Number(d[valueKey]) || 0;
          const pct = max > 0 ? Math.max(2, (n / max) * 100) : 0;
          return (
            <li key={i} className="flex items-center gap-3">
              <span className="w-32 shrink-0 truncate text-[12px] text-ink-600" title={String(d[labelKey])}>
                {String(d[labelKey])}
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
                <span className="block h-full rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
              </span>
              <span className="tabular w-20 shrink-0 text-right text-[12px] font-medium text-ink-800">{fmt(n)}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
