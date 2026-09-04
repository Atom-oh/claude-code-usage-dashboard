import { DataTable } from "../components/DataTable.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { useApi } from "../useApi.js";
import { effortLabel } from "../labels.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const usd = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

// render와 toText가 같아야 하는 컬럼용 — 한 번만 정의해 두 곳에 넘긴다. 원본 값을 그대로
// 내보내면 오해를 준다: effort는 ""(미보고), status_code는 'no-http-status'(전송 계층 실패),
// error_rate는 0~1 분수라서 "에러율" 컬럼 아래에 0.0234가 들어가면 100배로 잘못 읽힌다.
const statusLabel = (v) => (v === "no-http-status" ? "HTTP 상태 없음" : v);
const cohortLabel = (v) => (v === "pre-2.1.214" ? "2.1.214 이전" : v === ">=2.1.214" ? "2.1.214 이상" : v);
const pct2 = (v) => `${(Number(v || 0) * 100).toFixed(2)}%`;

// 2026-08-11 STEP 3/4 — 신뢰성(refusal/재시도) + A/B 무결성(버전 코호트) 신규 패널 전용 페이지.
// 기존 페이지(Productivity/Usage)와 성격이 달라(생산성/사용량이 아니라 "이 A/B 비교를 믿어도
// 되는가") 별도 페이지로 분리한다.
// 2026-09-01 — API 레이턴시. 레이턴시는 에러율보다 먼저 움직이는 선행 신뢰성 신호라 페이지 첫
// 행에 둔다. 서버가 {byModel, byEffort} 두 갈래를 한 응답으로 내려준다(apiErrors와 같은 형태).
// 실측 7d: p50 5968ms / p95 36262ms.
const API_LATENCY_MODEL_COLUMNS = [
  { key: "group", label: "채널" },
  { key: "model", label: "모델" },
  { key: "requests", label: "요청 수", render: fmt, bar: true },
  { key: "p50_ms", label: "p50 (ms)", render: fmt },
  { key: "p95_ms", label: "p95 (ms)", render: fmt },
];

const API_LATENCY_EFFORT_COLUMNS = [
  { key: "group", label: "채널" },
  { key: "effort", label: "Effort", render: effortLabel, toText: effortLabel },
  { key: "requests", label: "요청 수", render: fmt, bar: true },
  { key: "p50_ms", label: "p50 (ms)", render: fmt },
  { key: "p95_ms", label: "p95 (ms)", render: fmt },
];

const REFUSAL_COLUMNS = [
  { key: "group", label: "채널" },
  { key: "user_visible_refusals", label: "사용자에게 표시된 거부 응답", render: fmt },
  { key: "server_hidden_refusals", label: "서버가 자동 재시도한 거부 응답", render: fmt },
];

const RETRY_COLUMNS = [
  { key: "group", label: "채널" },
  { key: "exhausted_retries", label: "재시도 소진 건수", render: fmt },
  { key: "avg_total_attempts", label: "평균 시도 횟수" },
  { key: "avg_retry_duration_ms", label: "평균 재시도 시간 (ms)", render: fmt },
];

// 2026-08-31 — API 에러율. 서버가 {byModel, byStatus} 두 갈래를 한 응답으로 내려준다(다른
// 라우트들처럼 배열이 아니다).
// error_rate 분모는 api_request + api_error다 — api_request가 실패 요청을 포함하는지가 실측으로
// 확정되지 않아 두 해석 모두에서 [0,1]에 갇히는 쪽을 골랐다(queries.js apiErrors 주석 참고).
const API_ERROR_MODEL_COLUMNS = [
  { key: "group", label: "채널" },
  { key: "model", label: "모델" },
  { key: "requests", label: "요청 수", render: fmt },
  { key: "errors", label: "오류 수", render: fmt },
  { key: "error_rate", label: "오류율", render: pct2, toText: pct2 },
];

// 'no-http-status'는 status_code 자체가 없는 에러(실측 2026-08-31: 580건 중 35건) — HTTP 상태가
// 아니라 전송 계층 실패(예: Stream idle timeout)라 숫자 상태코드와 섞이지 않게 라벨을 달리 준다.
const API_ERROR_STATUS_COLUMNS = [
  { key: "group", label: "채널" },
  { key: "status_code", label: "HTTP 상태 코드", render: statusLabel, toText: statusLabel },
  { key: "errors", label: "오류 수", render: fmt },
];

const VERSION_SESSION_COLUMNS = [
  { key: "group", label: "채널" },
  { key: "app_version", label: "Claude Code 버전" },
  { key: "sessions", label: "세션 수", render: fmt },
];

const VERSION_COST_COLUMNS = [
  { key: "group", label: "채널" },
  { key: "version_cohort", label: "버전 구간", render: cohortLabel, toText: cohortLabel },
  { key: "cost_usd", label: "Claude Code 보고 비용", render: usd },
  { key: "tokens", label: "토큰", render: fmt },
  { key: "usd_per_million_tokens", label: "백만 토큰당 비용 ($)" },
];

