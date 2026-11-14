import { richMessage, localize, translate, translateSource, useLocale } from "../i18n/index.js";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, ErrorBox, Loading } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { RingGauge, SeriesBarChart } from "../components/GroupCharts.jsx";
import { ModelCostTrend } from "../components/ModelCostTrend.jsx";
import { SectionLabel } from "../components/SectionLabel.jsx";
import { SegmentedControl } from "../components/SegmentedControl.jsx";
import { clientColor as color, ClientTrend as Trend, EMPTY_VALUE } from "../components/ClientTrend.jsx";
import { UserDetail } from "../components/UserDetail.jsx";
import { combineUsers } from "../userDetail.js";
import { fromByModelTime, rollupBuckets } from "../modelCostTrend.js";
import { useRange } from "../RangeContext.jsx";
import { useApi } from "../useApi.js";
import { useFilters } from "../FilterContext.jsx";
import { costResolutionLabel } from "../costResolution.js";
import { maskEmail } from "../fmt.js";
import { formatClientCost, formatObserved } from "../clientUsage.js";
import { withoutZeroTokenModels } from "../modelRows.js";
import { teamSuffix, useTeams, withTeamColumn, withTeams } from "../TeamsContext.jsx";
import { CostUsers } from "./ClientCostUsers.jsx";
import { productivitySections } from "./ClientProductivity.jsx";
import {
  basisLabel, clientName, costBasisLabel, formatClientTime, formatClientTimestamp, formatPercent, observedNumber, OBSERVED_TOKEN_HELP, presentationRow,
  tokenStatusLabel,
} from "../clientPresentation.js";

const text = (v) => v || "—";
const number = (key, label) => ({ key, label, render: formatObserved });
const percent = (key, label) => ({ key, label, render: formatPercent });
const money = (key, label) => ({ key, label, render: formatClientCost });
const CLIENT = localize({ key: "client", label: "클라이언트", render: clientName, toText: clientName });
const BACKEND = localize({ key: "backend", label: "백엔드", render: text });
const MODEL = localize({ key: "model", label: "모델", render: text });
const USER = localize({ key: "user", label: "사용자", render: (v) => maskEmail(v) || translate("m4083695f59ed") });
const BASIS = localize({ key: "cost_basis_label", label: "비용 기준",
  render: (value) => <span className="block min-w-[10rem]">{text(value)}</span>, toText: text });
const COST = localize(money("cost_usd", "비용 (USD)"));
const TOKENS = localize(number("observed_tokens", "관측 토큰"));
const TOKEN_STATUS = localize({ key: "token_status", label: "토큰 상태", render: text });
const withTokenStatus = (columns) => columns.flatMap((column) => column === TOKENS ? [column, TOKEN_STATUS] : [column]);
const SESSIONS = localize(number("sessions", "세션"));
const USERS = localize(number("users", "관측 사용자 ID"));
const COST_SESSION = localize(money("cost_per_session", "세션당 비용 (USD)"));
const COST_USER = localize(money("cost_per_user", "사용자당 비용 (USD)"));
const TOKEN_SESSION = localize(number("tokens_per_session", "세션당 토큰"));
const SESSION_USER = localize(number("sessions_per_user", "사용자당 세션"));
const MILLION = localize(money("usd_per_million_tokens", "100만 토큰당 비용 (USD)"));
const CACHE = localize(percent("cache_read_pct", "캐시 읽기 / 전체 입력 (%)"));
const REASONING = localize(percent("reasoning_pct", "추론 / 출력 (%)"));
const REQUESTS = localize(number("requests", "API 요청"));
const ERRORS = localize(number("api_errors", "API 오류 기록"));
const TOOL_CALLS = localize(number("tool_calls", "도구 호출"));
const TOOL_ERRORS = localize(number("tool_errors", "도구 오류"));
const ERROR_RATIO = localize(number("error_records_per_request", "오류 기록 / 요청"));
const REQUEST_TIME = localize(number("request_duration_ms", "평균 API 요청 시간 (ms)"));
const TTFT = localize(number("ttft_ms", "평균 첫 토큰 시간 (ms)"));
const TOKEN_PARTS = localize([
  number("input_tokens", "입력 (캐시 제외)"), number("cache_read_tokens", "캐시 읽기"),
  number("cache_write_tokens", "캐시 쓰기"), number("output_tokens", "출력 (추론 포함)"),
]);
const REASONING_TOKENS = localize(number("reasoning_tokens", "추론 (출력의 일부)"));
const USAGE = [SESSIONS, TOKENS, ...TOKEN_PARTS, REASONING_TOKENS, COST, BASIS];
const UNIT_COSTS = [COST, COST_SESSION, COST_USER, MILLION, BASIS];
const OPERATIONS = [REQUESTS, ERRORS, ERROR_RATIO, TOOL_CALLS, TOOL_ERRORS, REQUEST_TIME, TTFT];
const GRID = "grid grid-cols-2 xl:grid-cols-4 gap-4";
const TOKEN_HELP = "구성값은 기존 전체 토큰 기준입니다: 입력(캐시 제외) + 캐시 읽기 + 캐시 쓰기 + 출력. 추론은 출력에 포함됩니다. 관측 토큰과 집계 범위가 다를 수 있으며, 누락된 구성값은 —로 유지합니다.";
const COST_HELP = "미산정 기록은 제외하고 알려진 비용만 부분합으로 표시합니다. 단위 비용은 알려진 비용 / 관측된 분모의 근삿값이며, 비용이 모두 미산정이거나 분모가 없거나 0이면 —로 표시합니다.";

