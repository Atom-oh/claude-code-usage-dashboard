import { useMemo, useState } from "react";
import { Card, ErrorBox, Loading } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { StatTile } from "../components/StatTile.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { useApi } from "../useApi.js";
import { formatClientCost, formatObserved, observedTokens } from "../clientUsage.js";
import { costBasisLabel, formatClientTimestamp, observedNumber, OBSERVED_TOKEN_HELP, tokenStatusLabel } from "../clientPresentation.js";

const percent = (v) => v == null ? "—" : `${(v * 100).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%`;
const text = (key, label) => ({ key, label, render: (v) => v || "—" });
const numeric = (key, label) => ({ key, label, render: formatObserved });
const ratio = (key, label) => ({ key, label, render: percent });
const cost = (key, label) => ({ key, label, render: formatClientCost });
const TABS = ["효율·Effort", "도구·승인", "성능", "런타임·메트릭", "Trace"];
const STATUS = { observed: "수집 확인", empty: "관측 없음", unavailable: "수집 미확인", limited: "조회 한도 초과" };
const codexCostLabel = (row) => costBasisLabel({ ...row, cost_basis: "aws_list_estimate" });
const COST_HELP = "미산정 기록을 제외한 알려진 비용 / 관측된 요청·세션 수의 근삿값입니다. 비용이 모두 미산정이거나 식별 정보·분모가 없거나 분모가 0이면 —로 표시합니다.";
const EFFORT = [text("effort", "Effort"), numeric("requests", "완료 응답"), numeric("observed_tokens", "관측 토큰"),
  text("token_status", "토큰 상태"),
  cost("cost_usd", "추정 비용 (USD)"), numeric("unpriced", "미산정"),
  { key: "cost_basis_label", label: "비용 기준·미산정",
    render: (value) => <span className="block min-w-[10rem]">{value}</span>, toText: (value) => value },
  ratio("cache_hit_rate", "캐시 읽기 비율"), ratio("reasoning_share", "추론 비중")];
const TOOLS = [text("tool", "도구"), numeric("calls", "호출"), numeric("successes", "성공"),
  numeric("failures", "실패"), numeric("unknown", "결과 미확인"), ratio("success_rate", "성공률"),
  numeric("average_ms", "평균 (ms)"), numeric("p95_ms", "P95 (ms)")];
const APPROVALS = [text("tool", "도구"), text("decision", "결정"), text("source", "결정 출처"), numeric("count", "건수")];
const LATENCY = [text("name", "측정 대상"), numeric("count", "표본"), numeric("average_ms", "평균 (ms)"),
  numeric("p50_ms", "P50 (ms)"), numeric("p95_ms", "P95 (ms)"), numeric("max_ms", "최대 (ms)")];
const RUNTIME = [text("model", "모델"), text("version", "버전"), text("provider", "공급자"), text("effort", "시작 Effort"),
  text("sandbox_policy", "Sandbox"), text("approval_policy", "승인 정책"), numeric("sessions", "세션")];
const METRICS = [text("name", "메트릭"), text("type", "유형"), text("unit", "단위"),
  { key: "dimensions", label: "차원", render: (v) => JSON.stringify(v || {}), toText: (v) => JSON.stringify(v || {}) },
  numeric("points", "수집 표본"), numeric("value", "카운터 증분 / 최근 Gauge"),
  numeric("count", "Histogram 관측 수"), numeric("mean", "평균"), numeric("min", "최소"), numeric("max", "최대"),
  { key: "partial", label: "구간 상태", render: (v) => v ? "불완전" : "확인", toText: (v) => v ? "불완전" : "확인" }];
const SPANS = [text("name", "Span"), numeric("count", "건수"), numeric("errors", "오류 상태"),
  numeric("average_ms", "평균 (ms)"), numeric("p95_ms", "P95 (ms)")];
const TRACE_DETAIL = [text("name", "작업"), text("span_id", "Span ID"), text("parent_span_id", "부모 Span ID"),
  text("model", "모델"), text("tool_name", "도구"), text("effort", "Effort"),
  { key: "start_time", label: "시작 (브라우저 시간)", render: formatClientTimestamp, toText: formatClientTimestamp }, numeric("duration_ms", "시간 (ms)"), text("status", "상태")];
