import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, ErrorBox, Loading } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { Badge } from "../components/Badge.jsx";
import { SectionLabel } from "../components/SectionLabel.jsx";
import { DualLineChart } from "../components/GroupCharts.jsx";
import { axisTick, tooltipStyles, useChartColors } from "../useChartColors.js";
import { formatClientCost, formatObserved } from "../clientUsage.js";
import { basisLabel, clientName, formatClientTime, formatPercent } from "../clientPresentation.js";
import { maskEmail } from "../fmt.js";
import { Download } from "lucide-react";
import { useRange } from "../RangeContext.jsx";
import { useConfig } from "../ConfigContext.jsx";
import { csvFilename, downloadCsv, toCsv } from "../csv.js";
import { BUNDLE_COLOR_VARS, BUNDLE_HELP, BUNDLE_LABELS, BUNDLE_OF, NOT_OBSERVED_LABEL, REASON_HELP, TERM_LABELS, TERMS,
  changePct, exemplarBars, reasonLabel, responseWindowMatches, waterfallSteps } from "../tokenEconomics.js";

// Shared Productivity: the token-economics cost equation (docs/metrics.md#token-economics).
// Every number comes from /api/clients/token-economics; an unavailable value renders its
// reason, never a number or $0. Activity telemetry only: not employee productivity or ROI.

const finite = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const money = (v) => formatClientCost(finite(v));
const signedMoney = (v) => {
  const n = finite(v);
  return n === null ? "—" : `${n < 0 ? "−" : "+"}${formatClientCost(Math.abs(n))}`;
};
const pctText = (p) => (p === null ? "—" : `${p < 0 ? "−" : "+"}${Math.abs(p).toFixed(1)}%`);
const percentOf = (fraction) => (finite(fraction) === null ? null : finite(fraction) * 100);
const tint = (kind, amount) => `color-mix(in srgb, var(${BUNDLE_COLOR_VARS[kind]}) ${amount}%, var(--surface-card))`;
const border = (kind) => `color-mix(in srgb, var(${BUNDLE_COLOR_VARS[kind]}) 45%, transparent)`;

function ReasonBadge({ reason, label = reasonLabel(reason) }) {
  return <Badge tone="neutral" className="text-[11px]">{label || "—"}</Badge>;
}
function Unavailable({ reason }) {
  return <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-ink-600">
    <ReasonBadge reason={reason} />
    <span>{REASON_HELP[reason] || "계산할 수 없습니다."}</span>
  </p>;
}

const termValue = (term, chain) => term === "cost_per_token" ? money(chain.cost_per_million_tokens)
  : formatObserved(chain.factors?.[term]);

function BundleLegend() {
  return <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-600" aria-label="묶음 범례">
    {Object.entries(BUNDLE_LABELS).map(([kind, label]) => <span key={kind} className="inline-flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: `var(${BUNDLE_COLOR_VARS[kind]})` }} />
      {label} ({BUNDLE_HELP[kind]})
    </span>)}
  </div>;
}

function coverageText(coverage) {
  if (!coverage) return null;
  const known = finite(coverage.cost_known), matched = finite(coverage.cost_matched);
  const excluded = known !== null && known > 0 && matched !== null ? (known - matched) / known * 100 : null;
  return `세션·턴·요청·토큰·비용이 모두 관측된 세션 ${formatObserved(coverage.matched_sessions)}/${formatObserved(coverage.sessions)}개 · 제외 비용 ${formatPercent(excluded)}`;
}
const excludedText = (e = {}) => `제외 세션: 턴 없음 ${formatObserved(e.no_turns)} · 요청 없음 ${formatObserved(e.no_requests)} · 비용 불완전 ${formatObserved(e.cost_incomplete)} · 토큰 무효 ${formatObserved(e.tokens_invalid)}`;

const Operator = ({ children }) => <span aria-hidden="true" className="self-center px-0.5 text-lg text-ink-400">{children}</span>;

