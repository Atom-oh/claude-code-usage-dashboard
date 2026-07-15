import { useRef, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "../cn.js";
import { colorFor } from "../colors.js";
import { parseUtc } from "../fmt.js";
import { pivotByGroup, pivotByKey, groupsPresent } from "../pivot.js";
import { useChartColors, axisTick, tooltipStyles } from "../useChartColors.js";
import { useRange } from "../RangeContext.jsx";
import { Card } from "./Card.jsx";

// 시계열 차트에서 좌우로 드래그하면 그 구간으로 전역 range를 좁힌다(RangeContext.setRange) —
// 페이지의 모든 차트가 같이 줌인되고 해상도도 자동으로 세밀해진다. Recharts 카테고리 x축은
// activeLabel(현재 x값)로 드래그 구간을 잡고, ReferenceArea로 하이라이트한다. 라벨이 날짜로
// 파싱되지 않으면(카테고리 축: 모델명·툴명 등) 조용히 no-op이라 별도 opt-in prop이 필요없다.
// bucketHoursOverride: 차트가 전역 intervalHours가 아니라 page-local 버킷 크기로 데이터를
// 조회·표시할 때(예: Cost.jsx의 SegmentedControl) 실제 렌더링 중인 버킷 크기를 넘긴다 — 안
// 그러면 우측 끝 보정(아래)이 전역 intervalHours를 쓰다 화면에 보이는 버킷과 어긋난 custom
// range를 만든다(리뷰에서 MAJOR로 확인).
function useDragZoom(yAxisId, bucketHoursOverride) {
  const chartColors = useChartColors();
  const { setRange, intervalHours: globalIntervalHours } = useRange();
  const startRef = useRef(null);
  const [area, setArea] = useState(null); // { left, right } — 드래그 중 하이라이트 구간
  const cancel = () => { startRef.current = null; setArea(null); };
  const handlers = {
    onMouseDown: (e) => {
      if (!e || e.activeLabel == null) return;
      startRef.current = e.activeLabel;
      setArea({ left: e.activeLabel, right: e.activeLabel });
    },
    // activeLabel이 잠깐 비는 순간(점 사이·플롯 밖)은 마지막 유효 구간을 유지한다.
    onMouseMove: (e) => {
      if (startRef.current == null || !e || e.activeLabel == null) return;
      setArea({ left: startRef.current, right: e.activeLabel });
    },
    onMouseUp: () => {
      const a = area;
      cancel();
      if (!a) return;
      const d1 = parseUtc(a.left), d2 = parseUtc(a.right);
      if (isNaN(d1) || isNaN(d2)) return; // 카테고리 축 → no-op
      // 클릭/미세드래그 가드는 우측 버킷 확장(아래) "전의" raw delta로 판정해야 한다 — 순수 클릭은
      // d1===d2라 delta가 0인데, 확장 후 to-from을 기준으로 삼으면 항상 버킷 하나 크기(예: 1시간)가
      // 되어 가드를 통과해버린다(리뷰에서 CRITICAL로 확인: 툴팁을 보려는 클릭마다 전역이 그 버킷
      // 하나로 줌인되는 오동작). 그래서 순수 클릭 판정은 raw delta 기준으로 먼저 걸러낸다.
      if (Math.abs(d2 - d1) < 10 * 60000) return; // 클릭·미세 드래그 무시(최소 10분)
      const from = d1 <= d2 ? d1 : d2;
      // 라벨은 버킷 "시작" 값인데 서버는 [from,to) exclusive라, 우측 끝 라벨을 그대로 to로 넘기면
      // 그 버킷 자체가 통째로 잘려나간다(리뷰에서 MINOR로 확인) — 현재 버킷 크기(intervalHours)만큼
      // 밀어 그 버킷의 끝까지 포함시킨다. bucketHoursOverride가 없을 때 date-only 라벨(YYYY-MM-DD,
      // 일 버킷)이면 전역 intervalHours 대신 24h를 쓴다 — opt-in(bucketHours prop)에만 의존하면
      // 앞으로 추가되는 일 버킷 차트가 그 prop을 깜빡했을 때 마지막 날이 조용히 잘린다(리뷰에서
      // MAJOR로 확인 — 지금은 Trends/Executive/Overview가 명시적으로 넘겨서 우회하고 있을 뿐).
      const rightLabel = String(d1 <= d2 ? a.right : a.left);
      const intervalHours = bucketHoursOverride ?? (/^\d{4}-\d{2}-\d{2}$/.test(rightLabel) ? 24 : globalIntervalHours);
      const to = new Date((d1 <= d2 ? d2 : d1).getTime() + intervalHours * 3600000);
      setRange(from, to);
    },
    onMouseLeave: cancel,
  };
  const dragging = area && area.left !== area.right;
  // yAxisId — DualLineChart처럼 명명된 축(left/right)을 쓰는 차트는 ReferenceArea에도 같은
  // id를 지정해야 한다. 없으면 Recharts가 기본 축으로 렌더를 시도하다 못 찾아 하이라이트가 안
  // 뜬다(기능은 정상 동작, 시각 피드백만 누락 — 리뷰에서 MINOR로 확인). 명명된 축이 없는
  // Area/Bar 차트는 yAxisId=undefined로 기본 동작 그대로.
  // fill 색상은 하드코딩 대신 useChartColors().lead(테마 CSS 변수, 다크모드 대응)를 쓴다
  // (리뷰에서 MINOR로 확인 — 고정 #6366f1은 다크 테마에서 대비가 어긋날 수 있었다).
  const overlay = dragging ? <ReferenceArea yAxisId={yAxisId} x1={area.left} x2={area.right} strokeOpacity={0} fill={chartColors.lead} fillOpacity={0.12} /> : null;
  return { handlers, overlay, className: dragging ? "select-none" : "" };
}

// 시계열, 그룹별 area 하나씩 — ../awsops AreaTrend와 같은 그라디언트 기법, 그룹 색상만 다중.
export function GroupAreaChart({ title, subtitle, right, rows, xKey, valueKey, height = 240, tickFormatter, bucketHours }) {
  const c = useChartColors();
  const zoom = useDragZoom(undefined, bucketHours);
  const data = pivotByGroup(rows, xKey, valueKey);
  const groups = groupsPresent(rows);
  return (
    <Card title={title} subtitle={subtitle} right={right}>
      <ResponsiveContainer width="100%" height={height} className={zoom.className}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} {...zoom.handlers}>
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
          {zoom.overlay}
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
export function SeriesBarChart({ title, subtitle, right, rows, xKey, seriesKey, valueKey, height = 260, tickFormatter, valuePrefix = "", bucketHours }) {
  const c = useChartColors();
  const zoom = useDragZoom(undefined, bucketHours);
  const { data, series } = pivotByKey(rows, xKey, seriesKey, valueKey);
  const fmt = (v) => `${valuePrefix}${Number(v).toLocaleString()}`;
  return (
    <Card title={title} subtitle={subtitle} right={right}>
      <ResponsiveContainer width="100%" height={height} className={zoom.className}>
        <BarChart data={data} margin={{ left: 8, right: 8 }} {...zoom.handlers}>
          <CartesianGrid strokeDasharray="2 4" stroke={c.grid} vertical={false} />
          <XAxis dataKey={xKey} tick={axisTick(c)} tickLine={false} axisLine={{ stroke: c.grid }} tickFormatter={tickFormatter} />
          <YAxis tick={axisTick(c)} tickLine={false} axisLine={false} width={56} tickFormatter={fmt} />
          <Tooltip {...tooltipStyles(c)} labelFormatter={tickFormatter} formatter={(v) => fmt(v)} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {series.map((s, i) => (
            <Bar key={s} dataKey={s} name={s} stackId="a" fill={c.palette[i % c.palette.length]} radius={i === series.length - 1 ? [4, 4, 0, 0] : 0} />
          ))}
          {zoom.overlay}
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}

// 단위가 다른 두 지표를 한 화면에 — "도입률"(사용자 vs 세션), "사용자당 PR"처럼 좌/우 축이 다른 시계열.
// lines: [{key, label, color, axis: "left" | "right"}] — rows는 이미 xKey 기준으로 wide한 형태여야 함.
export function DualLineChart({ title, subtitle, right, rows, xKey, lines, height = 240, tickFormatter, bucketHours }) {
  const c = useChartColors();
  const zoom = useDragZoom("left", bucketHours); // 명명된 축(left/right) 중 left에 하이라이트를 붙인다.
  const hasRight = lines.some((l) => l.axis === "right");
  return (
    <Card title={title} subtitle={subtitle} right={right}>
      <ResponsiveContainer width="100%" height={height} className={zoom.className}>
        <LineChart data={rows || []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} {...zoom.handlers}>
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
          {zoom.overlay}
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
}

// 채움형 링 게이지 — 구성 비율을 보여주는 DonutBody와 달리 단일 비율(0~1)을 "그 %만큼만
// 링을 채워서" 보여준다(예: 96% → 링의 96%). Executive.jsx의 ScoreGauge와 같은 SVG 패턴이지만
// 점수 색 램프가 없다 — 색은 호출부가 주입(그룹 색 등).
export function RingGauge({ pct, color, label, sub }) {
  const r = 26, c = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(1, pct || 0));
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative h-24 w-24">
        <svg viewBox="0 0 64 64" className="h-24 w-24 -rotate-90">
          <circle cx="32" cy="32" r={r} fill="none" stroke="var(--ink-100)" strokeWidth="6" />
          <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${filled * c} ${c}`} />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center tabular text-[20px] font-semibold text-ink-800">
          {pct == null ? "—" : `${(filled * 100).toFixed(filled * 100 < 10 ? 1 : 0)}%`}
        </div>
      </div>
      <div className="text-[13px] font-semibold text-ink-600">{label}</div>
      {sub && <div className="text-[12px] text-ink-400 tabular">{sub}</div>}
    </div>
  );
}

// 도넛 본체 (Card 없음) — 한 카드에 도넛을 여러 개 넣을 때 직접 조합한다 (예: Cost의
// 모델별 지출 비중 bedrock/enterprise 나란히). colorOf(name, i)로 색을 넘기면 도넛 간에
// 같은 항목이 같은 색을 갖도록 밖에서 고정할 수 있다.
export function DonutBody({ label, data, nameKey, valueKey, valuePrefix = "", colorOf }) {
  const c = useChartColors();
  // colorOf가 전역 top-N에서 만든 고정 맵이면, 그 top-N 밖 모델이 이 도넛에 등장할 때
  // undefined를 반환할 수 있다 — Cell fill/범례 스와치가 깨지지 않도록 팔레트로 폴백한다
  // (리뷰에서 MINOR로 확인).
  const color = (name, i) => colorOf?.(name, i) ?? c.palette[i % c.palette.length];
  const total = data.reduce((s, d) => s + (Number(d[valueKey]) || 0), 0);
  // Math.round만 쓰면 짧은 기간의 소액 tier(몇 센트)가 전부 "$0"으로 보인다 — $10 미만은 소수 2자리.
  const fmt = (v) =>
    valuePrefix === "$"
      ? `$${Number(v) < 10 ? v.toFixed(2) : Math.round(v).toLocaleString()}`
      : v.toLocaleString();

  return (
    <div className="min-w-0">
      {label && <div className="mb-2 text-[12px] font-medium text-ink-600">{label}</div>}
      {/* 전역/로컬 group 필터가 서로 겹치지 않으면 데이터가 비는데, 빈 도넛만 렌더되면 로딩/버그처럼 보인다. */}
      {total <= 0 ? (
        <div className="flex h-[170px] items-center justify-center text-[13px] text-ink-400">표시할 데이터가 없습니다</div>
      ) : (
        <div className="flex items-center gap-4">
          <div className="relative shrink-0" style={{ width: 170, height: 170 }}>
            <PieChart width={170} height={170}>
              <Pie data={data} dataKey={valueKey} nameKey={nameKey} innerRadius={55} outerRadius={80} paddingAngle={2} stroke="none">
                {data.map((d, i) => (
                  <Cell key={i} fill={color(String(d[nameKey]), i)} />
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
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color(String(d[nameKey]), i) }} />
                <span className="min-w-0 flex-1 truncate text-ink-600">{String(d[nameKey])}</span>
                <span className="tabular shrink-0 font-medium text-ink-800">{fmt(Number(d[valueKey]))}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ../awsops DonutBreakdown 포팅 — innerRadius 55/outerRadius 80, 중앙 합계 라벨 + 사이드 범례.
export function DonutBreakdown({ title, subtitle, right, data, nameKey, valueKey, valuePrefix = "" }) {
  return (
    <Card title={title} subtitle={subtitle} right={right}>
      <DonutBody data={data} nameKey={nameKey} valueKey={valueKey} valuePrefix={valuePrefix} />
    </Card>
  );
}

// ../awsops HBarList 포팅 — recharts 아님, label / 트랙+채움 / 우측 정렬 금액의 단순 flex 리스트.
// color: 지정하면 채움 막대를 브랜드색 대신 그 색으로(예: 그룹별로 나란히 놓은 카드에서 colorFor(group)).
export function HBarList({ title, subtitle, right, data, labelKey, valueKey, valuePrefix = "", color }) {
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
                <span
                  className={cn("block h-full rounded-full", !color && "bg-brand-500")}
                  style={{ width: `${pct}%`, ...(color ? { backgroundColor: color } : {}) }}
                />
              </span>
              <span className="tabular w-20 shrink-0 text-right text-[12px] font-medium text-ink-800">{fmt(n)}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
