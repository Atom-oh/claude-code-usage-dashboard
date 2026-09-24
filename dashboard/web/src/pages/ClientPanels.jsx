import { memo, useMemo, useState } from "react";
import { Card } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { DualLineChart, RingGauge, SeriesBarChart } from "../components/GroupCharts.jsx";
import { maskEmail, parseUtc } from "../fmt.js";
import { clientTimeline, formatClientCost, formatObserved } from "../clientUsage.js";
import {
  basisLabel, BROWSER_TIME_ZONE, clientName, costBasisLabel, formatClientTime, formatClientTimestamp, formatPercent, observedNumber, OBSERVED_TOKEN_HELP, presentationRow,
} from "../clientPresentation.js";

const text = (v) => v || "—";
const compactAxis = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
const color = (client) => client === "claude" ? "var(--chart-1)" : "var(--chart-2)";
const number = (key, label) => ({ key, label, render: formatObserved });
const percent = (key, label) => ({ key, label, render: formatPercent });
const money = (key, label) => ({ key, label, render: formatClientCost });
const CLIENT = { key: "client", label: "클라이언트", render: clientName, toText: clientName };
const BACKEND = { key: "backend", label: "백엔드", render: text };
const MODEL = { key: "model", label: "모델", render: text };
const USER = { key: "user", label: "사용자", render: (v) => maskEmail(v) || "(미식별)" };
const BASIS = { key: "cost_basis_label", label: "비용 기준",
  render: (value) => <span className="block min-w-[10rem]">{text(value)}</span>, toText: text };
const COST = money("cost_usd", "비용 (USD)");
const TOKENS = number("observed_tokens", "관측 토큰");
const TOKEN_STATUS = { key: "token_status", label: "토큰 상태", render: text };
const withTokenStatus = (columns) => columns.flatMap((column) => column === TOKENS ? [column, TOKEN_STATUS] : [column]);
const SESSIONS = number("sessions", "세션");
const USERS = number("users", "관측 사용자 ID");
const COST_SESSION = money("cost_per_session", "세션당 비용 (USD)");
const COST_USER = money("cost_per_user", "사용자당 비용 (USD)");
const TOKEN_SESSION = number("tokens_per_session", "세션당 토큰");
const SESSION_USER = number("sessions_per_user", "사용자당 세션");
const MILLION = money("usd_per_million_tokens", "100만 토큰당 비용 (USD)");
const CACHE = percent("cache_read_pct", "캐시 읽기 / 전체 입력 (%)");
const REASONING = percent("reasoning_pct", "추론 / 출력 (%)");
const REQUESTS = number("requests", "API 요청");
const ERRORS = number("api_errors", "API 오류 기록");
const TOOL_CALLS = number("tool_calls", "도구 호출");
const TOOL_ERRORS = number("tool_errors", "도구 오류");
const ERROR_RATIO = number("error_records_per_request", "오류 기록 / 요청");
const REQUEST_TIME = number("request_duration_ms", "평균 API 요청 시간 (ms)");
const TTFT = number("ttft_ms", "평균 첫 토큰 시간 (ms)");
const TOKEN_PARTS = [
  number("input_tokens", "입력 (캐시 제외)"), number("cache_read_tokens", "캐시 읽기"),
  number("cache_write_tokens", "캐시 쓰기"), number("output_tokens", "출력 (추론 포함)"),
];
const REASONING_TOKENS = number("reasoning_tokens", "추론 (출력의 일부)");
const USAGE = [SESSIONS, TOKENS, ...TOKEN_PARTS, REASONING_TOKENS, COST, BASIS];
const UNIT_COSTS = [COST, COST_SESSION, COST_USER, MILLION, BASIS];
const OPERATIONS = [REQUESTS, ERRORS, ERROR_RATIO, TOOL_CALLS, TOOL_ERRORS, REQUEST_TIME, TTFT];
const GRID = "grid grid-cols-2 xl:grid-cols-4 gap-4";
const EMPTY_VALUE = "—는 미수집·미지원·미산정 값입니다. 관측된 0과 구분합니다.";
const TOKEN_HELP = "구성값은 기존 전체 토큰 기준입니다: 입력(캐시 제외) + 캐시 읽기 + 캐시 쓰기 + 출력. 추론은 출력에 포함됩니다. 관측 토큰과 집계 범위가 다를 수 있으며, 누락된 구성값은 —로 유지합니다.";
const COST_HELP = "미산정 기록은 제외하고 알려진 비용만 부분합으로 표시합니다. 단위 비용은 알려진 비용 / 관측된 분모의 근삿값이며, 비용이 모두 미산정이거나 분모가 없거나 0이면 —로 표시합니다.";

