import { richMessage, localeTag, localize, translate, useLocale } from "../i18n/index.js";
import { useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Card, ErrorBox, Loading } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { StatTile } from "../components/StatTile.jsx";
import EmptyState from "../components/EmptyState.jsx";
import CodexEfficiency from "./CodexEfficiency.jsx";
import { useApi } from "../useApi.js";
import { formatClientCost, formatObserved, observedTokens } from "../clientUsage.js";
import { costBasisLabel, formatClientTimestamp, tokenStatusLabel } from "../clientPresentation.js";

const percent = (v) => v == null ? "—" : `${(v * 100).toLocaleString(localeTag(), { maximumFractionDigits: 2 })}%`;
const text = (key, label) => ({ key, label, render: (v) => v || "—" });
const numeric = (key, label) => ({ key, label, render: formatObserved });
const ratio = (key, label) => ({ key, label, render: percent });
const cost = (key, label) => ({ key, label, render: formatClientCost });
const TABS = localize(["효율·Effort", "도구·승인", "성능", "런타임·메트릭", "Trace"]);
const PROFILES = { "효율·Effort": "effort", "도구·승인": "tools", "성능": "performance" };
const STATUS = localize({ observed: "수집 확인", empty: "관측 없음", unavailable: "수집 미확인", limited: "조회 한도 초과" });
const codexCostLabel = (row) => costBasisLabel({ ...row, cost_basis: "aws_list_estimate" });
const EFFORT = localize([text("effort", "Effort"), numeric("requests", "완료 응답"), numeric("observed_tokens", "관측 토큰"),
  text("token_status", "토큰 상태"),
  cost("cost_usd", "추정 비용 (USD)"), numeric("unpriced", "미산정"),
  { key: "cost_basis_label", label: "비용 기준·미산정",
    render: (value) => <span className="block min-w-[10rem]">{value}</span>, toText: (value) => value },
  ratio("cache_hit_rate", "캐시 읽기 비율"), ratio("reasoning_share", "추론 비중")]);
const TOOLS = localize([text("tool", "도구"), numeric("calls", "호출"), numeric("successes", "성공"),
  numeric("failures", "실패"), numeric("unknown", "결과 미확인"), ratio("success_rate", "성공률"),
  numeric("average_ms", "평균 (ms)"), numeric("p95_ms", "P95 (ms)")]);
const APPROVALS = localize([text("tool", "도구"), text("decision", "결정"), text("source", "결정 출처"), numeric("count", "건수")]);
const LATENCY = localize([text("name", "측정 대상"), numeric("count", "표본"), numeric("average_ms", "평균 (ms)"),
  numeric("p50_ms", "P50 (ms)"), numeric("p95_ms", "P95 (ms)"), numeric("max_ms", "최대 (ms)")]);
const RUNTIME = localize([text("model", "모델"), text("version", "버전"), text("provider", "공급자"), text("effort", "시작 Effort"),
  text("sandbox_policy", "Sandbox"), text("approval_policy", "승인 정책"), numeric("sessions", "세션")]);
const METRICS = localize([text("name", "메트릭"), text("type", "유형"), text("unit", "단위"),
  { key: "dimensions", label: "차원", render: (v) => JSON.stringify(v || {}), toText: (v) => JSON.stringify(v || {}) },
  numeric("points", "수집 표본"), numeric("value", "카운터 증분 / 최근 Gauge"),
  numeric("count", "Histogram 관측 수"), numeric("mean", "평균"), numeric("min", "최소"), numeric("max", "최대"),
  { key: "partial", label: "구간 상태", render: (v) => v ? translate("m2559b2f335d9") : translate("m1aacb54c4992"), toText: (v) => v ? translate("m2559b2f335d9") : translate("m1aacb54c4992") }]);
const SPANS = localize([text("name", "Span"), numeric("count", "건수"), numeric("errors", "오류 상태"),
  numeric("average_ms", "평균 (ms)"), numeric("p95_ms", "P95 (ms)")]);
const TRACE_DETAIL = localize([text("name", "작업"), text("span_id", "Span ID"), text("parent_span_id", "부모 Span ID"),
  text("model", "모델"), text("tool_name", "도구"), text("effort", "Effort"),
  { key: "start_time", label: "시작 (브라우저 시간)", render: formatClientTimestamp, toText: formatClientTimestamp }, numeric("duration_ms", "시간 (ms)"), text("status", "상태")]);
function metricMean(rows, name, tokenType) {
  const selected = (rows || []).filter((r) => r.name === name
    && (!tokenType || r.dimensions?.token_type === tokenType));
  if (!selected.length || selected.some((r) => r.count == null || r.sum == null)) return null;
  const count = selected.reduce((n, r) => n + r.count, 0);
  return count > 0 ? selected.reduce((n, r) => n + r.sum, 0) / count : null;
}
const milliseconds = (value) => value == null ? "—" : `${formatObserved(value)} ms`;
const partialHint = (rows, name) => rows?.some((r) => r.name === name && r.partial)
  ? translate("m671de31ae493") : undefined;

