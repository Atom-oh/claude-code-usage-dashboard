import { localeTag, localize, translate, useLocale } from "../i18n/index.js";
import { DataTable } from "../components/DataTable.jsx";
import { Badge } from "../components/Badge.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { useApi } from "../useApi.js";
import { effortLabel } from "../labels.js";

const fmt = (n) => Number(n || 0).toLocaleString(localeTag());
// null is unavailable spend (e.g. non-Anthropic models without a factor), never $0.
const usd = (n) => n == null ? "—" : `$${Number(n).toLocaleString(localeTag(), { maximumFractionDigits: 2 })}`;

// render와 toText가 같아야 하는 컬럼용 — 한 번만 정의해 두 곳에 넘긴다. 원본 값을 그대로
// 내보내면 오해를 준다: effort는 ""(미보고), status_code는 'no-http-status'(전송 계층 실패),
// error_rate는 0~1 분수라서 "에러율" 컬럼 아래에 0.0234가 들어가면 100배로 잘못 읽힌다.
const statusLabel = (v) => (v === "no-http-status" ? translate("m552cdf4390dc") : v);
const cohortLabel = (v) => (v === "pre-2.1.214" ? translate("mbeb61bde8bc5") : v === ">=2.1.214" ? translate("mb769f5f39488") : v);
const pct2 = (v) => `${(Number(v || 0) * 100).toFixed(2)}%`;
// 계산 비용/비율 셀 — 단가표 밖 모델(unpriced)은 "$0"이 아니라 "미산정"이다(Cost.jsx와 같은 규칙).
const computedCostText = (_v, r) => (r.unpriced ? translate("ma8761601c736") : usd(r.cost));
// 비율은 null 검사를 반드시 먼저 한다: ratio 0(그 버전이 cost_usd를 아예 0으로 보고)은 이 패널이
// 가장 잡고 싶은 극단값인데, falsy 검사(`!v`)로 걸러내면 "—"로 사라진다.
const ratioText = (v) => (v == null ? "" : `${Number(v).toFixed(2)}×`);
const ratioBadge = (v) => {
  if (v == null) return <span className="text-ink-400">—</span>;
  const text = `${Number(v).toFixed(2)}×`;
  return Math.abs(Number(v) - 1) > 0.15 ? <Badge tone="negative">{text}</Badge> : text;
};
// cost_5m/cost_1h는 unpriced(단가표 밖 모델)면 null — computedCostText와 같은 규칙으로 "미산정"을
// 보여준다. r.unpriced 하나로 세 계산 비용 컬럼(cost/cost_5m/cost_1h)이 함께 미산정 처리된다.
const scenarioCostText = (v, r) => (r.unpriced ? translate("ma8761601c736") : usd(v));
const scenarioCostCell = (v, r) => (r.unpriced ? <Badge tone="neutral">{translate("ma8761601c736")}</Badge> : usd(v));
// ttl_share: (reported - cost_5m) / (cost_1h - cost_5m). 0에 가까우면 보고 비용이 5m 캐시 쓰기
// 단가에 가깝고, 1에 가까우면 1h 단가에 가깝다 — reported/computed 차이의 원인이 TTL 가정인지를
// 이 컬럼 하나로 판별한다. null(분모 0, 캐시 쓰기 토큰 없음)은 ratio와 같은 이유로 falsy 검사를
// 피해 명시적으로 처리한다.
const ttlShareText = (v) => (v == null ? "" : Number(v).toFixed(2));
const ttlShareBadge = (v) => {
  if (v == null) return <span className="text-ink-400">—</span>;
  return Number(v).toFixed(2);
};

// cache_split_coverage: 캐시 쓰기 토큰 중 cache_creation_5m/1h_tokens(Claude Code 2.1.300+)로 분리 수집된
// 비율. 1이면 cost_split에 TTL 가정이 없고, 0이면 cost_split이 기존 계산 비용과 같다.
const splitCoverageText = (v) => (v == null ? "" : `${(Number(v) * 100).toFixed(0)}%`);
const splitCoverageCell = (v) => (v == null ? <span className="text-ink-400">—</span> : splitCoverageText(v));