function Tiles({ row, columns, basis }) {
  const _locale = useLocale();
  return <div className={GRID}>
    {columns.map((c) => <StatTile key={c.key} label={c.label} value={c.render(row[c.key])}
      variant={c.key === "cost_usd" ? "accent" : "default"}
      className={c.render === formatClientCost ? "[&_.truncate]:whitespace-normal" : undefined}
      hint={c === TOKENS ? row.token_status : c.render === formatClientCost ? basis : undefined}
      help={c === TOKENS ? translateSource(OBSERVED_TOKEN_HELP) : c.render === formatClientCost ? translateSource(COST_HELP) : undefined} />)}
  </div>;
}

function ResultTable({ rows, columns, subtitle, ...props }) {
  const _locale = useLocale();
  const [expanded, setExpanded] = useState(false);
  const truncated = rows.length > 20 && !expanded;
  const detail = rows.length > 20
    ? translate("ma7b8ab0da1f9", [truncated ? 20 : rows.length, rows.length])
    : undefined;
  return <DataTable {...props} columns={withTokenStatus(columns)} rows={truncated ? rows.slice(0, 20) : rows}
    subtitle={[subtitle, detail].filter(Boolean).join(" ") || undefined}
    right={rows.length > 20 ? <button type="button"
      className="text-[11px] font-medium text-brand-700 whitespace-nowrap"
      onClick={() => setExpanded((value) => !value)}>
      {expanded ? translate("m9ac43a97b2a3") : translate("m24714483a922", [rows.length])}
    </button> : undefined} />;
}

function Comparison({ rows, columns, cards = false, title = translate("mdf410c784328"), subtitle, stale = false }) {
  const _locale = useLocale();
  return <section aria-label={translate("maf4a21d13f0b")}>
    {cards ? <div className={`grid gap-4 ${rows.length > 1 ? "lg:grid-cols-2" : ""}`}>
      {rows.map((row) => <Card key={row.client} title={clientName(row.client)}
        subtitle={`${row.cost_basis_label} · ${text(row.backend)}${row.observed_records === 0 ? translate("m3c6970e3d9f2") : ""}`}
        className="border-t-2" right={<span className="block h-2 w-2 rounded-full mt-1" style={{ background: color(row.client) }} />}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          {columns.map((c) => <div key={c.key}>
            <dt className="text-[12px] text-ink-500">{c.label}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular text-ink-800">
              {c.render(row[c.key])}
              {c === TOKENS && <span className="ml-2 text-[11px] font-normal text-ink-500">{row.token_status}</span>}
            </dd>
          </div>)}
        </dl>
      </Card>)}
    </div> : <DataTable title={title} subtitle={subtitle} columns={[CLIENT, BACKEND, ...withTokenStatus(columns)]}
      rows={rows} exportName="clients_comparison" stale={stale} />}
  </section>;
}

const TREND_BASIS = localize({
  client_reported: "보고 비용", aws_list_estimate: "AWS 정가 추정",
  computed_estimate: "계산 추정 비용", mixed: "혼합 기준 비용",
});
const bucketLabel = costResolutionLabel;