// ① Six tiles joined by ×, = total. Δ% compares each factor with the previous window.
function EquationStrip({ row }) {
  const name = clientName(row.client);
  const reason = row.unavailable?.chain || (row.current ? null : "no_matched_sessions");
  const cur = reason ? null : row.current, prev = reason ? null : row.previous;
  const previousHint = reasonLabel("no_previous");
  const hint = (p, c) => (prev ? `직전 대비 ${pctText(changePct(p, c))}` : previousHint);
  const tiles = TERMS.map((term) => <StatTile key={term} label={TERM_LABELS[term]}
    value={cur ? termValue(term, cur) : <ReasonBadge reason={reason} />}
    hint={cur ? hint(prev?.factors?.[term], cur.factors?.[term]) : undefined}
    className="min-w-[8.5rem] flex-1" style={{ borderColor: border(BUNDLE_OF[term]), background: tint(BUNDLE_OF[term], 7) }} />);
  const curCost = finite(cur?.cost), prevCost = finite(prev?.cost);
  const change = cur && prev ? (curCost !== null && prevCost !== null
    ? `직전 대비 ${signedMoney(curCost - prevCost)} (${pctText(changePct(prevCost, curCost))})` : "직전 대비 —")
    : cur ? previousHint : undefined;
  return <div role="group" aria-label={`${name} 비용 방정식`} className="flex flex-col gap-2">
    <div className="text-sm font-semibold text-ink-800">{name} · {basisLabel(row.cost_basis)}</div>
    <div className="flex flex-wrap items-stretch gap-1.5">
      {tiles.flatMap((tile, i) => i === 0 ? [tile] : [<Operator key={`x${i}`}>×</Operator>, tile])}
      <Operator>=</Operator>
      <StatTile label="총 비용" value={cur ? money(cur.cost) : <ReasonBadge reason={reason} />} hint={change}
        variant="accent" className="min-w-[9rem] flex-1" style={{ background: tint("total", 8) }} />
    </div>
    {reason && <Unavailable reason={reason} />}
    {row.coverage && <div className="text-[12px] text-ink-500">
      <p>{coverageText(row.coverage)}</p>
      <p>{excludedText(row.coverage.excluded)}</p>
    </div>}
  </div>;
}