function metricMean(rows, name, tokenType) {
  const selected = (rows || []).filter((r) => r.name === name
    && (!tokenType || r.dimensions?.token_type === tokenType));
  if (!selected.length || selected.some((r) => r.count == null || r.sum == null)) return null;
  const count = selected.reduce((n, r) => n + r.count, 0);
  return count > 0 ? selected.reduce((n, r) => n + r.sum, 0) / count : null;
}
const milliseconds = (value) => value == null ? "—" : `${formatObserved(value)} ms`;
const partialHint = (rows, name) => rows?.some((r) => r.name === name && r.partial)
  ? "일부 원본 통계 미확인" : undefined;
const EFFICIENCY_TILES = [
  ["cache_hit_rate", "입력 캐시 읽기 비율", percent, "캐시 읽기 / 캐시를 포함한 전체 입력 토큰입니다."],
  ["cache_write_share", "입력 캐시 쓰기 비중", percent],
  ["reasoning_share", "출력 중 추론 비중", percent, "추론 토큰은 출력 토큰의 일부입니다."],
  ["tokens_per_request", "요청당 토큰", formatObserved, "기존 전체 토큰 / 요청 수입니다. 토큰이 불완전하면 관측 부분합으로 대체하지 않고 —로 표시합니다."],
  ["cost_per_request", "요청당 추정 비용", formatClientCost],
  ["cost_per_session", "세션당 추정 비용", formatClientCost],
];