// 2026-08-11 STEP 3/4 — 신뢰성(refusal/재시도) + A/B 무결성(버전 코호트) 신규 패널 전용 페이지.
// 기존 페이지(Productivity/Usage)와 성격이 달라(생산성/사용량이 아니라 "이 A/B 비교를 믿어도
// 되는가") 별도 페이지로 분리한다.
// 2026-09-01 — API 레이턴시. 레이턴시는 에러율보다 먼저 움직이는 선행 신뢰성 신호라 페이지 첫
// 행에 둔다. 서버가 {byModel, byEffort} 두 갈래를 한 응답으로 내려준다(apiErrors와 같은 형태).
// 실측 7d: p50 5968ms / p95 36262ms.
const API_LATENCY_MODEL_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "model", label: "모델" },
  { key: "requests", label: "요청 수", render: fmt, bar: true },
  { key: "p50_ms", label: "p50 (ms)", render: fmt },
  { key: "p95_ms", label: "p95 (ms)", render: fmt },
]);

const API_LATENCY_EFFORT_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "effort", label: "Effort", render: effortLabel, toText: effortLabel },
  { key: "requests", label: "요청 수", render: fmt, bar: true },
  { key: "p50_ms", label: "p50 (ms)", render: fmt },
  { key: "p95_ms", label: "p95 (ms)", render: fmt },
]);

const REFUSAL_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "user_visible_refusals", label: "사용자에게 표시된 거부 응답", render: fmt },
  { key: "server_hidden_refusals", label: "서버가 자동 재시도한 거부 응답", render: fmt },
]);

const RETRY_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "exhausted_retries", label: "재시도 소진 건수", render: fmt },
  { key: "avg_total_attempts", label: "평균 시도 횟수" },
  { key: "avg_retry_duration_ms", label: "평균 재시도 시간 (ms)", render: fmt },
]);

// 2026-08-31 — API 에러율. 서버가 {byModel, byStatus} 두 갈래를 한 응답으로 내려준다(다른
// 라우트들처럼 배열이 아니다).
// error_rate 분모는 api_request + api_error다 — api_request가 실패 요청을 포함하는지가 실측으로
// 확정되지 않아 두 해석 모두에서 [0,1]에 갇히는 쪽을 골랐다(queries.js apiErrors 주석 참고).
const API_ERROR_MODEL_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "model", label: "모델" },
  { key: "requests", label: "요청 수", render: fmt },
  { key: "errors", label: "오류 수", render: fmt },
  { key: "error_rate", label: "오류율", render: pct2, toText: pct2 },
]);

// 'no-http-status'는 status_code 자체가 없는 에러(실측 2026-08-31: 580건 중 35건) — HTTP 상태가
// 아니라 전송 계층 실패(예: Stream idle timeout)라 숫자 상태코드와 섞이지 않게 라벨을 달리 준다.
const API_ERROR_STATUS_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "status_code", label: "HTTP 상태 코드", render: statusLabel, toText: statusLabel },
  { key: "errors", label: "오류 수", render: fmt },
]);

const REPORTED_VS_COMPUTED_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "app_version", label: "Claude Code 버전" },
  { key: "model", label: "모델" },
  { key: "requests", label: "요청 수", render: fmt, bar: true },
  { key: "reported_cost", label: "Claude Code 보고 비용", render: usd },
  { key: "cost", label: "계산 비용", render: (_v, r) => (r.unpriced ? <Badge tone="neutral">{translate("ma8761601c736")}</Badge> : usd(r.cost)), toText: computedCostText },
  { key: "ratio", label: "비율", render: ratioBadge, toText: ratioText },
  { key: "cost_5m", label: "계산 비용 (5m 캐시)", render: scenarioCostCell, toText: scenarioCostText },
  { key: "cost_1h", label: "계산 비용 (1h 캐시)", render: scenarioCostCell, toText: scenarioCostText },
  { key: "ttl_share", label: "TTL 비중 (0=5m, 1=1h)", render: ttlShareBadge, toText: ttlShareText },
  { key: "cache_split_coverage", label: "TTL 분리 수집률", render: splitCoverageCell, toText: splitCoverageText },
  { key: "cost_split", label: "계산 비용 (TTL 분리)", render: scenarioCostCell, toText: scenarioCostText },
  { key: "ratio_split", label: "비율 (TTL 분리)", render: ratioBadge, toText: ratioText },
]);

const VERSION_SESSION_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "app_version", label: "Claude Code 버전" },
  { key: "sessions", label: "세션 수", render: fmt },
]);

const VERSION_COST_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "version_cohort", label: "버전 구간", render: cohortLabel, toText: cohortLabel },
  { key: "cost_usd", label: "Claude Code 보고 비용", render: usd },
  { key: "tokens", label: "토큰", render: fmt },
  { key: "usd_per_million_tokens", label: "백만 토큰당 비용 ($)" },
]);