function Tiles({ row, columns, basis }) {
  return <div className={GRID}>
    {columns.map((c) => <StatTile key={c.key} label={c.label} value={c.render(row[c.key])}
      variant={c.key === "cost_usd" ? "accent" : "default"}
      className={c.render === formatClientCost ? "[&_.truncate]:whitespace-normal" : undefined}
      hint={c === TOKENS ? row.token_status : c.render === formatClientCost ? basis : undefined}
      help={c === TOKENS ? OBSERVED_TOKEN_HELP : c.render === formatClientCost ? COST_HELP : undefined} />)}
  </div>;
}

function ResultTable({ rows, columns, subtitle, ...props }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = rows.length > 20 && !expanded;
  const detail = rows.length > 20
    ? `${truncated ? 20 : rows.length} / ${rows.length}행 표시 · CSV는 표시된 행만 내보냅니다.`
    : undefined;
  return <DataTable {...props} columns={withTokenStatus(columns)} rows={truncated ? rows.slice(0, 20) : rows}
    subtitle={[subtitle, detail].filter(Boolean).join(" ") || undefined}
    right={rows.length > 20 ? <button type="button"
      className="text-[11px] font-medium text-brand-700 whitespace-nowrap"
      onClick={() => setExpanded((value) => !value)}>
      {expanded ? "20행만 보기" : `전체 ${rows.length}행 보기`}
    </button> : undefined} />;
}