// ② Previous cost → six signed contributions → current cost (transparent stacked base).
// `fallback` is the reason shown when the decomposition itself is missing (no server row).
function Waterfall({ title, subtitle, previousCost, decomposition, fallback }) {
  const c = useChartColors();
  const reason = decomposition?.unavailable;
  const steps = reason ? [] : waterfallSteps(previousCost, decomposition);
  if (steps.length === 0) return <Card title={title} subtitle={subtitle}><Unavailable reason={reason || fallback || "no_previous"} /></Card>;
  const fill = { growth: c.palette[0], waste: c.palette[3], price: c.palette[2], total: c.axis };
  const data = steps.map((s) => ({ ...s, size: Math.abs(s.value) }));
  const stepText = (s) => (s.kind === "total" ? money(s.value) : signedMoney(s.value));
  const bundles = decomposition.bundles || {};
  return <Card title={title} subtitle={subtitle}
    help="LMDI 가법 분해: 항목별 기여의 합이 총 변동과 같습니다. 순서에 따라 값이 달라지지 않습니다.">
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ left: 8, right: 8 }}>
        <CartesianGrid strokeDasharray="2 4" stroke={c.grid} vertical={false} />
        <XAxis dataKey="label" interval="preserveStartEnd" minTickGap={8} tick={axisTick(c)} tickLine={false} axisLine={{ stroke: c.grid }} />
        <YAxis tick={axisTick(c)} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => money(v)} />
        <Tooltip {...tooltipStyles(c)} cursor={{ fill: c.grid, opacity: 0.4 }}
          formatter={(_, __, item) => [stepText(item.payload), "금액"]} />
        <Bar dataKey="base" stackId="waterfall" fill="transparent" tooltipType="none" isAnimationActive={false} />
        <Bar dataKey="size" stackId="waterfall" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {data.map((d) => <Cell key={d.key} fill={fill[d.kind]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
    <ol aria-label="드라이버 분해 단계" className="mt-2 grid grid-cols-4 gap-1 text-center text-[11px] text-ink-600 sm:grid-cols-8">
      {steps.map((s) => <li key={s.key} className="flex flex-col">
        <span>{s.label}</span>
        <span className="tabular font-semibold text-ink-800">{stepText(s)}</span>
      </li>)}
    </ol>
    <p className="mt-3 text-sm text-ink-700">
      <span className="font-semibold">요약 </span>
      <span>{`성장 ${signedMoney(bundles.growth)} · 낭비 ${signedMoney(bundles.waste)} · 단가 ${signedMoney(bundles.price)}`}</span>
    </p>
  </Card>;
}

const WATERFALL_SUBTITLE = "직전 기간 대비 변동을 항목별 금액으로 나눕니다(합 = 총 변동).";
const decompositionReason = (row) => row.decomposition?.unavailable || row.unavailable?.decomposition
  || row.unavailable?.chain || "no_previous";
const ClientWaterfall = ({ row }) => <Waterfall title={`${clientName(row.client)} 드라이버 분해`}
  subtitle={`${WATERFALL_SUBTITLE} 비용 기준: ${basisLabel(row.cost_basis)}`}
  previousCost={row.previous?.cost} decomposition={row.decomposition} fallback={decompositionReason(row)} />;

// Clients whose decomposition blocks the combined one: the server's list, else derived from the rows.
function blockingClients(combined, rows) {
  if (Array.isArray(combined?.unavailable_clients) && combined.unavailable_clients.length > 0) return combined.unavailable_clients;
  return rows.filter((row) => !row.decomposition || row.decomposition.unavailable)
    .map((row) => ({ client: row.client, reason: decompositionReason(row) }));
}

// Multi-client ②: the combined waterfall, or, when any client blocks it, the blocking clients
// and each client's own waterfall. The combined sum stays unavailable, never zero.
function CombinedDrivers({ combined, rows, bases }) {
  const title = "합계 드라이버 분해";
  const subtitle = `${WATERFALL_SUBTITLE} 비용 기준: ${bases} · 서로 다른 기준의 합계입니다.`;
  const blocked = blockingClients(combined, rows);
  if (blocked.length === 0 && waterfallSteps(combined?.previous_cost, combined?.decomposition).length > 0) {
    return <Waterfall title={title} subtitle={subtitle} previousCost={combined.previous_cost} decomposition={combined.decomposition} />;
  }
  const cost = finite(combined?.cost);
  return <>
    <Card title={title} subtitle={subtitle}>
      {blocked.length > 0 ? <div role="status" className="flex flex-col gap-2 text-sm text-ink-600">
        <p className="flex flex-wrap items-center gap-2">
          <span>합계 분해는 모든 클라이언트의 분해가 있어야 계산합니다. 막는 클라이언트:</span>
          {blocked.map((b) => <ReasonBadge key={b.client} label={`${clientName(b.client)}: ${reasonLabel(b.reason) || "—"}`} />)}
        </p>
        <p>아래에 클라이언트별 분해를 표시합니다.</p>
      </div> : <Unavailable reason={combined?.decomposition?.unavailable || "no_previous"} />}
      {cost !== null && <p className="mt-2 text-sm text-ink-700">{`이번 기간 대상 세션 비용 합계 ${money(cost)}`}</p>}
    </Card>
    <div className="grid gap-4 2xl:grid-cols-2">
      {rows.map((row) => <ClientWaterfall key={row.client} row={row} />)}
    </div>
  </>;
}

// ③ Unit economics over the current window's buckets; null buckets stay gaps ("미확인").
// Bucket starts are numeric UTC instants on a time domain (the response's effective range),
// as in ClientTrend, so an observation between two empty buckets still draws its marker.
const moneyTick = (v) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const numberTick = (v) => Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const trendTooltip = (value, _, item) => item?.dataKey === "cache_hit_pct" ? formatPercent(value)
  : item?.dataKey === "tokens_per_request" ? formatObserved(value) : money(value);
function trendTimeDomain(rows, effectiveRange, bucketHours) {
  const from = Date.parse(effectiveRange?.from), to = Date.parse(effectiveRange?.to);
  if (Number.isFinite(from) && Number.isFinite(to) && from < to) return [from, to];
  return rows.length ? [rows[0].t, rows.at(-1).t + bucketHours * 3600000] : undefined;
}
function UnitTrend({ row, bucketHours, effectiveRange, stale }) {
  const name = clientName(row.client);
  if (!Array.isArray(row.trend)) return <Card title={`${name} · 단위 경제 추이`}>
    <Unavailable reason={row.unavailable?.chain || "no_matched_sessions"} />
  </Card>;
  const rows = row.trend.map((p) => ({ t: Date.parse(p.t), cost_per_user: finite(p.cost_per_user),
    cost_per_session: finite(p.cost_per_session), cost_per_1k_requests: finite(p.cost_per_1k_requests),
    tokens_per_request: finite(p.tokens_per_request), cache_hit_pct: percentOf(p.cache_hit_rate) }))
    .filter((p) => Number.isFinite(p.t));
  const timeDomain = trendTimeDomain(rows, effectiveRange, bucketHours);
  const tickFormatter = formatClientTime;
  return <div className="grid gap-4 xl:grid-cols-2">
    <DualLineChart title={`${name} · 단위 비용 추이`} subtitle={`비용 기준: ${basisLabel(row.cost_basis)} · 대상 세션 기준`}
      rows={rows} xKey="t" bucketHours={bucketHours} timeDomain={timeDomain} tickFormatter={tickFormatter} valueTickFormatter={moneyTick}
      tooltipFormatter={trendTooltip} zoomDisabled={stale}
      lines={[{ key: "cost_per_user", label: "사용자당 비용", axis: "left" },
        { key: "cost_per_session", label: "세션당 비용", axis: "left" },
        { key: "cost_per_1k_requests", label: "1,000요청당 비용", axis: "right" }]} />
    <DualLineChart title={`${name} · 요청 효율 추이`} subtitle="캐시 히트율 = 캐시 읽기 ÷ (입력 + 캐시 읽기 + 캐시 쓰기)"
      rows={rows} xKey="t" bucketHours={bucketHours} timeDomain={timeDomain} tickFormatter={tickFormatter} valueTickFormatter={numberTick}
      tooltipFormatter={trendTooltip} zoomDisabled={stale}
      lines={[{ key: "tokens_per_request", label: "요청당 토큰", axis: "left" },
        { key: "cache_hit_pct", label: "캐시 히트율 (%)", axis: "right" }]} />
  </div>;
}

// Rows of an unavailable client carry the reason; every measure renders it (CSV: the label).
const measure = (key, label, format = formatObserved) => ({ key, label,
  render: (value, row) => row.reason ? <ReasonBadge reason={row.reason} /> : format(value),
  toText: (value, row) => row.reason ? reasonLabel(row.reason) : value ?? "" });
const CLIENT = { key: "client", label: "클라이언트", render: clientName, toText: clientName };
const unavailableRow = (row) => ({ client: row.client, reason: row.unavailable?.chain || "no_matched_sessions" });

// A known cost subtotal (some matched sessions lack usage rows for the model) is labelled
// 부분합 in the table and the CSV (ADR-013); an unknown cost is —, never $0.
// The CSV keeps numeric amounts and counts; coverage is the separate 사용량 상태 column.
const partialMeasure = (key, label, format) => ({ key, label,
  render: (v, row) => row.reason ? <ReasonBadge reason={row.reason} />
    : <span className="inline-flex items-center gap-1.5">{format(v)}{row.cost_partial && v !== null && <Badge tone="warning">부분합</Badge>}</span>,
  toText: (v, row) => row.reason ? reasonLabel(row.reason) : v ?? "" });
const usageStatus = (row) => row.reason ? "" : row.cost === null ? "미확인" : row.cost_partial ? "부분합" : "확인됨";

// ④ Model economics over matched sessions.
export const MODEL_COLUMNS = [CLIENT,
  { key: "model", label: "모델", render: (v, row) => row.reason ? "—" : <span className="block min-w-[8rem] break-all">{v || "—"}</span>,
    toText: (v, row) => row.reason ? "" : v ?? "" },
  partialMeasure("cost", "비용 (USD)", money), measure("request_pct", "요청 점유율 (%)", formatPercent),
  measure("requests", "요청"), partialMeasure("tokens", "토큰", formatObserved),
  partialMeasure("cost_per_million_tokens", "$ / 100만 토큰", money),
  { key: "small", label: "소형 모델", render: (v, row) => row.reason ? "—" : v ? <Badge tone="brand">소형</Badge> : "—",
    toText: (v, row) => row.reason ? "" : v ? "소형" : "" },
  { key: "usage_status", label: "사용량 상태", render: (v, row) => row.reason ? "—" : v,
    toText: (v, row) => row.reason ? "" : v }];
export function modelRows(rows) {
  return rows.flatMap((row) => !Array.isArray(row.models) ? [unavailableRow(row)]
    : row.models.map((m) => ({ client: row.client, model: m.model, cost: finite(m.cost),
      cost_partial: m.cost_partial === true && finite(m.cost) !== null, requests: finite(m.requests),
      request_pct: percentOf(m.request_share), tokens: finite(m.tokens),
      cost_per_million_tokens: finite(m.cost_per_million_tokens), small: m.small === true }))
      .map((m) => ({ ...m, usage_status: usageStatus(m) })));
}

// ⑤ Outcome cost. A ratio without its count is unavailable; with an observed count but no
// denominator it is "—". Codex has no outcome counters in default OTel.
const OUTCOMES = [
  { key: "commits", label: "커밋" }, { key: "prs", label: "PR" }, { key: "loc_added", label: "추가 라인" },
  { key: "cost_per_commit", label: "커밋당 비용", count: "commits", format: money },
  { key: "cost_per_pr", label: "PR당 비용", count: "prs", format: money },
  { key: "cost_per_kloc", label: "1,000줄당 비용", count: "loc_added", format: money }];
function outcomeCell(row, metric) {
  const reason = row.unavailable?.outcome;
  if (reason) return { status: reasonLabel(reason) };
  if (!row.outcome) return { status: reasonLabel(row.unavailable?.chain) || NOT_OBSERVED_LABEL };
  const value = finite(row.outcome[metric.key]);
  if (value === null) return finite(row.outcome[metric.count ?? metric.key]) === null ? { status: NOT_OBSERVED_LABEL } : { text: "—" };
  const pct = changePct(row.previous_outcome?.[metric.key], value);
  return { text: `${(metric.format || formatObserved)(value)}${pct === null ? "" : ` (${pctText(pct)})`}` };
}
function outcomeTable(rows) {
  const columns = [{ key: "label", label: "항목" }, ...rows.map((row) => ({ key: row.client, label: clientName(row.client),
    render: (cell) => cell.status ? <ReasonBadge label={cell.status} /> : cell.text,
    toText: (cell) => cell.status ?? cell.text }))];
  const items = OUTCOMES.map((metric) => ({ label: metric.label,
    ...Object.fromEntries(rows.map((row) => [row.client, outcomeCell(row, metric)])) }));
  return { columns, items };
}

// ⑥ Exemplar users: whom to ask about their habits, not a spend ranking.
const LEVERS = {
  tokens_per_request: { label: "토큰 / 요청", format: formatObserved },
  requests_per_turn: { label: "요청 / 턴", format: formatObserved },
  cache_hit_rate: { label: "캐시 히트율", format: (v) => formatPercent(percentOf(v)) },
  small_model_share: { label: "소형 모델 요청 비중", format: (v) => formatPercent(percentOf(v)) },
};
const DIRECTION = { lower: "낮을수록", higher: "높을수록" };
const leverFormat = (row) => LEVERS[row.lever]?.format || formatObserved;
// Difference from the median: percent of it, or percentage points for rate levers.
const deltaText = (delta, unit) => {
  if (delta === null) return "—";
  const abs = Math.abs(delta);
  if (abs < 0.005) return unit === "pt" ? "±0%p" : "±0%";
  return `${delta < 0 ? "−" : "+"}${abs.toFixed(abs > 0 && abs < 1 ? 2 : 1)}${unit === "pt" ? "%p" : "%"}`;
};
// Codex has no commit counters; a Claude user without commit evidence is not zero.
const commitsStatus = (row, commits) => row.unavailable?.outcome ? reasonLabel(row.unavailable.outcome)
  : finite(commits) === null ? NOT_OBSERVED_LABEL : null;
// CSV keeps the median and the difference the chart draws.
export const EXEMPLAR_COLUMNS = [CLIENT,
  { key: "lever", label: "레버", toText: (v, row) => row.reason ? "" : `${LEVERS[v]?.label || v} (${DIRECTION[row.direction] || ""})` },
  { key: "median", label: "중앙값 (적격 사용자)", toText: (v, row) => row.reason ? reasonLabel(row.reason) : v ?? "" },
  // No toText: csv.js masks the user column itself.
  { key: "user", label: "사용자" },
  { key: "value", label: "값", toText: (v) => v ?? "" },
  { key: "delta", label: "중앙값 대비", toText: (v, row) => row.reason || v === null || v === undefined ? "" : deltaText(v, row.unit) },
  measure("sessions", "세션"), measure("turns", "턴"),
  { key: "commits", label: "커밋", toText: (v, row) => row.reason ? "" : row.commits_status ?? v ?? "" }];
export function exemplarRows(rows) {
  return rows.flatMap((row) => {
    if (!row.exemplars) return [unavailableRow(row)];
    return (row.exemplars.levers || []).flatMap((lever) => {
      const { unit, median, bars } = exemplarBars(lever);
      const base = { client: row.client, lever: lever.lever, direction: lever.direction, median, unit };
      if (bars.length === 0) return [{ ...base, user: "", value: null, delta: null, sessions: null, turns: null, commits: null }];
      return bars.map((u) => ({ ...base, user: u.user, value: u.value, delta: u.delta, sessions: finite(u.sessions),
        turns: finite(u.turns), commits: finite(u.commits), commits_status: commitsStatus(row, u.commits) }));
    });
  });
}

// One lever: the dashed line is the eligible users' median and the better side is always right.
function LeverBars({ row, lever }) {
  const { unit, median, bars } = exemplarBars(lever);
  const label = LEVERS[lever.lever]?.label || lever.lever;
  const format = leverFormat(lever);
  const name = `${clientName(row.client)} ${label} 중앙값 대비`;
  return <div className="flex min-w-0 flex-col gap-2">
    <div>
      <div className="text-[13px] font-semibold text-ink-800">{label}</div>
      <div className="text-[12px] text-ink-500">{`중앙값 ${median === null ? "—" : format(median)} · ${DIRECTION[lever.direction] || ""} 좋음`}</div>
    </div>
    {bars.length === 0 ? <p className="text-[12px] text-ink-500">해당 사용자 없음</p> : <ul aria-label={name} className="flex flex-col gap-1.5">
      {bars.map((b) => {
        const commits = commitsStatus(row, b.commits) ?? formatObserved(finite(b.commits));
        const color = b.better === null ? "var(--ink-400)" : b.better ? "var(--positive)" : "var(--warning)";
        const left = b.better === false ? 50 - b.width : 50;
        return <li key={b.user} data-better={b.better === null ? undefined : String(b.better)}
          title={`세션 ${formatObserved(finite(b.sessions))} · 턴 ${formatObserved(finite(b.turns))} · 커밋 ${commits}`}
          className="grid grid-cols-[minmax(0,10rem)_minmax(4rem,1fr)_10.5rem] items-center gap-2 text-[12px]">
          <span className="truncate text-ink-700">{maskEmail(b.user)}</span>
          <span aria-hidden="true" className="relative h-3.5 rounded bg-ink-100">
            <span className="absolute -top-1 -bottom-1 left-1/2 border-l-2 border-dashed border-ink-400" />
            <span className="absolute top-0.5 bottom-0.5 rounded-sm" style={{ left: `${left}%`, width: `${b.width}%`, background: color }} />
          </span>
          <span className="whitespace-nowrap text-right tabular-nums text-ink-700">{`${format(b.value)} · ${deltaText(b.delta, unit)}`}</span>
        </li>;
      })}
    </ul>}
  </div>;
}

function Exemplars({ rows, multi, eligible, stale }) {
  const range = useRange();
  const { piiMask } = useConfig();
  const csvRows = exemplarRows(rows);
  const csv = <button type="button" disabled={stale || csvRows.length === 0}
    onClick={() => downloadCsv(csvFilename("clients_token_economics_exemplars", range?.from, range?.to), toCsv(EXEMPLAR_COLUMNS, csvRows, { piiMask }))}
    className="flex items-center gap-1 rounded-md bg-brand-50 px-2 py-1 text-[11px] font-medium text-brand-700 whitespace-nowrap hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-40"
    title={stale ? "새 기간의 데이터를 불러오는 중에는 내보낼 수 없습니다" : "현재 차트의 값을 CSV로 내려받기"}>
    <Download size={12} />CSV
  </button>;
  return <Card title="모범 사용자" subtitle="최소 활동량(세션 5개·턴 20개) 충족 사용자만 · 연락해 사용 방식을 공유받는 용도이며 성과 평가가 아닙니다"
    help={`레버별 적격 사용자 중 상위 10명을 적격 사용자 중앙값과 비교합니다. 점선이 중앙값이며 오른쪽이 좋은 방향입니다. 비율 레버는 %p 차이입니다. 적격 사용자: ${eligible}. 표시는 PII 마스킹 설정을 따릅니다.`}
    right={csv}>
    <div className="flex flex-col gap-6">
      {rows.map((row) => <section key={row.client} aria-label={`${clientName(row.client)} 모범 사용자`} className="flex flex-col gap-3">
        {multi && <h3 className="text-[13px] font-semibold text-ink-700">{clientName(row.client)}</h3>}
        {row.exemplars ? <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
          {(row.exemplars.levers || []).map((lever) => <LeverBars key={lever.lever} row={row} lever={lever} />)}
        </div> : <Unavailable reason={row.unavailable?.chain || "no_matched_sessions"} />}
      </section>)}
    </div>
  </Card>;
}

export default function TokenEconomics({ api, range, clients, stale = false }) {
  const data = api?.data;
  // Pending: a stale hook or overview, or a response for another window (stale treatment).
  const pending = stale || api?.stale === true || Boolean(data && !responseWindowMatches(range, data.effective_range));
  const multi = clients.length > 1;
  let body;
  if (api?.error) body = <Card><ErrorBox error={api.error} /></Card>;
  else if (!data || api?.loading || pending) body = <Card><Loading /></Card>;
  else {
    const rows = clients.map((client) => (data.by_client || []).find((row) => row.client === client)
      || { client, unavailable: { chain: "no_matched_sessions" } });
    const bases = [...new Set(rows.map((row) => basisLabel(row.cost_basis)))].join(" + ");
    const single = rows[0];
    const { columns: outcomeColumns, items: outcomeItems } = outcomeTable(rows);
    const eligible = rows.map((row) => `${clientName(row.client)} ${row.exemplars ? `${formatObserved(row.exemplars.eligible_users)}명` : reasonLabel(row.unavailable?.chain) || "—"}`).join(" · ");
    body = <>
      <SectionLabel>토큰 경제 · 비용 방정식</SectionLabel>
      <Card title="비용 방정식" subtitle="총 비용 = 활성 사용자 × 세션/사용자 × 턴/세션 × 요청/턴 × 토큰/요청 × 토큰당 단가 · 직전 같은 길이 기간 대비"
        help="여섯 항목은 세션·턴·요청·토큰·비용이 모두 관측된 같은 세션 집합에서 계산해 곱이 총 비용과 같습니다. 활동 텔레메트리이며 직원 생산성이나 ROI가 아닙니다.">
        <div className="flex flex-col gap-4">
          <BundleLegend />
          <div className={`grid gap-6 ${multi ? "2xl:grid-cols-2" : ""}`}>
            {rows.map((row) => <EquationStrip key={row.client} row={row} />)}
          </div>
        </div>
      </Card>
      <SectionLabel>토큰 경제 · 드라이버 분해</SectionLabel>
      {multi ? <CombinedDrivers combined={data.combined} rows={rows} bases={bases} /> : <ClientWaterfall row={single} />}
      <SectionLabel>토큰 경제 · 단위 경제 추이</SectionLabel>
      {rows.map((row) => <UnitTrend key={row.client} row={row} bucketHours={Number(data.bucket_hours) || 1}
        effectiveRange={data.effective_range} stale={pending} />)}
      <SectionLabel>토큰 경제 · 모델 · 성과</SectionLabel>
      <div className="grid gap-4 xl:grid-cols-2">
        <DataTable title="모델 경제" subtitle="대상 세션 기준 · 비용 순. 요청 점유율은 클라이언트 안에서의 비중입니다."
          help="소형 모델은 서버의 모델 등급 목록(예: Haiku)에 있는 모델이며, 목록에 없는 모델은 소형으로 보지 않습니다. 요청은 있으나 사용량 카운터가 없는 모델의 비용·토큰은 —, 일부 세션만 확인된 비용은 부분합으로 표시합니다."
          columns={MODEL_COLUMNS} rows={modelRows(rows)} exportName="clients_token_economics_models" stale={pending} />
        <DataTable title="성과 단위 비용" subtitle="관측된 텔레메트리 활동 기준 · 머지된 PR/검증된 성과 아님"
          help="Claude Code 커밋·PR·추가 라인 카운터 증가량을 대상 세션에 한정합니다. 되돌림률·리뷰 수락 같은 품질 지표는 없습니다. 괄호는 직전 기간 대비 변화입니다."
          columns={outcomeColumns} rows={outcomeItems} exportName="clients_token_economics_outcome" stale={pending} />
      </div>
      <SectionLabel>토큰 경제 · 모범 사용자</SectionLabel>
      <Exemplars rows={rows} multi={multi} eligible={eligible} stale={pending} />
    </>;
  }
  return <section aria-label="토큰 경제" data-token-economics className="flex flex-col gap-4">{body}</section>;
}
