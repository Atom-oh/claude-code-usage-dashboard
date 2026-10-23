import { StatTile } from "../components/StatTile.jsx";
import { formatClientCost, formatObserved, observedTokens } from "../clientUsage.js";
import { costBasisLabel, observedNumber, OBSERVED_TOKEN_HELP, tokenStatusLabel } from "../clientPresentation.js";

const percent = (value) => observedNumber(value) === null ? "—"
  : `${(Number(value) * 100).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%`;
const costLabel = (value) => costBasisLabel({ ...value, cost_basis: "aws_list_estimate" });
const COST_HELP = "미산정 기록을 제외한 알려진 비용 / 관측된 요청·세션 수의 근삿값입니다. 비용이 모두 미산정이거나 식별 정보·분모가 없거나 분모가 0이면 —로 표시합니다.";
const WINDOW_TILES = [
  ["cache_hit_rate", "입력 캐시 읽기 비율", percent, "캐시 읽기 / 캐시를 포함한 전체 입력 토큰입니다."],
  ["cache_write_share", "입력 캐시 쓰기 비중", percent],
  ["reasoning_share", "출력 중 추론 비중", percent, "추론 토큰은 출력 토큰의 일부입니다."],
  ["tokens_per_request", "요청당 토큰", formatObserved, "기존 전체 토큰 / HTTP 요청 수입니다. 토큰이 불완전하면 관측 부분합으로 대체하지 않고 —로 표시합니다."],
  ["cost_per_request", "요청당 추정 비용", formatClientCost, COST_HELP],
  ["cost_per_session", "세션당 추정 비용", formatClientCost, COST_HELP],
];
const COMPLETION_TILES = [
  ["cache_hit_rate", "입력 캐시 읽기 비율", percent, "수집된 완료 응답의 캐시 읽기 / 캐시를 포함한 입력 토큰입니다. 구성값이 불완전하면 —로 표시합니다."],
  ["cache_write_share", "입력 캐시 쓰기 비중", percent, "수집된 완료 응답의 캐시 쓰기 / 캐시를 포함한 입력 토큰입니다. 구성값이 불완전하면 —로 표시합니다."],
  ["reasoning_share", "출력 중 추론 비중", percent, "수집된 완료 응답의 추론 / 출력 토큰입니다. 추론은 출력의 일부이며 구성값이 불완전하면 —로 표시합니다."],
  ["tokens_per_completion", "완료 응답당 토큰", formatObserved, "수집된 완료 응답의 입력·출력 토큰 / 완료 응답 수입니다. 미확인 토큰이 있으면 부분합으로 대체하지 않고 —로 표시합니다."],
  ["cost_per_completion", "완료 응답당 추정 비용", formatClientCost, "수집된 완료 응답의 알려진 비용 / 완료 응답 수입니다. 미산정 비용이 있으면 부분합 기반 근삿값입니다."],
  ["cost_per_identified_session", "사용량 확인 세션당 추정 비용", formatClientCost, "세션이 식별된 완료 응답의 알려진 비용 / 해당 응답이 있는 세션 수입니다. 식별되지 않은 응답은 비용과 세션 수 모두에서 제외합니다. 미산정 비용이 있으면 부분합 기반 근삿값입니다."],
];
const REASONS = [
  ["usage_limited", "완료 응답 집계가 조회 한도를 넘어 사용량 지표를 보류했습니다."],
  ["scope_limited", "전체 구간의 사용량 확인 범위가 조회 한도를 넘었습니다."],
  ["operations_limited", "HTTP 요청 집계가 조회 한도를 넘어 요청당 지표를 보류했습니다."],
  ["missing_usage", "선택한 구간에 사용량이 확인되지 않은 로그 범위가 있습니다."],
  ["missing_session", "세션 식별 정보가 없는 로그가 있어 전체 세션당 비용을 계산할 수 없습니다."],
  ["incomplete_tokens", "일부 완료 응답의 토큰 구성값이 불완전합니다."],
];