export default function CodexInsights({ range, enabled = true, hold = false, sections }) {
  const bounds = range?.from && range?.to ? { from: range.from, to: range.to } : {};
  const { data, loading, error, stale } = useApi("/api/codex/insights", { client: "codex", ...bounds }, enabled, { linkedRange: true, hold });
  const [preferredTab, setTab] = useState(TABS[0]);
  const allowedTabs = sections?.length ? TABS.filter((name) => sections.includes(name)) : TABS;
  const tab = allowedTabs.includes(preferredTab) ? preferredTab : allowedTabs[0];
  const [search, setSearch] = useState("");
  const metrics = useMemo(() => (data?.metrics || []).filter((r) => r.name.toLowerCase().includes(search.toLowerCase())), [data?.metrics, search]);
  const summary = data?.summary || {};
  const tokensPerRequest = summary.tokens_partial === true
    || (Object.hasOwn(summary, "tokens") && observedNumber(summary.tokens) === null)
    ? null : summary.tokens_per_request;
  return (
    <section aria-labelledby="codex-insights-heading" className="flex flex-col gap-5">
      <div>
        <h2 id="codex-insights-heading" className="text-xl font-semibold text-ink-800">Codex 상세 관측</h2>
        <p className="mt-1 text-sm text-ink-600">Codex 비용은 AWS 정가 추정입니다. 실행 관측값은 실청구·코드 품질·절감 시간을 뜻하지 않습니다.</p>
      </div>
      {!enabled || loading ? <Loading /> : error ? <ErrorBox error={error} /> : (
        <>
          {data?.range && <p className="text-sm text-ink-600">
            상세 조회 구간: {formatClientTimestamp(data.range.from)} ~ {formatClientTimestamp(data.range.to)} (브라우저 시간)
          </p>}
          <div className="flex flex-wrap gap-2" aria-label="신호 수집 상태">
            {["logs", "metrics", "traces"].map((signal) => {
              const c = data?.coverage?.[signal];
              return <span key={signal} className="rounded-lg border border-ink-200 bg-card px-3 py-2 text-sm text-ink-700"
                title={c?.last_seen ? `최근 관측: ${formatClientTimestamp(c.last_seen)}` : "선택한 구간의 수집 상태"}>
                {signal[0].toUpperCase() + signal.slice(1)} · {STATUS[c?.status] || "수집 미확인"}
                {c?.status === "observed" && ` · ${formatObserved(c.records)}개`}
                {c?.partial && " · 일부 미확인"}
                {signal === "traces" && c?.selection === "latest_50_traces" && " · 최근 50 Trace"}
              </span>;
            })}
          </div>
          {["logs", "metrics"].some((signal) => data?.coverage?.[signal]?.status === "limited") &&
            <p role="status" className="text-sm text-warning-text">
              일부 상세 신호가 조회 한도를 넘었습니다. 해당 신호의 수치는 표시하지 않으며, 기간을 줄이면 확인할 수 있습니다. 공통 지표와 다른 신호는 유지됩니다.
            </p>}
          {allowedTabs.length > 1 && <div className="flex flex-wrap gap-2" aria-label="Codex 상세 보기">
            {allowedTabs.map((name) => <button key={name} type="button" aria-pressed={tab === name} onClick={() => setTab(name)}
              className={`rounded-lg border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 ${tab === name
                ? "border-brand-500 bg-brand-600 text-white" : "border-ink-200 bg-card text-ink-700"}`}>{name}</button>)}
          </div>}
          {tab === TABS[0] && <>
            <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
              {(Object.hasOwn(summary, "observed_tokens") || Object.hasOwn(summary, "tokens")) &&
                <StatTile label="관측 토큰" value={formatObserved(observedTokens(summary))}
                  hint={tokenStatusLabel(summary)} help={OBSERVED_TOKEN_HELP} />}
              {EFFICIENCY_TILES.map(([key, label, format, help]) => <StatTile key={key} label={label}
                value={format(key === "tokens_per_request" ? tokensPerRequest : summary[key])}
                help={format === formatClientCost ? COST_HELP : help}
                hint={format === formatClientCost ? codexCostLabel({ ...summary, cost_usd: summary[key] }) : undefined}
                className={format === formatClientCost ? "[&_.truncate]:whitespace-normal" : undefined} />)}
            </div>
            <DataTable title="Effort별 사용량·비용" subtitle="유효한 입력·출력 쌍을 합산하고 미확인 쌍은 제외합니다. 사용량·메타데이터가 불완전해도 유효한 쌍은 포함하며 부분합으로 표시합니다. 비율은 기존 전체 토큰·구성값 기준입니다. 알려진 비용만 합산하고 미산정 기록은 제외합니다."
              rows={(data?.effort || []).map((row) => ({ ...row, observed_tokens: observedTokens(row),
                token_status: tokenStatusLabel(row), cost_basis_label: codexCostLabel(row) }))}
              columns={EFFORT} exportName="codex_effort" stale={stale} />
          </>}
          {tab === TABS[1] && <>
            <div className="grid grid-cols-2 gap-4">
              <StatTile label="도구 성공률" value={percent(summary.tool_success_rate)} help="명시적인 성공·실패 결과 기준이며, 미확인 결과가 있으면 전체 성공률을 제공하지 않을 수 있습니다." />
              <StatTile label="도구 승인 비율" value={percent(summary.approval_rate)} help="자동 승인을 포함한 권한 결정입니다. 코드 수락률이 아닙니다." />
            </div>
            <DataTable title="도구 실행 결과" columns={TOOLS} rows={data?.tools || []} exportName="codex_tools_detail" stale={stale} />
            <DataTable title="승인·거절과 결정 출처" columns={APPROVALS} rows={data?.approvals || []} exportName="codex_approvals" stale={stale} />
          </>}
          {tab === TABS[2] && <>
            <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
              <StatTile label="재시도 요청 비율" value={percent(summary.retry_rate)} help="attempt가 0보다 큰 요청 / attempt가 확인된 요청입니다." />
              <StatTile label="요청당 API 오류 기록" value={formatObserved(summary.api_error_rate)}
                help="HTTP 및 스트림 오류 기록 / 관측된 HTTP 요청입니다. 한 요청에 여러 오류가 기록될 수 있습니다." />
              <StatTile label="평균 턴 처리 시간" value={milliseconds(metricMean(data?.metrics, "codex.turn.e2e_duration_ms"))}
                hint={partialHint(data?.metrics, "codex.turn.e2e_duration_ms")}
                help="Codex가 보고한 턴 Histogram의 평균입니다. 사람의 작업시간이나 절감 시간이 아닙니다." />
              <StatTile label="평균 턴 첫 토큰 시간" value={milliseconds(metricMean(data?.metrics, "codex.turn.ttft.duration_ms"))}
                hint={partialHint(data?.metrics, "codex.turn.ttft.duration_ms")} />
              <StatTile label="턴당 평균 도구 호출" value={formatObserved(metricMean(data?.metrics, "codex.turn.tool.call"))}
                hint={partialHint(data?.metrics, "codex.turn.tool.call")} />
              <StatTile label="턴당 평균 토큰" value={formatObserved(metricMean(data?.metrics, "codex.turn.token_usage", "total"))}
                hint={partialHint(data?.metrics, "codex.turn.token_usage")}
                help="턴 메트릭의 별도 관측입니다. 위 사용량·비용 합계에 더하지 않습니다." />
            </div>
            <DataTable title="요청·도구·시작 단계 지연" subtitle="관측된 로그 시간의 분포입니다. SSE 이벤트 처리 시간과 전체 생성 시간은 다릅니다."
              columns={LATENCY} rows={data?.latency || []} exportName="codex_latency" stale={stale} />
          </>}
          {tab === TABS[3] && <>
            <div className="grid grid-cols-2 gap-4">
              <StatTile label="프롬프트 이벤트" value={formatObserved(summary.prompts)} />
              <StatTile label="평균 프롬프트 길이" value={formatObserved(summary.prompt_length_mean)} help="Codex가 보고한 길이입니다. 프롬프트 본문은 수집하지 않습니다." />
            </div>
            <DataTable title="세션 시작 설정" subtitle="시작 시점 관측입니다. 세션 중 설정 변경까지 보장하지 않습니다." rows={data?.runtime || []} columns={RUNTIME} exportName="codex_runtime" stale={stale} />
            <Card title="관측 메트릭 검색">
              <input aria-label="메트릭 이름 검색" placeholder="메트릭 이름 검색" value={search} onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm" />
              <p className="mt-2 text-sm text-ink-600">카운터는 증분, Histogram은 관측 수와 평균입니다. 누적 기준값이나 원본 필드의 존재를 확인하지 못한 값은 —로 표시합니다. 비용 합계에는 더하지 않습니다.</p>
            </Card>
            <DataTable title="수집된 메트릭" columns={METRICS} rows={metrics} exportName="codex_metrics" stale={stale} />
            <DataTable title="이벤트 수집 현황" columns={[text("event", "이벤트"), numeric("count", "건수")]} rows={data?.events || []} exportName="codex_events" stale={stale} />
          </>}
          {tab === TABS[4] && <>
            <p className="text-sm text-ink-600">최근 50개 Trace의 각 최근 200개 span까지 표시합니다. 통계도 표시된 span 기준이며, 전체 조회 구간이나 완전한 턴의 통계는 아닙니다. 모델 필터는 모델 속성이 있는 span에만 적용됩니다.</p>
            {data?.coverage?.traces?.truncated_traces > 0 && <p role="status" className="text-sm text-warning-text">
              긴 Trace는 일부 span만 표시하므로 전체 소요 시간과 오류 합계를 제공하지 않습니다.
            </p>}
            {data?.coverage?.traces?.partial && <p role="status" className="text-sm text-warning-text">
              일부 Trace 데이터가 충돌해 해당 Trace의 통계를 제공하지 않습니다. 다른 신호의 집계는 유지됩니다.
            </p>}
            <DataTable title="작업별 Span 지연" columns={SPANS} rows={data?.spans || []} exportName="codex_spans" stale={stale} />
            {(data?.traces || []).length === 0 ? <EmptyState /> : data.traces.map((trace) => (
              <details key={trace.trace_id} className="rounded-lg border border-ink-200 bg-card p-4">
                <summary className="cursor-pointer break-all text-sm font-medium text-ink-700">
                  {trace.trace_id} · {formatObserved(trace.span_count)} spans · {formatObserved(trace.wall_ms)} ms · 오류 {formatObserved(trace.errors)}
                  {trace.partial && " · 불완전"}
                  {trace.truncated && " · 최근 span만 표시"}
                </summary>
                <div className="mt-4">{trace.partial
                  ? <p className="text-sm text-ink-600">같은 Span ID의 값이 충돌해 세부 내역을 보류했습니다.</p>
                  : <DataTable title={`Trace ${trace.trace_id}`} columns={TRACE_DETAIL} rows={trace.spans || []} exportName="codex_trace_spans" stale={stale} />}</div>
              </details>
            ))}
          </>}
        </>
      )}
    </section>
  );
}
