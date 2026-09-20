import { useMemo } from "react";
import { formatClientTimestamp } from "../clientPresentation.js";
import { Card, ErrorBox, Loading } from "../components/Card.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { CLIENT_LABELS, useClient } from "../ClientContext.jsx";
import { CLIENT_PAGES } from "../clientNavigation.js";
import { useApi } from "../useApi.js";
import { formatObserved } from "../clientUsage.js";
import ClientPanels from "./ClientPanels.jsx";
import CodexInsights from "./CodexInsights.jsx";

const INSIGHT_SECTIONS = {
  productivity: ["효율·Effort"], cost: ["효율·Effort"], usage: ["도구·승인"],
  reliability: ["성능"], analytics: ["런타임·메트릭", "Trace"],
};

export default function Clients({ page = "overview" }) {
  const { client, enabledClients, setDetail } = useClient();
  const { data, loading, error } = useApi("/api/clients/overview", { client });
  const clients = useMemo(() => client === "all" ? enabledClients : [client], [client, enabledClients]);
  const definition = CLIENT_PAGES.find((p) => p.key === page) || CLIENT_PAGES[0];
  const quality = data?.quality || {};
  const hasUnpricedCost = data?.totals?.cost_partial === true || quality.unpriced > 0 || data?.totals?.unpriced > 0;
  const empty = data?.observed_records === 0 && !data?.timeseries?.length;
  const sections = INSIGHT_SECTIONS[page];

  return <div data-client-page={page}>
    <PageHeader title={definition.label}
      subtitle={`${clients.map((name) => CLIENT_LABELS[name]).join(" + ")} · ${definition.hint}`}
      right={<RangePicker />} />
    <div className="p-4 sm:p-8 flex flex-col gap-6">
      <p className="text-sm text-ink-600">
        Claude Code는 클라이언트 보고 비용, Codex는 AWS 정가 추정 비용입니다.
        확인된 보고·추정 비용만 합산하고 미산정 비용은 제외합니다.
        일부가 제외되면 부분합, 비용이 모두 미산정이면 —로 표시합니다. 실청구와 다를 수 있습니다.
      </p>
      {data?.effective_range?.to !== data?.effective_range?.requested_to && data?.effective_range?.to &&
        <p role="status" className="text-sm text-ink-600">
          집계 종료 시각: {formatClientTimestamp(data.effective_range.to)} (브라우저 시간).
          선택한 클라이언트 모두 같은 구간을 사용합니다.
        </p>}
      {(hasUnpricedCost || quality.invalid > 0) &&
        <div role="status" className="rounded-lg border border-warning-border bg-warning-surface px-4 py-3 text-sm text-warning-text">
          {hasUnpricedCost && <>미산정 {formatObserved(quality.unpriced ?? data?.totals?.unpriced)}건 제외 · </>}
          유효하지 않은 데이터 {formatObserved(quality.invalid)}.
          {hasUnpricedCost && <> 알려진 비용만 부분합으로 표시하며, 비용이 모두 미산정이면 —로 표시합니다.</>}
          {" "}토큰 누락 여부는 별도로 유지합니다.
        </div>}
      {(quality.missing_usage > 0 || data?.totals?.tokens_partial === true) &&
        <p role="status" aria-label="토큰 사용량 미확인" className="text-sm text-ink-600">
          일부 사용량 정보가 불완전해 관측 토큰은 확인된 값의 부분합으로 표시합니다.
          확인된 합계가 없으면 —로 표시하며, 토큰 비율은 불완전한 합계로 계산하지 않습니다.
        </p>}
      {loading ? <Loading /> : error ? <ErrorBox error={error} /> : empty ? <EmptyState />
        : <section data-shared-client-panels><ClientPanels page={page} data={data} clients={clients} /></section>}
      {sections && clients.includes("codex") && <CodexInsights
        sections={sections} range={!loading && !error ? data?.effective_range : null} enabled={!loading} />}
      {(page === "productivity" || page === "analytics") &&
        <Card title="지표 지원 범위">
          <p className="text-sm text-ink-600">
            토큰·비용·사용자·도구·오류는 같은 기준의 화면에서 확인합니다.
            LOC·커밋·PR 기반 활동은 Claude 전용 지표이며, Codex에서는 추가 계측이 필요합니다.
            관측값은 코드 품질이나 절감 시간을 증명하지 않습니다.
          </p>
          {client === "claude" && <button type="button" onClick={() => setDetail(true)}
            className="mt-3 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-700">
            Claude 전용 분석 열기
          </button>}
        </Card>}
    </div>
  </div>;
}