function windowHint(key, format, summary, completeness) {
  if (observedNumber(summary[key]) === null) {
    if (completeness.usage_limited) return "사용량 조회 한도 초과";
    if (key === "cost_per_session") {
      if (completeness.scope_limited) return "세션 조회 한도 초과";
      if (completeness.missing_session) return "세션 식별 정보 미확인";
      if (completeness.session_count === 0) return "관측된 세션 없음";
    }
    if (key === "cost_per_request" || key === "tokens_per_request") {
      if (completeness.operations_limited) return "요청 조회 한도 초과";
      if (completeness.request_count === 0) return "관측된 HTTP 요청 없음";
    }
  }
  return format === formatClientCost ? costLabel({ ...summary, cost_usd: summary[key] }) : undefined;
}
function completionHint(key, format, value) {
  if (value.status === "limited") return "완료 응답 조회 한도 초과";
  if (value.status === "unavailable") return "완료 응답 집계 미확인";
  if (value.status === "empty") return "사용량이 수집된 완료 응답 없음";
  if (key === "cost_per_identified_session") {
    if (observedNumber(value.identified_sessions) === null) return "세션 집계 미확인";
    if (value.identified_sessions === 0) return "세션이 식별된 완료 응답 없음";
    return costLabel({ cost_usd: value.identified_cost_usd, unpriced: value.identified_unpriced,
      cost_partial: value.identified_cost_partial });
  }
  if (format === formatClientCost) return costLabel(value);
  return observedNumber(value[key]) === null ? "구성값 미확인 또는 분모 없음" : "수집된 완료 응답 기준";
}

export default function CodexEfficiency({ summary, completionUsage, completeness = {} }) {
  const cohort = completionUsage?.basis === "recorded_completions" ? completionUsage : null;
  const tokensPerRequest = summary.tokens_partial === true
    || (Object.hasOwn(summary, "tokens") && observedNumber(summary.tokens) === null)
    ? null : summary.tokens_per_request;
  const windowTiles = WINDOW_TILES.map(([key, label, format, help]) => <StatTile key={key} label={label}
    value={format(key === "tokens_per_request" ? tokensPerRequest : summary[key])}
    help={help} hint={windowHint(key, format, summary, completeness)}
    className="[&_.truncate]:whitespace-normal" />);
  const reasons = REASONS.filter(([key]) => completeness[key] === true);
  return <>
    {cohort && <div>
      <h3 className="text-base font-semibold text-ink-800">수집된 완료 응답 기준</h3>
      <p className="mt-1 text-sm text-ink-600">
        완료 응답 {formatObserved(cohort.completions)}건 · 사용량 확인 세션 {formatObserved(cohort.identified_sessions)}개.
        {" "}선택한 구간에 수집된 사용량 기준이며 전체 요청·세션으로 환산하지 않습니다.
      </p>
      {cohort.unidentified_completions > 0 && <p className="mt-1 text-sm text-ink-600">
        세션이 식별되지 않은 완료 응답 {formatObserved(cohort.unidentified_completions)}건은 세션당 비용에서 제외합니다.
      </p>}
    </div>}
    {reasons.length > 0 && <div role="note" aria-label="전체 구간 지표 안내"
      className="rounded-lg border border-ink-200 bg-card p-4 text-sm text-ink-600">
      <p className="font-medium text-ink-700">전체 구간 지표의 일부를 표시할 수 없습니다.</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {reasons.map(([key, text]) => <li key={key}>{text}</li>)}
      </ul>
    </div>}
    <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
      {(Object.hasOwn(summary, "observed_tokens") || Object.hasOwn(summary, "tokens")) &&
        <StatTile label="관측 토큰" value={formatObserved(observedTokens(summary))}
          hint={tokenStatusLabel(summary)} help={OBSERVED_TOKEN_HELP} />}
      {cohort ? COMPLETION_TILES.map(([key, label, format, help]) => <StatTile key={key} label={label}
        value={format(cohort[key])} help={help} hint={completionHint(key, format, cohort)}
        className="[&_.truncate]:whitespace-normal" />) : windowTiles}
    </div>
    {cohort && <details className="rounded-lg border border-ink-200 bg-card p-4">
      <summary className="cursor-pointer text-sm font-medium text-ink-700">전체 구간 지표 · HTTP 요청·세션 기준</summary>
      <p className="my-3 text-sm text-ink-600">전체 구간의 수집 완전성 기준을 적용합니다. HTTP 요청 수는 완료 응답 수와 다를 수 있습니다.</p>
      <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">{windowTiles}</div>
    </details>}
  </>;
}
