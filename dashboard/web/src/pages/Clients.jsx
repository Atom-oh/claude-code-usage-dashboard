import { useMemo } from "react";
import { Card, ErrorBox, Loading } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { DualLineChart } from "../components/GroupCharts.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { StatTile } from "../components/StatTile.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { CLIENT_LABELS, useClient } from "../ClientContext.jsx";
import { useConfig } from "../ConfigContext.jsx";
import { useApi } from "../useApi.js";
import { maskEmail } from "../fmt.js";
import { clientTimeline, formatClientCost, formatObserved } from "../clientUsage.js";

const BASIS_LABELS = { client_reported: "클라이언트 보고", aws_list_estimate: "AWS 정가 추정" };
const labelClient = (value) => CLIENT_LABELS[value] || value || "—";
const labelBasis = (value) => BASIS_LABELS[value] || "—";
const text = (value) => value || "—";
const numberColumn = (key, label) => ({ key, label, render: formatObserved });
const CLIENT_COLUMN = { key: "client", label: "클라이언트", render: labelClient, toText: labelClient };
const BACKEND_COLUMN = { key: "backend", label: "백엔드", render: text };
const COST_COLUMN = { key: "cost_usd", label: "비용 (USD)", render: formatClientCost };
const BASIS_COLUMN = { key: "cost_basis", label: "비용 기준", render: labelBasis, toText: labelBasis };
const USAGE_COLUMNS = [
  numberColumn("sessions", "세션"), numberColumn("tokens", "전체 토큰"),
  numberColumn("input_tokens", "입력 (캐시 제외)"), numberColumn("cache_read_tokens", "캐시 읽기"),
  numberColumn("cache_write_tokens", "캐시 쓰기"), numberColumn("output_tokens", "출력 (추론 포함)"),
  numberColumn("reasoning_tokens", "추론 (출력의 일부)"), COST_COLUMN, BASIS_COLUMN,
];
const CLIENT_COLUMNS = [CLIENT_COLUMN, BACKEND_COLUMN, numberColumn("users", "활성 사용자"), ...USAGE_COLUMNS];
const MODEL_COLUMNS = [CLIENT_COLUMN, BACKEND_COLUMN, { key: "model", label: "모델", render: text }, ...USAGE_COLUMNS];
const USER_COLUMNS = [CLIENT_COLUMN, { key: "user", label: "사용자", render: maskEmail }, BACKEND_COLUMN, ...USAGE_COLUMNS];
const PROJECT_COLUMNS = [CLIENT_COLUMN, { key: "project", label: "프로젝트", render: (v) => v || "(미지정)" }, BACKEND_COLUMN, ...USAGE_COLUMNS];
const OPERATIONS_COLUMNS = [
  CLIENT_COLUMN, BACKEND_COLUMN, numberColumn("requests", "API 요청"), numberColumn("api_errors", "API 오류"),
  numberColumn("tool_calls", "도구 호출"), numberColumn("tool_errors", "도구 오류"),
  numberColumn("request_duration_ms", "평균 API 요청 시간 (ms)"), numberColumn("ttft_ms", "평균 첫 토큰 시간 (ms)"),
];
const TOOL_COLUMNS = [
  CLIENT_COLUMN, { key: "tool", label: "도구", render: text }, numberColumn("calls", "호출"),
  numberColumn("errors", "오류"), numberColumn("duration_ms", "시간 (ms)"),
];
const TOKEN_TILES = [
  ["input_tokens", "입력 (캐시 제외)"], ["cache_read_tokens", "캐시 읽기"],
  ["cache_write_tokens", "캐시 쓰기"], ["output_tokens", "출력 (추론 포함)"],
  ["reasoning_tokens", "추론 (출력의 일부)"],
];
const formatTime = (t) => new Date(`${t.replace(" ", "T")}Z`).toLocaleString("ko-KR", {
  timeZone: "UTC", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
});
const formatMs = (value) => value == null ? "—" : `${formatObserved(value)} ms`;

