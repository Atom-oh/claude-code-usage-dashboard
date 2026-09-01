import { DataTable } from "../components/DataTable.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { useApi } from "../useApi.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const usd = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

// 2026-08-11 STEP 3/4 — 신뢰성(refusal/재시도) + A/B 무결성(버전 코호트) 신규 패널 전용 페이지.
// 기존 페이지(Productivity/Usage)와 성격이 달라(생산성/사용량이 아니라 "이 A/B 비교를 믿어도
// 되는가") 별도 페이지로 분리한다.
const REFUSAL_COLUMNS = [
  { key: "group", label: "그룹" },
  { key: "user_visible_refusals", label: "사용자가 본 refusal", render: fmt },
  { key: "server_hidden_refusals", label: "서버가 이미 재시도(비노출)", render: fmt },
];

const RETRY_COLUMNS = [
  { key: "group", label: "그룹" },
  { key: "exhausted_retries", label: "재시도 소진 건수", render: fmt },
  { key: "avg_total_attempts", label: "평균 시도 횟수" },
  { key: "avg_retry_duration_ms", label: "평균 재시도 시간(ms)", render: fmt },
];

// 2026-08-31 — API 에러율. 서버가 {byModel, byStatus} 두 갈래를 한 응답으로 내려준다(다른
// 라우트들처럼 배열이 아니다).
// error_rate 분모는 api_request + api_error다 — api_request가 실패 요청을 포함하는지가 실측으로
// 확정되지 않아 두 해석 모두에서 [0,1]에 갇히는 쪽을 골랐다(queries.js apiErrors 주석 참고).
const API_ERROR_MODEL_COLUMNS = [
  { key: "group", label: "그룹" },
  { key: "model", label: "모델" },
  { key: "requests", label: "api_request", render: fmt },
  { key: "errors", label: "api_error", render: fmt },
  { key: "error_rate", label: "에러율", render: (v) => `${(Number(v || 0) * 100).toFixed(2)}%` },
];

// 'no-http-status'는 status_code 자체가 없는 에러(실측 2026-08-31: 580건 중 35건) — HTTP 상태가
// 아니라 전송 계층 실패(예: Stream idle timeout)라 숫자 상태코드와 섞이지 않게 라벨을 달리 준다.
const API_ERROR_STATUS_COLUMNS = [
  { key: "group", label: "그룹" },
  { key: "status_code", label: "HTTP 상태", render: (v) => (v === "no-http-status" ? "HTTP 상태 없음" : v) },
  { key: "errors", label: "에러 건수", render: fmt },
];

const VERSION_SESSION_COLUMNS = [
  { key: "group", label: "그룹" },
  { key: "app_version", label: "Claude Code 버전" },
  { key: "sessions", label: "세션 수", render: fmt },
];

const VERSION_COST_COLUMNS = [
  { key: "group", label: "그룹" },
  { key: "version_cohort", label: "버전 코호트" },
  { key: "cost_usd", label: "비용(추정)", render: usd },
  { key: "tokens", label: "토큰", render: fmt },
  { key: "usd_per_million_tokens", label: "USD / 백만 토큰" },
];

export default function Reliability() {
  const refusals = useApi("/api/reliability/refusals");
  const retries = useApi("/api/reliability/retries-exhausted");
  const apiErrors = useApi("/api/reliability/api-errors");
  const versionSessions = useApi("/api/integrity/version-cohort-sessions");
  const versionCost = useApi("/api/integrity/version-cohort-cost");

  return (
    <div>
      <PageHeader
        title="Reliability"
        subtitle="refusal/재시도 신뢰성 + A/B 버전 무결성 — 두 그룹이 실제로 비교 가능한 상태인지 확인"
        right={<RangePicker />}
      />
      <div className="p-8 flex flex-col gap-4">
        {refusals.loading ? (
          <Loading />
        ) : refusals.error ? (
          <ErrorBox error={refusals.error} />
        ) : (
          <DataTable
            title="Refusal 율"
            subtitle="'서버가 이미 재시도(비노출)'는 사용자가 못 본 refusal — 그룹 비교 시 제외할 것"
            columns={REFUSAL_COLUMNS}
            rows={refusals.data || []}
          />
        )}

        {retries.loading ? (
          <Loading />
        ) : retries.error ? (
          <ErrorBox error={retries.error} />
        ) : (
          <DataTable
            title="API 재시도 소진"
            subtitle="Bedrock 온디맨드 쿼터 병목 탐지 — 그룹 간 비대칭이면 강한 신호"
            columns={RETRY_COLUMNS}
            rows={retries.data || []}
          />
        )}

        {apiErrors.loading ? (
          <Loading />
        ) : apiErrors.error ? (
          <ErrorBox error={apiErrors.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <DataTable
              title="API 에러율"
              subtitle="Bedrock 스로틀링/검증 오류의 조기 신호 — 에러가 한쪽 그룹에만 몰리면 그 그룹의 생산성 하락은 장애 탓이다"
              columns={API_ERROR_MODEL_COLUMNS}
              rows={apiErrors.data?.byModel || []}
            />
            <DataTable
              title="API 에러 상태코드 분포"
              subtitle="'HTTP 상태 없음'은 상태코드가 아예 없는 전송 계층 실패(예: Stream idle timeout) — 버리지 않고 따로 센다"
              columns={API_ERROR_STATUS_COLUMNS}
              rows={apiErrors.data?.byStatus || []}
            />
          </div>
        )}

        {versionSessions.loading ? (
          <Loading />
        ) : versionSessions.error ? (
          <ErrorBox error={versionSessions.error} />
        ) : (
          <DataTable
            title="Claude Code 버전 혼재 검증"
            subtitle="두 그룹이 다른 버전을 쓰면 A/B 자체가 오염될 수 있다 — 그룹당 버전이 하나로 모여야 이상적"
            columns={VERSION_SESSION_COLUMNS}
            rows={versionSessions.data || []}
          />
        )}

        {versionCost.loading ? (
          <Loading />
        ) : versionCost.error ? (
          <ErrorBox error={versionCost.error} />
        ) : (
          <DataTable
            title="버전 코호트별 이중계상 실측"
            subtitle="v2.1.214 이전 이중계상 버그가 있었는지 실측 — 코호트 간 USD/백만 토큰이 크게 다르면 의심할 것 (근사치, 실비용 비교 아님)"
            columns={VERSION_COST_COLUMNS}
            rows={versionCost.data || []}
          />
        )}
      </div>
    </div>
  );
}
