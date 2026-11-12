import { useMemo, useState } from "react";
import { formatClientTimestamp } from "../clientPresentation.js";
import { Card, ErrorBox, Loading } from "../components/Card.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { CLIENT_LABELS, useClient } from "../ClientContext.jsx";
import { CLIENT_PAGES } from "../clientNavigation.js";
import { useApi } from "../useApi.js";
import ClientPanels from "./ClientPanels.jsx";
import CodexInsights from "./CodexInsights.jsx";
import Analytics from "./Analytics.jsx";
import { OutcomeMetricsNotice } from "./ProductivitySignals.jsx";
import { useRange } from "../RangeContext.jsx";
import { useFilters } from "../FilterContext.jsx";
import { SegmentedControl } from "../components/SegmentedControl.jsx";
import { costDefaultResolution, costResolutionLabel, costResolutionOptions } from "../costResolution.js";
import CostBreakdowns from "../components/CostBreakdowns.jsx";
import { hasProductivityObservations } from "../clientProductivity.js";
import TokenEconomics from "./TokenEconomics.jsx";

// Productivity carries no Codex insights block: its tool/approval/latency sections cover every
// client, and the Codex efficiency summary and effort table stay on Cost.
const INSIGHT_SECTIONS = {
  cost: ["효율·Effort"], usage: ["도구·승인"],
  reliability: ["성능"], analytics: ["런타임·메트릭", "Trace"],
};