// Cells are always rolled up, even to the source size, so the shared first bucket (keyed at
// `from`) is floored like every other bucket.
function ClientModelTrend({ data, client, hours, source, stale, dimension = "model" }) {
  const _locale = useLocale();
  const cells = useMemo(() => rollupBuckets(fromByModelTime(data, client, { dimension }), hours, { sourceHours: source }),
    [data, client, hours, source, dimension, _locale]);
  // The emitting client does not select its cost basis. Non-Anthropic Claude uses AWS estimates.
  const teams = useTeams();
  const userSuffix = useCallback((user) => teamSuffix(teams, user), [teams]);
  const sourceBasis = data?.by_client?.find((row) => row.client === client)?.cost_basis;
  const basis = `${client === "claude" ? "Claude" : clientName(client)} ${TREND_BASIS[sourceBasis] || translate("med5819dbf0d3")}`
    + (sourceBasis !== "computed_estimate" && cells?.some((c) => c.estimated) ? translate("m1b34acd1a0a6") : "");
  const noun = dimension === "user" ? translate("m1ac6e422b7dc") : translate("mf9f4d4113aa1");
  return <ModelCostTrend title={translate("ma2957473ba62", [clientName(client), noun])} basis={basis} cells={cells}
    xKey="t" bucketHours={hours} bounds={data?.effective_range} zoomDisabled={stale} accent={color(client)}
    dimension={dimension} userSuffix={dimension === "user" ? userSuffix : undefined} />;
}