function Comparison({ rows, columns, cards = false, title = "클라이언트별 비교", subtitle, stale = false }) {
  return <section aria-label="클라이언트 비교">
    {cards ? <div className={`grid gap-4 ${rows.length > 1 ? "lg:grid-cols-2" : ""}`}>
      {rows.map((row) => <Card key={row.client} title={clientName(row.client)}
        subtitle={`${row.cost_basis_label} · ${text(row.backend)}${row.observed_records === 0 ? " · 관측 없음" : ""}`}
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

function Trend({ rows, clients, clientRows, bucketHours, effectiveRange, metric = "both", title = "사용량·비용 추이" }) {
  const { timeline, timeDomain, rejections } = useMemo(() => {
    const timeline = clientTimeline(rows, { bucketHours, effectiveRange })
      .map((row) => ({ ...row, t: parseUtc(row.t).getTime() }))
      .filter((row) => Number.isFinite(row.t));
    const from = Date.parse(effectiveRange?.from), to = Date.parse(effectiveRange?.to);
    const step = Number.isFinite(bucketHours * 3600000) && bucketHours > 0 ? bucketHours * 3600000 : 3600000;
    const timeDomain = Number.isFinite(from) && Number.isFinite(to) && from < to
      ? [from, to] : timeline.length ? [timeline[0].t, timeline.at(-1).t + step] : undefined;
    const rejections = new Map(rows.filter(row => row.request_rejections_only === true)
      .map(row => [`${row.client}:${parseUtc(row.t.replace(/(?:\.\d+)?Z$/, "")).getTime()}`,
        observedNumber(row.rejected_requests)]));
    return { timeline, timeDomain, rejections };
  }, [rows, bucketHours, effectiveRange?.from, effectiveRange?.to]);
  const lines = clients.flatMap((client) => {
    const row = clientRows.find((row) => row.client === client);
    const partial = row?.cost_partial === true || observedNumber(row?.unpriced) > 0
      || rows.some(period => period.client === client && period.cost_partial === true);
    const status = row?.cost_usd == null ? " · 미산정" : partial ? " · 부분합 포함" : "";
    const basis = `${basisLabel(row?.cost_basis)}${status}`;
    const tokenPartial = row?.tokens_partial === true
      || rows.some((period) => period.client === client && (period.tokens_partial === true || period.observed_tokens === null));
    return [
      ...(metric !== "cost" ? [{ key: `${client}_tokens`, label: `${clientName(client)} 관측 토큰${tokenPartial ? " · 부분합 포함" : ""}`, color: color(client) }] : []),
      ...(metric !== "tokens" ? [{ key: `${client}_cost`, label: `${clientName(client)} 비용 (USD · ${basis})`, color: color(client), axis: metric === "both" ? "right" : "left" }] : []),
    ];
  });
  if (!timeline.some((row) => lines.some((line) => observedNumber(row[line.key]) !== null))) {
    return <Card title={title}><p className="text-sm text-ink-500">표시할 관측값이 없습니다. {EMPTY_VALUE}</p></Card>;
  }
  return <DualLineChart title={title}
    subtitle={`${bucketHours < 1 ? "분별" : "시간별"} · 브라우저 시간 (${BROWSER_TIME_ZONE}) · 관측 사용량 없음은 0, 사용량 미확인은 공백으로 표시합니다.${metric !== "cost" ? " 관측 토큰은 수집된 값 중 확인된 합계이며, 사용량·메타데이터가 불완전하면 부분합입니다." : ""}${metric !== "tokens" ? " 비용은 알려진 값만 합산합니다." : ""}`}
    help="0은 해당 시간에 집계된 사용량이 없다는 뜻입니다. 이벤트 자체의 전송 누락은 미사용과 구분할 수 없으며, 차트가 누락된 사용량을 복원하지는 않습니다."
    tooltipFormatter={(value, name, item) => {
      const client = String(item.dataKey).split("_")[0];
      const rejected = rejections.get(`${client}:${item.payload?.t}`);
      const unpriced = String(item.dataKey).endsWith("_cost") && item.payload?.[item.dataKey] == null;
      return [unpriced ? "미산정" : value == null ? "미확인" : value === 0 && rejected > 0
        ? `0 (요청 거절 ${formatObserved(rejected)}건)`
        : item.payload?.empty_clients?.includes(client) ? `${value} (관측 사용량 없음)` : value, name];
    }}
    rows={timeline} xKey="t" lines={lines} bucketHours={bucketHours}
    timeDomain={timeDomain}
    tickFormatter={formatClientTime} valueTickFormatter={compactAxis.format} height={metric === "both" ? 320 : 240} />;
}

function ClientBars({ title, rows, metric, subtitle }) {
  return <SeriesBarChart title={title} subtitle={subtitle}
    rows={rows.map((row) => ({ ...row, label: clientName(row.client) }))}
    xKey="label" seriesKey="client" valueKey={metric.key} horizontal height={200}
    colorOf={color} seriesSort={(a, b) => a.localeCompare(b)} />;
}

function ToolTable({ rows, reliability = false, stale = false }) {
  const tools = rows.map((row) => {
    const calls = observedNumber(row.calls), duration = observedNumber(row.duration_ms);
    const derived = presentationRow({ tool_calls: calls, tool_errors: row.errors });
    return { ...row, calls, errors: observedNumber(row.errors), duration_ms: duration,
      mean_ms: calls > 0 && duration !== null ? duration / calls : null, tool_error_pct: derived.tool_error_pct };
  });
  return <ResultTable title={reliability ? "도구 신뢰성" : "도구 사용"}
    subtitle="관측된 도구 결과 기준 · 누락된 시간은 0으로 대체하지 않습니다."
    columns={[CLIENT, { key: "tool", label: "도구", render: text }, number("calls", "호출"),
      number("errors", "오류"), percent("tool_error_pct", "도구 오류 비율 (%)"),
      number("mean_ms", "평균 시간 (ms)"), number("duration_ms", "누적 시간 (ms)")]}
    rows={tools} exportName="clients_tools" stale={stale} />;
}

function Fractions({ rows }) {
  return <Card title="캐시·추론 비중"
    subtitle="캐시 읽기는 캐시 쓰기를 포함한 전체 입력 기준 · 추론은 출력의 일부이며 별도로 합산하지 않습니다.">
    <div className={`grid gap-6 ${rows.length > 1 ? "lg:grid-cols-2" : ""}`}>
      {rows.map((row) => <div key={row.client}>
        <div className="text-sm font-semibold text-ink-800 mb-3">{clientName(row.client)}</div>
        <div className="flex flex-wrap justify-around gap-4">
          <RingGauge pct={row.cache_read_pct == null ? null : row.cache_read_pct / 100}
            color={color(row.client)} label="캐시 읽기 / 전체 입력" sub={`${formatObserved(row.cache_read_tokens)} / ${formatObserved(row.input_total)} 토큰`} />
          <RingGauge pct={row.reasoning_pct == null ? null : row.reasoning_pct / 100}
            color={color(row.client)} label="추론 / 출력" sub={`${formatObserved(row.reasoning_tokens)} / ${formatObserved(row.output_tokens)} 토큰`} />
        </div>
      </div>)}
    </div>
    <p className="mt-4 text-[12px] text-ink-500">추론 미지원·미수집 또는 분모가 0이면 비율을 제공하지 않습니다.</p>
  </Card>;
}

function ClientPanels({ page = "overview", data = {}, clients = data?.clients || [], stale = false }) {
  const selected = clients;
  const rows = (key) => (data?.[key] || []).filter((row) => selected.includes(row.client)).map(presentationRow);
  const clientRows = selected.map((client) => presentationRow(
    (data?.by_client || []).find((row) => row.client === client) || { client, observed_records: 0 },
  ));
  const total = presentationRow(data?.totals);
  const basis = costBasisLabel(total, [...new Set(clientRows.map((row) => basisLabel(row.cost_basis)))].join(" + "));
  const models = rows("by_model"), users = rows("by_user"), periods = rows("timeseries");
  const tools = (data?.tools || []).filter((row) => selected.includes(row.client));
  const trendProps = { rows: periods, clients: selected, clientRows, bucketHours: data?.bucket_hours || 1,
    effectiveRange: data?.effective_range };
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
        <Card title="활동 단위별 비용" subtitle="관측 사용자 ID·세션 기준이며 직원 수나 업무 성과의 측정값이 아닙니다.">
          <Tiles row={total} columns={[COST_SESSION, COST_USER, TOKEN_SESSION, SESSION_USER]} basis={basis} />
        </Card>
        <ClientBars title="클라이언트별 세션" rows={clientRows} metric={SESSIONS} />
        {table("모델별 비용·활동", [CLIENT, BACKEND, MODEL, COST, BASIS, TOKENS, SESSIONS, COST_SESSION], models, "executive_models")}
      </>;
      break;
    case "trends":
      content = <>
        {compare([COST, TOKENS, SESSIONS, BASIS])}
        <div className="grid xl:grid-cols-2 gap-4">
          <Trend {...trendProps} metric="tokens" title="토큰 추이" />
          <Trend {...trendProps} metric="cost" title="비용 추이" />
        </div>
        {table("기간별 관측값", [
          { key: "t", label: "기간 시작 (브라우저 시간)", render: formatClientTime, toText: formatClientTimestamp }, CLIENT, TOKENS, COST, BASIS, SESSIONS, REQUESTS,
        ], periods, "periods", "관측된 버킷만 표시합니다. 버킷별 고유 세션 수는 합산할 수 없으며 이전 기간 대비 증감은 제공하지 않습니다.")}
      </>;
      break;
    case "productivity":
      content = <>
        {compare([TOKEN_SESSION, COST_SESSION, MILLION, BASIS], { title: "클라이언트별 관측 효율" })}
        <Fractions rows={clientRows} />
        {table("모델별 관측 효율", [CLIENT, BACKEND, MODEL, TOKEN_SESSION, COST_SESSION, MILLION, CACHE, REASONING, BASIS],
          models, "efficiency", "비율은 기존 전체 토큰·구성값 기준이며 관측 토큰 부분합으로 대체하지 않습니다. 모델별 작업 구성과 비용 기준이 달라 업무 생산성이나 코드 품질 순위로 해석할 수 없습니다.")}
      </>;
      break;
    case "usage":
      content = <>
        <Card title="토큰 구성" subtitle={TOKEN_HELP}>
          <Tiles row={total} columns={[TOKENS, ...TOKEN_PARTS, REASONING_TOKENS]} />
        </Card>
        {compare(USAGE, { title: "클라이언트별 사용량" })}
        <SeriesBarChart title="클라이언트별 토큰 구성" subtitle="서로 겹치지 않는 네 항목만 합산합니다."
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
        <ClientBars title="클라이언트별 관측 사용자" rows={clientRows} metric={USERS}
          subtitle="클라이언트별 고유 ID 수입니다. 서로 겹치는 ID가 있어 전체 사용자 수로 합산하지 않습니다." />
        {table("사용자별 사용량", [CLIENT, USER, BACKEND, ...USAGE], users, "users",
          "동일 ID도 클라이언트별 행으로 표시합니다. 전체 사용자 수는 서버의 중복 제거 값이며 행 수의 합이 아닙니다. CSV는 표시 열·정렬·마스킹 설정을 따릅니다.")}
      </>;
      break;
    case "cost":
      content = <>
        {tiles([COST, COST_SESSION, COST_USER, MILLION])}
        {compare([...UNIT_COSTS, number("unpriced", "미산정 기록")], { title: "클라이언트별 비용 기준" })}
        <Trend {...trendProps} metric="cost" title="비용 추이" />
        {table("모델별 비용", [CLIENT, BACKEND, MODEL, ...UNIT_COSTS, TOKENS, number("unpriced", "미산정 기록")],
          models, "model_costs", COST_HELP)}
        {table("사용자별 비용", [CLIENT, USER, BACKEND, COST, BASIS, SESSIONS, COST_SESSION, TOKENS],
          users, "user_costs")}
      </>;
      break;
    case "reliability":
      content = <>
        {tiles([REQUESTS, ERRORS, TOOL_CALLS, TTFT])}
        {compare(OPERATIONS, { title: "요청·오류·응답 시간",
          subtitle: "API 오류 기록 / 요청은 실패 확률이 아니며 1을 초과할 수 있습니다. API 요청 시간은 전체 생성 시간이 아닙니다." })}
        <ClientBars title="클라이언트별 API 요청 시간 (ms)" rows={clientRows} metric={REQUEST_TIME} />
        <ToolTable rows={tools} reliability stale={stale} />
        {table("모델별 요청 진단", [CLIENT, BACKEND, MODEL, REQUESTS, ERRORS, ERROR_RATIO, REQUEST_TIME, TTFT],
          models, "model_reliability", "시간은 서버가 집계한 관측 평균입니다. 모델 미지정 요청은 별도 행으로 남습니다.")}
      </>;
      break;
    case "analytics":
      content = <>
        {compare([TOKENS, REQUESTS, TOOL_CALLS, REQUEST_TIME, TTFT], { title: "클라이언트별 신호 비교" })}
        <ClientBars title="클라이언트별 첫 토큰 시간 (ms)" rows={clientRows} metric={TTFT} />
        {table("모델·백엔드 진단", [CLIENT, BACKEND, MODEL, TOKENS, REQUESTS, ERRORS, TOOL_CALLS, REQUEST_TIME, TTFT],
          models, "diagnostics", "백엔드는 전송 경로이며 클라이언트 정체성이나 기업 사용 채널을 뜻하지 않습니다.")}
        {table("프로젝트 태그별 사용량", [CLIENT, { key: "project", label: "프로젝트", render: (v) => v || "(미지정)" }, BACKEND, ...USAGE],
          rows("by_project"), "projects", "클라이언트의 project.name 태그 기준이며 AWS 청구 프로젝트와 별도입니다. 태그 수집을 지원하는 클라이언트의 관측값만 표시합니다.")}
        <Card title="관측 신호 범위">
          <div className={`grid gap-4 ${clientRows.length > 1 ? "lg:grid-cols-2" : ""}`}>
            {clientRows.map((row) => <div key={row.client}>
              <div className="mb-2 text-sm font-semibold text-ink-800">{clientName(row.client)}</div>
              <dl className="space-y-2 text-[13px]">
                {[[TOKENS, "사용량"], [REQUESTS, "API 요청"], [TOOL_CALLS, "도구 결과"],
                  [TTFT, "첫 토큰 시간"], [REASONING_TOKENS, "추론 토큰"]].map(([metric, label]) => <div key={label} className="flex justify-between gap-4">
                  <dt className="text-ink-500">{label}</dt>
                  <dd className="text-ink-800">{metric === TOKENS ? row.token_status : row[metric.key] === null ? "미지원·미수집" : "관측됨"}</dd>
                </div>)}
              </dl>
            </div>)}
          </div>
          <p className="mt-4 text-[12px] text-ink-500">런타임 메트릭·트레이스는 진단 신호입니다. 완료 로그 기반 사용량·비용에 더하지 않습니다. 신호 관측 여부는 수집 완전성을 보장하지 않습니다.</p>
        </Card>
      </>;
      break;
    default:
      content = <>
        {tiles([COST, TOKENS, SESSIONS, USERS])}
        {compare([COST, TOKENS, SESSIONS, USERS], { cards: true })}
        <Trend {...trendProps} />
        {table("모델별 사용량", [CLIENT, BACKEND, MODEL, TOKENS, COST, BASIS, SESSIONS], models, "models")}
      </>;
  }
  return <div className="flex flex-col gap-6">
    {content}
    <p className="text-[12px] text-ink-500">{EMPTY_VALUE}</p>
  </div>;
}

export default memo(ClientPanels);