export default function Reliability() {
  const _locale = useLocale();
  const apiLatency = useApi("/api/reliability/api-latency");
  const refusals = useApi("/api/reliability/refusals");
  const retries = useApi("/api/reliability/retries-exhausted");
  const apiErrors = useApi("/api/reliability/api-errors");
  const reportedVsComputed = useApi("/api/reliability/reported-vs-computed");
  const versionSessions = useApi("/api/integrity/version-cohort-sessions");
  const versionCost = useApi("/api/integrity/version-cohort-cost");

  return (
    <div>
      <PageHeader
        title={translate("m71d0acd46556")}
        subtitle={translate("mc7dbdb5966fe")}
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
              title={translate("m9e2c6bb2b6a8")}
              subtitle={translate("mbf1cdfba0106")}
              help={translate("m8e51b504b013")}
              columns={API_LATENCY_MODEL_COLUMNS}
              rows={apiLatency.data?.byModel || []}
              exportName="reliability_api_latency_by_model"
              stale={apiLatency.stale}
            />
            <DataTable
              title={translate("mb4743713beb1")}
              subtitle={translate("mbf1cdfba0106")}
              help={translate("m8bb9dc0f9bc5")}
              columns={API_LATENCY_EFFORT_COLUMNS}
              rows={apiLatency.data?.byEffort || []}
              exportName="reliability_api_latency_by_effort"
              stale={apiLatency.stale}
            />
          </div>
        )}

        {refusals.loading ? (
          <Loading />
        ) : refusals.error ? (
          <ErrorBox error={refusals.error} />
        ) : (
          <DataTable
            title={translate("m2bd350da6fe8")}
            subtitle={translate("mcb2d005beec0")}
            help={translate("m17e76f61d8d4")}
            columns={REFUSAL_COLUMNS}
            rows={refusals.data || []}
            exportName="reliability_refusals"
            stale={refusals.stale}
          />
        )}

        {retries.loading ? (
          <Loading />
        ) : retries.error ? (
          <ErrorBox error={retries.error} />
        ) : (
          <DataTable
            title={translate("m41c4d1223c5e")}
            subtitle={translate("mded01925ac83")}
            help={translate("mf32f8b90f655")}
            columns={RETRY_COLUMNS}
            rows={retries.data || []}
            exportName="reliability_retries_exhausted"
            stale={retries.stale}
          />
        )}

        {apiErrors.loading ? (
          <Loading />
        ) : apiErrors.error ? (
          <ErrorBox error={apiErrors.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <DataTable
              title={translate("m3de9c3324af6")}
              subtitle={translate("m62187dff59fe")}
              help={translate("m25b8b8733639")}
              columns={API_ERROR_MODEL_COLUMNS}
              rows={apiErrors.data?.byModel || []}
              exportName="reliability_api_errors_by_model"
              stale={apiErrors.stale}
            />
            <DataTable
              title={translate("me8dc1373163f")}
              subtitle={translate("mc95e2bd559c8")}
              help={translate("ma54ed046125d")}
              columns={API_ERROR_STATUS_COLUMNS}
              rows={apiErrors.data?.byStatus || []}
              exportName="reliability_api_errors_by_status"
              stale={apiErrors.stale}
            />
          </div>
        )}

        {reportedVsComputed.loading ? (
          <Loading />
        ) : reportedVsComputed.error ? (
          <ErrorBox error={reportedVsComputed.error} />
        ) : (
          <DataTable
            title={translate("m6f8a4c884f4b")}
            subtitle={translate("m6691cd6f4a5e")}
            columns={REPORTED_VS_COMPUTED_COLUMNS}
            rows={reportedVsComputed.data || []}
            exportName="reliability_reported_vs_computed"
            stale={reportedVsComputed.stale}
          />
        )}

        {versionSessions.loading ? (
          <Loading />
        ) : versionSessions.error ? (
          <ErrorBox error={versionSessions.error} />
        ) : (
          <DataTable
            title={translate("me35eb162110a")}
            subtitle={translate("m5aba83e51a66")}
            help={translate("m95930635d349")}
            columns={VERSION_SESSION_COLUMNS}
            rows={versionSessions.data || []}
            exportName="integrity_version_sessions"
            stale={versionSessions.stale}
          />
        )}

        {versionCost.loading ? (
          <Loading />
        ) : versionCost.error ? (
          <ErrorBox error={versionCost.error} />
        ) : (
          <DataTable
            title={translate("m54a3a8b54ea7")}
            subtitle={translate("m48406f863b2f")}
            help={translate("m402af8564d27")}
            columns={VERSION_COST_COLUMNS}
            rows={versionCost.data || []}
            exportName="integrity_version_cost"
            stale={versionCost.stale}
          />
        )}
      </div>
    </div>
  );
}