export default function CodexInsights(props) {
  const _locale = useLocale();
  return props.api ? <CodexInsightsBody {...props} /> : <RequestedCodexInsights {...props} />;
}

function RequestedCodexInsights({ range, enabled = true, hold = false, sections }) {
  const _locale = useLocale();
  const bounds = range?.from && range?.to ? { from: range.from, to: range.to } : {};
  const allowedTabs = sections?.length ? TABS.filter((name) => sections.includes(name)) : TABS;
  const profile = allowedTabs.length === 1 ? PROFILES[allowedTabs[0]] : undefined;
  const api = useApi("/api/codex/insights",
    { client: "codex", ...bounds, ...(profile ? { profile } : {}) }, enabled, { linkedRange: true, hold });
  return <CodexInsightsBody api={api} enabled={enabled} sections={sections} />;
}

function CodexInsightsBody({ api, enabled = true, sections }) {
  const _locale = useLocale();
  const { data, loading, error, stale } = api;
  const allowedTabs = sections?.length ? TABS.filter((name) => sections.includes(name)) : TABS;
  const [preferredTab, setTab] = useState(TABS[0]);
  const tab = allowedTabs.includes(preferredTab) ? preferredTab : allowedTabs[0];
  const [search, setSearch] = useState("");
  const metrics = useMemo(() => (data?.metrics || []).filter((r) => r.name.toLowerCase().includes(search.toLowerCase())), [data?.metrics, search, _locale]);
  const summary = data?.summary || {};
  const help = translate("m8384921a7240")
    + (!error && enabled && !loading && data?.range
      ? translate("mec9670388829", [formatClientTimestamp(data.range.from), formatClientTimestamp(data.range.to)])
      : "");
  return (
    <section aria-labelledby="codex-insights-heading" className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <h2 id="codex-insights-heading" className="text-xl font-semibold text-ink-800">{translate("mcf989a7d79a0")}</h2>
        <Info size={14} className="shrink-0 text-ink-400" title={help} aria-label={help} />
      </div>
      {error ? <ErrorBox error={error} /> : !enabled || loading ? <Loading /> : (
        <>
          <div className="flex flex-wrap gap-2" aria-label={translate("md6d3954eb9f3")}>
            {["logs", "metrics", "traces"].filter((signal) =>
              data?.coverage?.[signal]?.status !== "not_requested").map((signal) => {
              const c = data?.coverage?.[signal];
              return <span key={signal} className="rounded-lg border border-ink-200 bg-card px-3 py-2 text-sm text-ink-700"
                title={c?.last_seen ? translate("mea77786c78f3", [formatClientTimestamp(c.last_seen)]) : translate("m25527d35b81c")}>
                {signal[0].toUpperCase() + signal.slice(1)} · {STATUS[c?.status] || translate("m36ba290fac59")}
                {c?.status === "observed" && translate("m2f8fe086f3f8", [formatObserved(c.records)])}
                {c?.partial && translate("m42f419f9b0da")}
                {signal === "traces" && c?.selection === "latest_50_traces" && translate("mbea1999fdc5b")}
              </span>;
            })}
          </div>
          {["logs", "metrics"].some((signal) => data?.coverage?.[signal]?.status === "limited") &&
            <p role="status" className="text-sm text-warning-text">{translate("m1461153ebd23")}</p>}
          {data?.coverage?.logs?.limited_sections?.length > 0 && <p role="status" className="text-sm text-warning-text">{translate("m9b0f391b8d48")}</p>}
          {allowedTabs.length > 1 && <div className="flex flex-wrap gap-2" aria-label={translate("mbe07db24d3d9")}>
            {allowedTabs.map((name) => <button key={name} type="button" aria-pressed={tab === name} onClick={() => setTab(name)}
              className={`rounded-lg border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 ${tab === name
                ? "border-brand-500 bg-brand-600 text-white" : "border-ink-200 bg-card text-ink-700"}`}>{name}</button>)}
          </div>}
          {tab === TABS[0] && <>
            <CodexEfficiency summary={summary} completionUsage={data?.completion_usage}
              completeness={data?.completeness} />
            <DataTable title={translate("mfaccd8fb7fa7")} subtitle={translate("m7facc615af4d")}
              rows={(data?.effort || []).map((row) => ({ ...row, observed_tokens: observedTokens(row),
                token_status: tokenStatusLabel(row), cost_basis_label: codexCostLabel(row) }))}
              columns={EFFORT} exportName="codex_effort" stale={stale} />
          </>}
          {tab === TABS[1] && <>
            <div className="grid grid-cols-2 gap-4">
              <StatTile label={translate("m7a106e812ba0")} value={percent(summary.tool_success_rate)} help={translate("m50685eab7e6e")} />
              <StatTile label={translate("me3d2ea4e8a1c")} value={percent(summary.approval_rate)} help={translate("ma1b7c60c5e3d")} />
            </div>
            <DataTable title={translate("m9ad718b65dab")} columns={TOOLS} rows={data?.tools || []} exportName="codex_tools_detail" stale={stale} />
            <DataTable title={translate("m80ec68b9c495")} columns={APPROVALS} rows={data?.approvals || []} exportName="codex_approvals" stale={stale} />
          </>}
          {tab === TABS[2] && <>
            <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
              <StatTile label={translate("md0076a3d5114")} value={percent(summary.retry_rate)} help={translate("m713987f36875")} />
              <StatTile label={translate("ma00b4d99712b")} value={formatObserved(summary.api_error_rate)}
                help={translate("m60b4a2f9d598")} />
              <StatTile label={translate("m7deb89394b80")} value={milliseconds(metricMean(data?.metrics, "codex.turn.e2e_duration_ms"))}
                hint={partialHint(data?.metrics, "codex.turn.e2e_duration_ms")}
                help={translate("m9b4eecfb0b4d")} />
              <StatTile label={translate("m60ad83b14489")} value={milliseconds(metricMean(data?.metrics, "codex.turn.ttft.duration_ms"))}
                hint={partialHint(data?.metrics, "codex.turn.ttft.duration_ms")} />
              <StatTile label={translate("me36fde2306f5")} value={formatObserved(metricMean(data?.metrics, "codex.turn.tool.call"))}
                hint={partialHint(data?.metrics, "codex.turn.tool.call")} />
              <StatTile label={translate("mfe1bf2436492")} value={formatObserved(metricMean(data?.metrics, "codex.turn.token_usage", "total"))}
                hint={partialHint(data?.metrics, "codex.turn.token_usage")}
                help={translate("m23ed08363d8d")} />
            </div>
            <DataTable title={translate("m2939628cbdde")} subtitle={translate("m2aba4071bf3f")}
              columns={LATENCY} rows={data?.latency || []} exportName="codex_latency" stale={stale} />
          </>}
          {tab === TABS[3] && <>
            <div className="grid grid-cols-2 gap-4">
              <StatTile label={translate("mb6fcbcb9708a")} value={formatObserved(summary.prompts)} />
              <StatTile label={translate("m055e662c174b")} value={formatObserved(summary.prompt_length_mean)} help={translate("mf650f4fec99a")} />
            </div>
            <DataTable title={translate("m51c4e539db31")} subtitle={translate("m65bc779f410a")} rows={data?.runtime || []} columns={RUNTIME} exportName="codex_runtime" stale={stale} />
            <Card title={translate("m2289a1e0388f")}>
              <input aria-label={translate("mca6e754aef54")} placeholder={translate("mca6e754aef54")} value={search} onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm" />
              <p className="mt-2 text-sm text-ink-600">{translate("me9f19d169d18")}</p>
            </Card>
            <DataTable title={translate("md66c0215248d")} columns={METRICS} rows={metrics} exportName="codex_metrics" stale={stale} />
            <DataTable title={translate("m86d368467927")} columns={[text("event", translate("m46b289bb0a9e")), numeric("count", translate("m438641bb0f5d"))]} rows={data?.events || []} exportName="codex_events" stale={stale} />
          </>}
          {tab === TABS[4] && <>
            <p className="text-sm text-ink-600">{translate("ma733b6ed7cb1")}</p>
            {data?.coverage?.traces?.truncated_traces > 0 && <p role="status" className="text-sm text-warning-text">{translate("mc64be2b3364d")}</p>}
            {data?.coverage?.traces?.partial && <p role="status" className="text-sm text-warning-text">{translate("m64e5e5d200ff")}</p>}
            <DataTable title={translate("m2688d96b0338")} columns={SPANS} rows={data?.spans || []} exportName="codex_spans" stale={stale} />
            {(data?.traces || []).length === 0 ? <EmptyState /> : data.traces.map((trace) => (
              <details key={trace.trace_id} className="rounded-lg border border-ink-200 bg-card p-4">
                <summary className="cursor-pointer break-all text-sm font-medium text-ink-700">{richMessage("m3ef405944985", [trace.trace_id, formatObserved(trace.span_count), formatObserved(trace.wall_ms), formatObserved(trace.errors), trace.partial && translate("m10a7f30503b2"), trace.truncated && translate("mec4711ef3cbd")])}</summary>
                <div className="mt-4">{trace.partial
                  ? <p className="text-sm text-ink-600">{translate("m8c2c1fb12b63")}</p>
                  : <DataTable title={`Trace ${trace.trace_id}`} columns={TRACE_DETAIL} rows={trace.spans || []} exportName="codex_trace_spans" stale={stale} />}</div>
              </details>
            ))}
          </>}
        </>
      )}
    </section>
  );
}