export default function Clients({ page = "overview" }) {
  const { client, enabledClients, setDetail } = useClient();
  const { from, to, intervalHours: defaultHours } = useRange();
  const { user, model, backend, team } = useFilters();
  const rangeKey = `${from.getTime()}|${to.getTime()}`;
  const [resolution, setResolution] = useState(null);
  const costTrends = page === "cost" || page === "trends";
  const resolutionOptions = costResolutionOptions(to - from);
  const hours = resolution?.key === rangeKey && resolutionOptions.includes(resolution.hours)
    ? resolution.hours : costDefaultResolution(to - from, defaultHours);
  // Cost/exec/trends use the separate modelTime=1 cost cache profile. Moving between them and the
  // others changes useApi's identity, so that switch reloads instead of retaining the data.
  const modelTime = page === "cost" || page === "exec" || page === "trends";
  const { data, loading, error, stale } = useApi("/api/clients/overview", {
    client, ...(modelTime ? { modelTime: "1", view: "cost", timeFormat: "compact" } : {}), ...(costTrends ? { intervalHours: hours } : {}),
  });
  const clients = useMemo(() => client === "all" ? enabledClients : [client], [client, enabledClients]);
  // Trends compare the effective (trimmed) window with a preceding window of exactly its length.
  // With Claude over four hours the server floors historical ends to the hour, so the baseline
  // ends at the hour at or before the current start and is never trimmed itself.
  const previousRange = useMemo(() => {
    const from = Date.parse(data?.effective_range?.from), to = Date.parse(data?.effective_range?.to);
    if (page !== "trends" || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
    const end = clients.includes("claude") && to - from > 4 * 3600000 ? Math.floor(from / 3600000) * 3600000 : from;
    return { from: new Date(end - (to - from)).toISOString(), to: new Date(end).toISOString() };
  }, [page, clients, data?.effective_range?.from, data?.effective_range?.to]);
  const previousApi = useApi("/api/clients/overview", { client, view: "cost", ...(previousRange || {}) }, previousRange !== null);
  // A baseline whose effective window differs from the requested one (stale while refetching,
  // or trimmed) is never compared as current.
  const baselineWindow = previousApi.data?.effective_range;
  const previous = { ...previousApi, stale: previousApi.stale || !previousRange
    || Date.parse(baselineWindow?.from) !== Date.parse(previousRange.from)
    || Date.parse(baselineWindow?.to) !== Date.parse(previousRange.to) };
  const definition = CLIENT_PAGES.find((p) => p.key === page) || CLIENT_PAGES[0];
  const quality = data?.quality || {};
  const empty = data?.observed_records === 0 && !data?.timeseries?.length;
  const sections = INSIGHT_SECTIONS[page];
  const effortBounds = data?.effective_range?.from && data?.effective_range?.to
    ? { from: data.effective_range.from, to: data.effective_range.to } : {};
  const effortEnabled = page === "cost" && !loading && !error && Boolean(effortBounds.from);
  const claudeEffort = useApi("/api/clients/claude-effort", { client: "claude", ...effortBounds },
    effortEnabled && clients.includes("claude"), { linkedRange: true, hold: stale });
  const codexEffort = useApi("/api/codex/insights", { client: "codex", profile: "effort", ...effortBounds },
    effortEnabled && clients.includes("codex"), { linkedRange: true, hold: stale });
  // Productivity rows join the overview's by_client rows over the overview's effective bounds.
  const productivity = useApi("/api/clients/productivity", { client, ...effortBounds },
    page === "productivity" && !loading && !error && Boolean(effortBounds.from), { linkedRange: true, hold: stale });
  // Token economics floors the same bounds to the hour; its trend follows the range's bucket.
  const tokenEconomics = useApi("/api/clients/token-economics", { client, intervalHours: hours, ...effortBounds },
    page === "productivity" && !loading && !error && Boolean(effortBounds.from), { linkedRange: true, hold: stale });
  // The overview's observed records omit productivity-only evidence (prompts, spans, outcome
  // and active-time counters), so on Productivity an empty overview waits for the productivity
  // response and shows the sections when it has observations.
  const productivityPage = page === "productivity" && effortBounds.from;
  // A failed productivity request is shown as an error in its sections, never as "no data".
  const pageEmpty = empty && !(productivityPage && (productivity.loading || productivity.error
    || hasProductivityObservations(productivity.data)));
  const productivityPending = empty && productivityPage && productivity.loading;
  const breakdowns = page === "cost" ? <CostBreakdowns clients={clients} data={data}
    loading={loading} error={error} empty={empty} claudeEffort={claudeEffort} codexEffort={codexEffort} /> : null;

  return <div data-client-page={page}>
    <PageHeader title={definition.label}
      subtitle={`${clients.map((name) => CLIENT_LABELS[name]).join(" + ")} · ${definition.hint}`}
      right={<RangePicker />} />
    <div className="p-4 sm:p-8 flex flex-col gap-6">
      {/* 공통 뷰에서도 Analytics는 진단 위에 같은 질문 입력·프리셋·대화를 둔다(권한이 없으면 렌더하지 않음). */}
      {page === "analytics" && <Analytics embedded />}
      <p className="text-sm text-ink-600">
        Claude Code는 보고 비용을 기본으로 표시하며, Anthropic 외 모델은 AWS 정가 추정 비용입니다.
        보고가 없어 계산으로 채운 비용은 별도 추정으로 표시합니다. Codex는 AWS 정가 추정 비용입니다.
      </p>
      {data?.effective_range?.to !== data?.effective_range?.requested_to && data?.effective_range?.to &&
        <p role="status" className="text-sm text-ink-600">
          집계 종료 시각: {formatClientTimestamp(data.effective_range.to)} (브라우저 시간).
          선택한 클라이언트 모두 같은 구간을 사용합니다.
        </p>}
      {(quality.missing_usage > 0 || data?.totals?.tokens_partial === true) &&
        <p role="status" aria-label="토큰 사용량 미확인" className="text-sm text-ink-600">
          일부 사용량 정보가 불완전해 관측 토큰은 확인된 값의 부분합으로 표시합니다.
          확인된 합계가 없으면 —로 표시하며, 토큰 비율은 불완전한 합계로 계산하지 않습니다.
        </p>}
      {costTrends && <div className="flex flex-wrap items-center justify-between gap-2" aria-label="비용추이 해상도">
        <span className="text-sm font-medium text-ink-700">추이 해상도</span>
        <SegmentedControl options={[...new Set([...resolutionOptions, hours])].sort((a, b) => a - b)
          .map((value) => ({ value: String(value), label: costResolutionLabel(value) }))}
          className="max-w-full flex-wrap"
          value={String(hours)} onChange={(value) => setResolution({ key: rangeKey, hours: Number(value) })} />
        <p className="w-full text-[12px] text-ink-500">1일 이하는 10분까지 선택할 수 있습니다. 더 긴 기간은 시간·일·주 단위로 집계합니다.</p>
      </div>}
      {loading || productivityPending ? <Loading /> : error ? <ErrorBox error={error} /> : pageEmpty ? <EmptyState />
        : <>{productivityPage && <TokenEconomics api={tokenEconomics} range={data?.effective_range}
          clients={clients} stale={stale} />}
        <section data-shared-client-panels><ClientPanels key={`${page}|${client}|${user}|${model}|${backend}|${team}`}
          page={page} data={data} clients={clients} stale={stale}
          previous={page === "trends" ? previous : undefined} breakdowns={breakdowns}
          productivity={page === "productivity" ? productivity : undefined} /></section></>}
      {(loading || error || pageEmpty) && breakdowns}
      {/* hold: 부모가 기간 변경 응답을 기다리는 동안 상세 패널은 부모의 옛 경계로 요청하지 않는다. */}
      {sections && clients.includes("codex") && <CodexInsights sections={sections}
        range={!loading && !error ? data?.effective_range : null} enabled={page === "cost" ? effortEnabled : !loading}
        hold={stale} api={page === "cost" ? { ...codexEffort, error: error || codexEffort.error } : undefined} />}
      {(page === "productivity" || page === "analytics") &&
        <Card title="지표 지원 범위">
          <p className="text-sm text-ink-600">
            토큰·비용·사용자·도구·오류는 같은 기준의 화면에서 확인합니다.
            LOC·커밋·PR 기반 활동과 활동 지수는 Claude 전용 지표이며, Codex에서는 추가 계측이 필요합니다.
            관측값은 코드 품질이나 절감 시간을 증명하지 않습니다.
          </p>
          {page === "productivity" && clients.includes("codex") && <p className="mt-2 text-sm text-ink-600">
            Codex 효율 요약과 Effort별 사용량·비용은 비용 페이지의 Codex 상세에서 확인합니다.
          </p>}
          {client === "claude" && <button type="button" onClick={() => setDetail(true)}
            className="mt-3 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-700">
            Claude 전용 분석 열기
          </button>}
        </Card>}
      {page === "productivity" && <OutcomeMetricsNotice />}
    </div>
  </div>;
}