// One card per selected, enabled client from the same response, so both share the effective range
// and bucket origins. Bases differ, so the cards are never summed and keep separate y-scales. The
// page-local bucket defaults to the global interval (exec: 24h up to 30 days, else 168h), cannot go
// below the response's bucket_hours, and a pick lasts until the range changes.
function ModelTrends({ data, clients, exec, stale }) {
  const _locale = useLocale();
  const { from, to, intervalHours } = useRange();
  const source = Number(data?.bucket_hours) > 0 ? Number(data.bucket_hours) : 1;
  const rangeKey = `${from.getTime()}|${to.getTime()}`;
  const [pick, setPick] = useState(null);
  const fallback = exec ? ((to - from) / 86400000 > 30 ? 168 : 24)
    : source >= 1 / 6 && source < 1 ? source : intervalHours;
  const hours = Math.max(source, pick?.key === rangeKey ? pick.hours : fallback);
  const options = [...new Set([source, hours, 1, 24, 168])].filter((h) => h >= source).sort((a, b) => a - b);
  const grid = `grid gap-4 ${clients.length > 1 ? "xl:grid-cols-2" : ""}`;
  // The user trend shares the model trend's bucket pick; both regroup the same usage records.
  return <>
    <section aria-label={translate("m1420cd83f327")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>{translate("m15e605f46a49")}</SectionLabel>
        <SegmentedControl options={options.map((h) => ({ value: String(h), label: bucketLabel(h) }))}
          value={String(hours)} onChange={(v) => setPick({ key: rangeKey, hours: Number(v) })} />
      </div>
      <div className={grid}>
        {clients.map((client) => <ClientModelTrend key={client} data={data} client={client}
          hours={hours} source={source} stale={stale} />)}
      </div>
    </section>
    <section aria-label={translate("ma53eddabd914")} className="flex flex-col gap-3">
      <SectionLabel>{translate("m296ca36fb22e", [bucketLabel(hours)])}</SectionLabel>
      <div className={grid}>
        {clients.map((client) => <ClientModelTrend key={client} data={data} client={client}
          hours={hours} source={source} stale={stale} dimension="user" />)}
      </div>
    </section>
  </>;
}

// Exact row identities stay local; the shared hook retains the active global filters.
function CostDetail({ selection, hours, parentRange, stale, onClose }) {
  const _locale = useLocale();
  const { backend: globalBackend } = useFilters();
  const teams = useTeams();
  const selectedBackend = selection.backend || globalBackend || "";
  const headingRef = useRef(null);
  useEffect(() => {
    headingRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    headingRef.current?.focus({ preventScroll: true });
  }, []);
  const params = { client: selection.client, intervalHours: hours, modelTime: "1", view: "cost", timeFormat: "compact",
    ...(parentRange?.from && parentRange?.to ? { from: parentRange.from, to: parentRange.to } : {}),
    ...(selection.kind === "user" ? { userExact: selection.user }
      : { modelExact: selection.model, backend: selectedBackend }) };
  const detail = useApi("/api/clients/overview", params, true,
    { linkedRange: Boolean(parentRange?.from && parentRange?.to), hold: stale });
  const title = selection.kind === "user" ? translate("m8e95438251d1", [maskEmail(selection.user), teamSuffix(teams, selection.user)])
    : translate("m73187230137d", [selection.model, text(selectedBackend)]);
  const pending = stale || detail.stale;
  const applied = detail.data?.applied_filters;
  const detailClients = selection.client === "all" ? detail.data?.clients || [] : [selection.client];
  const supported = selection.kind === "user" ? applied?.userExact === selection.user
    : applied?.modelExact === selection.model && applied?.backend === selectedBackend;
  const rows = (detail.data?.by_user || []).map(presentationRow);
  const total = observedNumber(detail.data?.totals?.cost_usd);
  const partial = detail.data?.totals?.cost_partial === true;
  const shares = rows.map((row) => ({ ...row,
    share: total !== null && total > 0 && row.cost_usd !== null ? row.cost_usd / total * 100 : null }));
  const rawClientRows = detail.data?.by_client || [];
  return <section aria-label={translate("m8d74f358aa22")} className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 ref={headingRef} tabIndex={-1}
        className="min-w-0 max-w-full flex-1 scroll-mt-6 [overflow-wrap:anywhere] text-base font-semibold text-ink-800">{title}</h2>
      <button type="button" onClick={onClose} className="rounded-md border border-ink-200 px-3 py-1 text-sm text-ink-700">{translate("mb60e04f43db2")}</button>
    </div>
    {detail.error ? <ErrorBox error={detail.error} /> : detail.loading || pending ? <Loading />
      : !supported ? <Card title={translate("m0515f4426203")}>
        <p role="alert" className="text-sm text-ink-700">{translate("m46cb49364f03")}</p>
      </Card> : <>
      {detail.data?.effective_range && <p className="text-[12px] text-ink-500">{richMessage("mec3f9d6d1182", [formatClientTimestamp(detail.data.effective_range.from), formatClientTimestamp(detail.data.effective_range.to)])}</p>}
      <Trend rows={detail.data?.timeseries || []} clients={detailClients}
        clientRows={rawClientRows} bucketHours={detail.data?.bucket_hours || hours}
        effectiveRange={detail.data?.effective_range} metric="cost" title={translate("m9d00ae05067d")} />
      {selection.kind === "model" && <ResultTable title={translate("m810a364d6ca5")}
        subtitle={translate("me48c633d15c2", [clientName(selection.client), partial ? translate("m1d42633eb6fd") : ""])}
        columns={withTeamColumn([USER, COST, percent("share", partial ? translate("mf955d46e6dfa") : translate("md95cd866a838")), BASIS, SESSIONS], teams)}
        rows={withTeams(shares, teams)} exportName="model_user_cost_shares" />}
      {selection.kind === "user" && <ModelTrends data={detail.data} clients={detailClients} />}
    </>}
  </section>;
}

const detailButton = (label, onClick, disabled) => <button type="button" disabled={disabled}
  className="text-left text-brand-700 underline decoration-brand-200 underline-offset-4 hover:decoration-brand-700 disabled:text-ink-500 disabled:no-underline"
  onClick={onClick}>{label}</button>;

// One row per identity across the selected clients (combineUsers). Costs of different bases are a
// known-cost total labelled with every contributing basis; the parts column keeps each client's
// own value and basis so the mix stays visible in the table and CSV.
const partText = (part) => `${clientName(part.client)} ${formatClientCost(part.cost_usd)} (${part.cost_basis_label})`;
function combinedUserRows(users, clients) {
  return combineUsers(users, clients).map((row) => {
    const parts = [...row.parts].sort((a, b) => a.client.localeCompare(b.client));
    const unpriced = parts.reduce((n, p) => n + (observedNumber(p.unpriced) ?? 0), 0);
    const bases = [...new Set(parts.map((p) => basisLabel(p.cost_basis)))].join(" + ");
    return { ...row, parts, token_status: tokenStatusLabel(row),
      cost_basis_label: costBasisLabel({ cost_usd: row.cost_usd, cost_partial: row.cost_partial, unpriced }, bases),
      client_parts: parts.map(partText).join(" / ") };
  });
}
const CLIENT_PARTS = localize({ key: "client_parts", label: "클라이언트별 구성",
  render: (value) => <span className="block min-w-[12rem]">{text(value)}</span>, toText: text });

// Change against the preceding window of the same length. Unknown on either side stays "—";
// a zero baseline has no percentage. Partial sums are labelled, never compared as complete.
const PERIOD_METRICS = [COST, TOKENS, SESSIONS, USERS];
function periodChange(current, previous) {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? "0%" : translate("m113ce17492d3");
  const pct = (current - previous) / previous * 100;
  return `${pct >= 0 ? "+" : ""}${Math.abs(pct) < 10 ? pct.toFixed(1) : pct.toFixed(0)}%`;
}
const previousRow = (previous, client) => {
  const row = (previous?.data?.by_client || []).find((r) => r.client === client);
  return row ? presentationRow(row) : null;
};
const baselinePending = (previous) => previous?.loading || previous?.stale;
const changeText = (previous, value) => previous?.error ? translate("m61b67c1d6c03") : baselinePending(previous) ? translate("m5b7e88929ec0") : value ?? "—";
// Either side partial: the change is labelled, never presented as a complete comparison.
const costPartial = (row) => row?.cost_partial === true || observedNumber(row?.unpriced) > 0;
const tokensPartial = (row) => row?.tokens_partial === true;
// Comparison rows carry the change as text columns so the table and its CSV show the same values.
function withPeriodChange(clientRows, previous) {
  return clientRows.map((row) => {
    const prev = previousRow(previous, row.client);
    const change = (key, partial) => {
      const value = prev ? periodChange(observedNumber(row[key]), observedNumber(prev[key])) : null;
      return changeText(previous, value !== null && partial ? translate("m2181ca3545d6", [value]) : value);
    };
    return { ...row,
      cost_change: change("cost_usd", costPartial(row) || costPartial(prev)),
      tokens_change: change("observed_tokens", tokensPartial(row) || tokensPartial(prev)),
      sessions_change: change("sessions"), users_change: change("users") };
  });
}
const CHANGE = (key, label) => ({ key, label, render: text });
const PERIOD_COMPARE = localize([COST, CHANGE("cost_change", "비용 증감"), TOKENS, CHANGE("tokens_change", "토큰 증감"),
  SESSIONS, CHANGE("sessions_change", "세션 증감"), USERS, CHANGE("users_change", "사용자 증감"), BASIS]);
function PeriodChange({ clientRows, previous }) {
  const _locale = useLocale();
  const before = (client) => previousRow(previous, client);
  return <section aria-label={translate("m97fe478cb1de")} className="flex flex-col gap-3">
    {clientRows.map((row) => {
      const prev = before(row.client);
      return <div key={row.client} className="flex flex-col gap-2">
        {clientRows.length > 1 ? <SectionLabel>{clientName(row.client)} · {row.cost_basis_label}</SectionLabel> : null}
        <div className={GRID}>
          {PERIOD_METRICS.map((metric) => {
            const current = observedNumber(row[metric.key]);
            const baseline = prev ? observedNumber(prev[metric.key]) : null;
            const partial = metric === COST ? costPartial(row) || costPartial(prev)
              : metric === TOKENS ? tokensPartial(row) || tokensPartial(prev) : false;
            const hint = previous?.error ? translate("m85b4a9b27d6e")
              : baselinePending(previous) ? translate("ma6b12b4c9525")
              : translate("m17b3a1c92395", [metric.render(prev ? prev[metric.key] : null), partial ? translate("m4bd689a8ae70") : ""]);
            return <StatTile key={metric.key} label={metric.label} value={metric.render(row[metric.key])}
              variant={metric === COST ? "accent" : "default"}
              trend={baselinePending(previous) || previous?.error ? undefined : periodChange(current, baseline) ?? undefined}
              hint={hint}
              help={metric === TOKENS ? translateSource(OBSERVED_TOKEN_HELP) : metric === COST ? translateSource(COST_HELP)
                : translate("me92dd344938d")} />;
          })}
        </div>
      </div>;
    })}
  </section>;
}

function ClientBars({ title, rows, metric, subtitle }) {
  const _locale = useLocale();
  return <SeriesBarChart title={title} subtitle={subtitle}
    rows={rows.map((row) => ({ ...row, label: clientName(row.client) }))}
    xKey="label" seriesKey="client" valueKey={metric.key} horizontal height={200}
    colorOf={color} seriesSort={(a, b) => a.localeCompare(b)} />;
}

function ToolTable({ rows, reliability = false, stale = false }) {
  const _locale = useLocale();
  const tools = rows.map((row) => {
    const calls = observedNumber(row.calls), duration = observedNumber(row.duration_ms);
    const derived = presentationRow({ tool_calls: calls, tool_errors: row.errors });
    return { ...row, calls, errors: observedNumber(row.errors), duration_ms: duration,
      mean_ms: calls > 0 && duration !== null ? duration / calls : null, tool_error_pct: derived.tool_error_pct };
  });
  return <ResultTable title={reliability ? translate("m22ab9e6cb5b4") : translate("m869276f91e7b")}
    subtitle={translate("m45bea1769924")}
    columns={[CLIENT, { key: "tool", label: translate("m36c416ead2ce"), render: text }, number("calls", translate("m7ed9c4cb0ba9")),
      number("errors", translate("mb49f20d86148")), percent("tool_error_pct", translate("mc6413895e3a1")),
      number("mean_ms", translate("m26dbd5722844")), number("duration_ms", translate("m78938e3bbddd"))]}
    rows={tools} exportName="clients_tools" stale={stale} />;
}

function Fractions({ rows }) {
  const _locale = useLocale();
  return <Card title={translate("m732e62530adf")}
    subtitle={translate("m7b17be2b7844")}>
    <div className={`grid gap-6 ${rows.length > 1 ? "lg:grid-cols-2" : ""}`}>
      {rows.map((row) => <div key={row.client}>
        <div className="text-sm font-semibold text-ink-800 mb-3">{clientName(row.client)}</div>
        <div className="flex flex-wrap justify-around gap-4">
          <RingGauge pct={row.cache_read_pct == null ? null : row.cache_read_pct / 100}
            color={color(row.client)} label={translate("ma0dcf49083dc")} sub={translate("mce6d4e952fa4", [formatObserved(row.cache_read_tokens), formatObserved(row.input_total)])} />
          <RingGauge pct={row.reasoning_pct == null ? null : row.reasoning_pct / 100}
            color={color(row.client)} label={translate("m89998f896613")} sub={translate("mce6d4e952fa4", [formatObserved(row.reasoning_tokens), formatObserved(row.output_tokens)])} />
        </div>
      </div>)}
    </div>
    <p className="mt-4 text-[12px] text-ink-500">{translate("m20ee0db8e83f")}</p>
  </Card>;
}

function ClientPanels({ page = "overview", data = {}, clients = data?.clients || [], stale = false, previous, breakdowns, productivity }) {
  const _locale = useLocale();
  const { from, to } = useRange();
  const rangeKey = `${from.getTime()}|${to.getTime()}`;
  const [detailPick, setDetailPick] = useState(null);
  const teams = useTeams();
  const selected = clients;
  // Keyed by page and client selection as well: the shared panel stays mounted across routes, so a
  // Users pick must not reopen as a Cost detail (or the reverse), and client changes clear it.
  const pickKey = `${page}|${selected.join(",")}`;
  // Keep the user open while a drag or the global picker changes the period.
  // Model drilldowns still belong to the range in which they were selected.
  const selection = detailPick?.key === pickKey
    && (detailPick.row.kind === "user-detail" || detailPick.rangeKey === rangeKey) ? detailPick.row : null;
  const select = (row) => setDetailPick({ key: pickKey, rangeKey, row });
  const rows = (key) => (data?.[key] || []).filter((row) => selected.includes(row.client)).map(presentationRow);
  const clientRows = selected.map((client) => presentationRow(
    (data?.by_client || []).find((row) => row.client === client) || { client, observed_records: 0 },
  ));
  const total = presentationRow(data?.totals);
  const basis = costBasisLabel(total, [...new Set(clientRows.map((row) => basisLabel(row.cost_basis)))].join(" + "));
  const models = rows("by_model"), users = rows("by_user"), periods = rows("timeseries");
  // Usage/cost tables drop zero-token models; reliability/diagnostics keep them (failed requests).
  const usageModels = withoutZeroTokenModels(models);
  const tools = (data?.tools || []).filter((row) => selected.includes(row.client));
  const trendProps = { rows: periods, clients: selected, clientRows, bucketHours: data?.bucket_hours || 1,
    effectiveRange: data?.effective_range, stale };
  const table = (title, columns, items, name, subtitle) => <ResultTable key={`${page}-${name}`}
    title={title} subtitle={subtitle} columns={columns} rows={items} exportName={`clients_${name}`} stale={stale} />;
  const tiles = (columns) => <Tiles row={total} columns={columns} basis={basis} />;
  const compare = (columns, extra = {}) => <Comparison key={page} rows={clientRows} columns={columns} stale={stale} {...extra} />;
  let content;

  switch (page) {
    case "exec":
      content = <>
        {tiles([COST, TOKENS, SESSIONS, USERS])}
        {compare([COST_SESSION, COST_USER, TOKEN_SESSION, SESSION_USER], { cards: true })}
        <ModelTrends data={data} clients={selected} exec stale={stale} />
        <Card title={translate("m3950a71f669d")} subtitle={translate("m4bcb9ec6bdf2")}>
          <Tiles row={total} columns={[COST_SESSION, COST_USER, TOKEN_SESSION, SESSION_USER]} basis={basis} />
        </Card>
        <ClientBars title={translate("m34c6061e5c94")} rows={clientRows} metric={SESSIONS} />
        {table(translate("m017ea42dfccd"), [CLIENT, BACKEND, MODEL, COST, BASIS, TOKENS, SESSIONS, COST_SESSION], usageModels, "executive_models")}
      </>;
      break;
    case "trends":
      content = <>
        <PeriodChange clientRows={clientRows} previous={previous} />
        {compare(PERIOD_COMPARE, { rows: withPeriodChange(clientRows, previous),
          stale: stale || Boolean(previous && (baselinePending(previous) || previous.error)),
          subtitle: translate("m5aae015113d9") })}
        <div className="grid xl:grid-cols-2 gap-4">
          <Trend {...trendProps} metric="tokens" title={translate("m9aeb0ce4e6c7")} />
          <Trend {...trendProps} metric="cost" title={translate("m07f89036e651")} />
        </div>
        <ModelTrends data={data} clients={selected} stale={stale} />
        <ResultTable key={`${page}-periods`} title={translate("m837f21ab0570")}
          subtitle={translate("m84f792a9c553", [bucketLabel(Number(data?.bucket_hours) || 1)])}
          help={translate("m9de3dae392c2")}
          columns={[{ key: "t", label: translate("m1eb480be7166"), render: formatClientTime, toText: formatClientTimestamp },
            CLIENT, TOKENS, COST, BASIS, SESSIONS, REQUESTS]}
          rows={periods} exportName="clients_periods" stale={stale} />
      </>;
      break;
    case "productivity": {
      const sections = productivitySections({ overview: data, productivity, clients: selected, stale });
      content = <>
        {sections.legend}
        <SectionLabel>{translate("m2741aaaa9dd2")}</SectionLabel>
        {sections.summary}
        <SectionLabel>{translate("m8e9defd375b6")}</SectionLabel>
        {table(translate("m787ac4c9f83a"), [CLIENT, BACKEND, MODEL, TOKEN_SESSION, COST_SESSION, MILLION, CACHE, REASONING, BASIS],
          usageModels, "efficiency", translate("m7258253911bd"))}
        <Fractions rows={clientRows} />
        <SectionLabel>{translate("m0ee205955870")}</SectionLabel>
        {sections.activity}
        <SectionLabel>{translate("me1fcaefd967e")}</SectionLabel>
        {sections.code}
        <SectionLabel>{translate("md51bf129ca5e")}</SectionLabel>
        {sections.decisions}
        <SectionLabel>{translate("mfbe1155729d2")}</SectionLabel>
        {sections.results}
        <SectionLabel>{translate("m48f3ca10ed3c")}</SectionLabel>
        {sections.latency}
        <SectionLabel>{translate("m7ba59ad3a745")}</SectionLabel>
        {sections.users}
      </>;
      break;
    }
    case "usage":
      content = <>
        <Card title={translate("m1e3af36b77f5")} subtitle={translateSource(TOKEN_HELP)}>
          <Tiles row={total} columns={[TOKENS, ...TOKEN_PARTS, REASONING_TOKENS]} />
        </Card>
        {compare(USAGE, { title: translate("m205053711ad7") })}
        <SeriesBarChart title={translate("md382a04533c1")} subtitle={translate("m05a8d473d0d5")}
          rows={clientRows.flatMap((row) => TOKEN_PARTS.map((part) => ({
            client: clientName(row.client), part: part.label, value: row[part.key],
          })))} xKey="client" seriesKey="part" valueKey="value" horizontal />
        <ToolTable rows={tools} stale={stale} />
      </>;
      break;
    case "users":
      content = <>
        {tiles([USERS, SESSIONS, SESSION_USER, COST_USER])}
        {compare([USERS, SESSIONS, SESSION_USER, COST_USER, BASIS])}
        <ClientBars title={translate("ma4949065b700")} rows={clientRows} metric={USERS}
          subtitle={translate("mc94d3342b250")} />
        {table(translate("me897ece86bad"), withTeamColumn([
          { ...USER, render: (value) => detailButton(maskEmail(value) || translate("m4083695f59ed"),
            () => select({ kind: "user-detail", user: value }), stale || !value) },
          CLIENT_PARTS, SESSIONS, TOKENS, COST, BASIS], teams),
          withTeams(combinedUserRows(users, selected), teams), "users",
          translate("me6d7a71b98ec"))}
        {selection?.kind === "user-detail" && <UserDetail key={selection.user} user={selection.user} clients={selected}
          hours={data?.bucket_hours || 1} parentRange={data?.effective_range} stale={stale}
          onClose={() => setDetailPick(null)} />}
      </>;
      break;
    case "cost":
      content = <>
        {tiles([COST, COST_SESSION, COST_USER, MILLION])}
        {breakdowns}
        {compare([...UNIT_COSTS, number("unpriced", translate("mfd13d514dcb3"))], { title: translate("m2b559f63ef3c") })}
        <Trend {...trendProps} metric="cost" title={translate("m07f89036e651")} />
        <ModelTrends data={data} clients={selected} stale={stale} />
        {table(translate("m38773723154b"), [CLIENT, BACKEND,
          { ...MODEL, render: (value, row) => detailButton(text(value),
            () => select({ kind: "model", client: row.client, model: value, backend: row.backend }), stale || !value) },
          ...UNIT_COSTS, TOKENS, number("unpriced", translate("mfd13d514dcb3"))],
          usageModels, "model_costs", translate("mdb92e3e3d57f", [translateSource(COST_HELP)]))}
        <CostUsers key={`${page}-user_costs`} users={users} modelRows={data?.by_user_model}
          clients={selected} stale={stale} onSelect={select} />
        {(selection?.kind === "user" || selection?.kind === "model") && <CostDetail key={JSON.stringify(selection)} selection={selection}
          hours={data?.bucket_hours || 1} parentRange={data?.effective_range} stale={stale}
          onClose={() => setDetailPick(null)} />}
      </>;
      break;
    case "reliability":
      content = <>
        {tiles([REQUESTS, ERRORS, TOOL_CALLS, TTFT])}
        {compare(OPERATIONS, { title: translate("mee51cf0ecb54"),
          subtitle: translate("m72bc73966648") })}
        <ClientBars title={translate("m046516250a50")} rows={clientRows} metric={REQUEST_TIME} />
        <ToolTable rows={tools} reliability stale={stale} />
        {table(translate("ma40e4f579448"), [CLIENT, BACKEND, MODEL, REQUESTS, ERRORS, ERROR_RATIO, REQUEST_TIME, TTFT],
          models, "model_reliability", translate("mfe40fdfb101a"))}
      </>;
      break;
    case "analytics":
      content = <>
        {compare([TOKENS, REQUESTS, TOOL_CALLS, REQUEST_TIME, TTFT], { title: translate("m12eed772db7f") })}
        <ClientBars title={translate("m3471f0ca3e85")} rows={clientRows} metric={TTFT} />
        {table(translate("m4608455a1d4d"), [CLIENT, BACKEND, MODEL, TOKENS, REQUESTS, ERRORS, TOOL_CALLS, REQUEST_TIME, TTFT],
          models, "diagnostics", translate("m9842c8e77140"))}
        {table(translate("m6f49b32db5ad"), [CLIENT, { key: "project", label: translate("mf05481bea1dd"), render: (v) => v || translate("md7588c178087") }, BACKEND, ...USAGE],
          rows("by_project"), "projects", translate("m76cb3c3c0aa1"))}
        <Card title={translate("mb4fe217f7fb1")}>
          <div className={`grid gap-4 ${clientRows.length > 1 ? "lg:grid-cols-2" : ""}`}>
            {clientRows.map((row) => <div key={row.client}>
              <div className="mb-2 text-sm font-semibold text-ink-800">{clientName(row.client)}</div>
              <dl className="space-y-2 text-[13px]">
                {[[TOKENS, translate("meeb3eeedf4d3")], [REQUESTS, translate("m26244be57132")], [TOOL_CALLS, translate("m159c9527e2ae")],
                  [TTFT, translate("m43a9cc76da48")], [REASONING_TOKENS, translate("mf0520dd53954")]].map(([metric, label]) => <div key={label} className="flex justify-between gap-4">
                  <dt className="text-ink-500">{label}</dt>
                  <dd className="text-ink-800">{metric === TOKENS ? row.token_status : row[metric.key] === null ? translate("m1639b23bf2a8") : translate("mce2dbc682157")}</dd>
                </div>)}
              </dl>
            </div>)}
          </div>
          <p className="mt-4 text-[12px] text-ink-500">{translate("m2668f8520023")}</p>
        </Card>
      </>;
      break;
    default:
      content = <>
        {tiles([COST, TOKENS, SESSIONS, USERS])}
        {compare([COST, TOKENS, SESSIONS, USERS], { cards: true })}
        <Trend {...trendProps} />
        {table(translate("m00a65c35bce6"), [CLIENT, BACKEND, MODEL, TOKENS, COST, BASIS, SESSIONS], usageModels, "models")}
      </>;
  }
  return <div className="flex flex-col gap-6">
    {content}
    <p className="text-[12px] text-ink-500">{translateSource(EMPTY_VALUE)}</p>
  </div>;
}

export default memo(ClientPanels);