export default function Reliability() {
  const apiLatency = useApi("/api/reliability/api-latency");
  const refusals = useApi("/api/reliability/refusals");
  const retries = useApi("/api/reliability/retries-exhausted");
  const apiErrors = useApi("/api/reliability/api-errors");
  const versionSessions = useApi("/api/integrity/version-cohort-sessions");
  const versionCost = useApi("/api/integrity/version-cohort-cost");

  return (
    <div>
      <PageHeader
        title="Reliability"
        subtitle="API 안정성과 두 채널의 비교 가능성 점검"
        right={<RangePicker />}
      />
      <div className="p-8 flex flex-col gap-4">
        {apiLatency.loading ? (
          <Loading />
        ) : apiLatency.error ? (
          <ErrorBox error={apiLatency.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <DataTable
              title="API 응답 시간 (모델별)"
              subtitle="요청별 응답 시간의 p50과 p95"
              help="같은 모델에서 채널 간 p95 차이가 크면 할당량이나 인프라 문제를 먼저 확인하세요."
              columns={API_LATENCY_MODEL_COLUMNS}
              rows={apiLatency.data?.byModel || []}
              exportName="reliability_api_latency_by_model"
            />
            <DataTable
              title="API 응답 시간 (Effort별)"
              subtitle="요청별 응답 시간의 p50과 p95"
              help="Effort 수준이 높을수록 응답이 느린 것은 정상입니다. 같은 Effort 수준에서 채널 간 차이가 있는지 확인하세요. Effort 정보가 없는 요청은 미지정으로 묶입니다."
              columns={API_LATENCY_EFFORT_COLUMNS}
              rows={apiLatency.data?.byEffort || []}
              exportName="reliability_api_latency_by_effort"
            />
          </div>
        )}

        {refusals.loading ? (
          <Loading />
        ) : refusals.error ? (
          <ErrorBox error={refusals.error} />
        ) : (
          <DataTable
            title="API 거부 응답"
            subtitle="모델이 요청을 거부한 응답 수"
            help="서버가 자동으로 재시도한 거부 응답은 사용자에게 보이지 않았으므로 채널 비교에서는 제외하세요."
            columns={REFUSAL_COLUMNS}
            rows={refusals.data || []}
            exportName="reliability_refusals"
          />
        )}

        {retries.loading ? (
          <Loading />
        ) : retries.error ? (
          <ErrorBox error={retries.error} />
        ) : (
          <DataTable
            title="API 재시도 소진"
            subtitle="재시도를 모두 소진한 API 요청"
            help="한 채널에만 집중되면 해당 채널의 할당량 병목을 의심할 수 있습니다."
            columns={RETRY_COLUMNS}
            rows={retries.data || []}
            exportName="reliability_retries_exhausted"
          />
        )}

        {apiErrors.loading ? (
          <Loading />
        ) : apiErrors.error ? (
          <ErrorBox error={apiErrors.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <DataTable
              title="API 오류율"
              subtitle="모델별 API 오류 비율"
              help="오류가 한 채널에 몰리면 그 채널의 생산성 저하는 장애 영향일 수 있습니다. 오류율은 요청과 오류를 합한 수 대비 오류 수입니다."
              columns={API_ERROR_MODEL_COLUMNS}
              rows={apiErrors.data?.byModel || []}
              exportName="reliability_api_errors_by_model"
            />
            <DataTable
              title="API 오류 상태 코드 분포"
              subtitle="HTTP 상태 코드별 오류 수"
              help="HTTP 상태 없음은 상태 코드를 받지 못한 오류로, 연결 시간 초과 등이 해당합니다."
              columns={API_ERROR_STATUS_COLUMNS}
              rows={apiErrors.data?.byStatus || []}
              exportName="reliability_api_errors_by_status"
            />
          </div>
        )}

        {versionSessions.loading ? (
          <Loading />
        ) : versionSessions.error ? (
          <ErrorBox error={versionSessions.error} />
        ) : (
          <DataTable
            title="Claude Code 버전 분포"
            subtitle="채널별 사용 중인 Claude Code 버전과 세션 수"
            help="두 채널이 서로 다른 버전을 쓰면 비교 결과에 영향을 줄 수 있습니다. 채널마다 버전이 하나로 모이는 것이 이상적입니다."
            columns={VERSION_SESSION_COLUMNS}
            rows={versionSessions.data || []}
            exportName="integrity_version_sessions"
          />
        )}

        {versionCost.loading ? (
          <Loading />
        ) : versionCost.error ? (
          <ErrorBox error={versionCost.error} />
        ) : (
          <DataTable
            title="버전 구간별 Claude Code 보고 비용"
            subtitle="백만 토큰당 Claude Code 보고 비용을 버전 구간 사이에서 비교"
            help="Claude Code가 직접 보고한 비용을 버전 구간별로 비교합니다. 백만 토큰당 비용이 구간 사이에 크게 다르면 특정 버전의 비용 집계 방식 차이를 의심할 수 있습니다. 근사치이며 실제 청구액 비교가 아닙니다."
            columns={VERSION_COST_COLUMNS}
            rows={versionCost.data || []}
            exportName="integrity_version_cost"
          />
        )}
      </div>
    </div>
  );
}