export default function Clients() {
  const { client, enabledClients } = useClient();
  const { codexEndpoint } = useConfig();
  const { data, loading, error } = useApi("/api/clients/overview", { client });
  const timeline = useMemo(() => clientTimeline(data?.timeseries || []), [data?.timeseries]);
  const clients = client === "all" ? enabledClients : [client];
  const lines = clients.flatMap((name) => [
    { key: `${name}_tokens`, label: `${labelClient(name)} 토큰` },
    { key: `${name}_cost`, label: `${labelClient(name)} 비용 (USD)`, axis: "right" },
  ]);
  const totals = data?.totals || {};
  const quality = data?.quality || {};
  const empty = data && (data.observed_records === 0 ||
    (data.observed_records == null && !["by_model", "by_user", "timeseries", "tools"].some((key) => data[key]?.length)));

  return (
    <div>
      <PageHeader
        title="사용량·비용"
        subtitle={`${client === "all" ? "Claude Code + Codex" : "Codex"} · 사용량, 모델, 사용자와 도구 현황`}
        right={<RangePicker />}
      />
      <div className="p-4 sm:p-8 flex flex-col gap-6">
        {loading ? <Loading /> : error ? <ErrorBox error={error} /> : empty ? <EmptyState /> : (
          <>
            <p className="text-[12px] text-ink-500">
              Claude Code 비용은 클라이언트 보고값, Codex 비용은 AWS 정가 추정치입니다.
              실제 청구 금액과 다를 수 있습니다. 미수집·미산정 값은 —로 표시합니다.
              {clients.includes("codex") && ` Codex 기본 연결 설정: ${codexEndpoint === "runtime" ? "Runtime" : "Mantle"}.`}
            </p>
            {data?.effective_range?.to !== data?.effective_range?.requested_to && data?.effective_range?.to && (
              <p role="status" className="text-[12px] text-ink-500">
                집계 종료 시각: {data.effective_range.to.replace("T", " ").replace(/(?:\.\d+)?Z$/, "")} UTC.
                과거 시간별 집계에 맞춰 모든 클라이언트에 같은 종료 시각을 적용했습니다.
              </p>
            )}
            {(quality.unpriced > 0 || quality.invalid > 0 || totals.unpriced > 0) && (
              <div role="status" className="rounded-lg border border-warning-border bg-warning-surface px-4 py-3 text-[13px] text-warning-text">
                미산정 {formatObserved(quality.unpriced ?? totals.unpriced)} · 유효하지 않은 데이터 {formatObserved(quality.invalid)}.
                일부 비용이 확인되지 않아 합계가 제공되지 않을 수 있습니다.
              </div>
            )}
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              <StatTile label="비용 (USD)" value={formatClientCost(totals.cost_usd)} variant="accent" help="같은 조회 결과의 비용 합계입니다. 미산정 비용이 포함되면 합계를 표시하지 않습니다." />
              <StatTile label="전체 토큰" value={formatObserved(totals.tokens)} help="캐시를 제외한 입력 + 캐시 읽기 + 캐시 쓰기 + 출력입니다. 추론은 출력에 포함됩니다." />
              <StatTile label="세션" value={formatObserved(totals.sessions)} />
              <StatTile label="관측 사용자 ID" value={formatObserved(totals.users)} help="클라이언트가 보낸 사용자 식별자를 중복 제거한 수입니다. 실제 직원 명부나 클라이언트별 사용자 수의 합이 아닙니다." />
              <StatTile label="API 요청" value={formatObserved(totals.requests)} />
              <StatTile label="API 오류" value={formatObserved(totals.api_errors)} />
              <StatTile label="도구 호출" value={formatObserved(totals.tool_calls)} />
              <StatTile label="첫 토큰 시간" value={formatMs(totals.ttft_ms)} help="관측된 첫 토큰까지의 시간입니다. 누락된 측정값은 0으로 대체하지 않습니다." />
            </div>
            <Card title="토큰 구성" subtitle="입력 + 캐시 읽기 + 캐시 쓰기 + 출력 = 전체 토큰 · 추론은 출력의 일부">
              <div className="grid grid-cols-2 xl:grid-cols-5 gap-4">
                {TOKEN_TILES.map(([key, label]) => <StatTile key={key} label={label} value={formatObserved(totals[key])} />)}
              </div>
            </Card>
            <DualLineChart
              title="사용량·비용 추이" subtitle={`${data?.bucket_hours < 1 ? "분별" : "시간별"} · UTC · 비용 누락 구간은 연결하지 않습니다.`}
              rows={timeline} xKey="t" lines={lines} tickFormatter={formatTime} bucketHours={data?.bucket_hours || 1} height={320}
            />
            <DataTable title="클라이언트별 사용량" columns={CLIENT_COLUMNS} rows={data?.by_client || []} exportName="clients_usage" />
            <DataTable title="모델별 사용량" columns={MODEL_COLUMNS} rows={data?.by_model || []} exportName="clients_models" />
            <DataTable title="사용자별 사용량" columns={USER_COLUMNS} rows={data?.by_user || []} exportName="clients_users" />
            {clients.includes("codex") && <DataTable title="Codex 프로젝트별 사용량" subtitle="클라이언트의 project.name 태그 기준입니다. AWS 청구 프로젝트와는 별도입니다." columns={PROJECT_COLUMNS} rows={data?.by_project || []} exportName="clients_projects" />}
            <DataTable title="요청·오류·응답 시간" subtitle="API 요청 시간은 전체 생성 시간이 아닙니다. 시간 값은 서버 집계 기준입니다." columns={OPERATIONS_COLUMNS} rows={data?.by_client || []} exportName="clients_operations" />
            <DataTable title="도구 사용" columns={TOOL_COLUMNS} rows={data?.tools || []} exportName="clients_tools" />
          </>
        )}
      </div>
    </div>
  );
}
