import { localize, translate } from "./i18n/index.js";
// Presentation helpers for /api/clients/token-economics (docs/metrics.md#token-economics).
// Terms and bundles mirror dashboard/server/tokenEconomics.js; the server owns every formula.
import { UNAVAILABLE_HELP, UNAVAILABLE_LABELS } from "./clientProductivity.js";

export const TERMS = ["users", "sessions_per_user", "turns_per_session", "requests_per_turn", "tokens_per_request", "cost_per_token"];

// Server `unavailable` reasons. A labelled value is never shown as a number or zero.
export const REASON_LABELS = localize({ not_backfilled: "백필 전", retention: "보존 기간 초과", window_too_short: "기간 짧음",
  no_matched_sessions: "대상 세션 없음", no_users: "식별 사용자 없음", no_previous: "직전 기간 없음",
  zero_factor: UNAVAILABLE_LABELS.not_derived, not_collected: UNAVAILABLE_LABELS.not_collected });
export const REASON_HELP = localize({
  not_backfilled: "세션 턴 집계(migration 010)의 백필이 이 기간 또는 비교할 직전 기간을 아직 포함하지 않습니다.",
  retention: "이 기간 또는 비교할 직전 기간이 로그 보존 기간(90일)을 벗어납니다.",
  window_too_short: "1시간 이상의 기간에서만 계산합니다.",
  no_matched_sessions: "세션·턴·요청·토큰·비용이 모두 관측된 세션이 없습니다.",
  no_users: "식별된 사용자 ID가 있는 세션이 없습니다.",
  no_previous: "직전 기간의 방정식을 계산할 수 없어 비교하지 않습니다.",
  zero_factor: "어느 한 기간에 0인 항목이 있어 분해할 수 없습니다.",
  not_collected: UNAVAILABLE_HELP.not_collected,
});
export const reasonLabel = (reason) => (reason ? REASON_LABELS[reason] || reason : null);
// A Claude outcome count without in-window counter evidence (ADR-018): unavailable, not zero.
export const NOT_OBSERVED_LABEL = UNAVAILABLE_LABELS.not_aggregated;

export const TERM_LABELS = localize({ users: "활성 사용자", sessions_per_user: "세션 / 사용자", turns_per_session: "턴 / 세션",
  requests_per_turn: "요청 / 턴", tokens_per_request: "토큰 / 요청", cost_per_token: "$ / 100만 토큰" });
export const BUNDLE_OF = { users: "growth", sessions_per_user: "growth", turns_per_session: "waste",
  requests_per_turn: "waste", tokens_per_request: "waste", cost_per_token: "price" };
export const BUNDLE_LABELS = localize({ growth: "성장", waste: "낭비", price: "단가" });
export const BUNDLE_HELP = localize({ growth: "도입 지표 · 줄이는 대상이 아님", waste: "최적화 대상", price: "모델·티어 선택" });
// Theme tokens, never literals: the same variables drive the charts (useChartColors).
export const BUNDLE_COLOR_VARS = { growth: "--chart-1", waste: "--chart-4", price: "--chart-3", total: "--ink-400" };

const finite = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// Percentage change; a zero or unknown baseline has none.
export function changePct(prev, cur) {
  const p = finite(prev), c = finite(cur);
  if (p === null || c === null || p === 0) return null;
  return (c - p) / Math.abs(p) * 100;
}

// Previous cost, six signed LMDI contributions in TERMS order, current cost. `base` is the
// running total before a positive step and after a negative one, so a stacked transparent base
// plus |value| draws the floating bar. The current total is the previous cost plus the
// contributions (equal to the server's current cost to rounding: Σ contributions = ΔC).
export function waterfallSteps(previousCost, decomposition) {
  const start = finite(previousCost);
  const contributions = decomposition?.contributions;
  if (start === null || !contributions || TERMS.some((t) => finite(contributions[t]) === null)) return [];
  const steps = [{ key: "previous", label: translate("m68e26e61df61"), base: 0, value: start, kind: "total" }];
  let running = start;
  for (const term of TERMS) {
    const value = Number(contributions[term]);
    steps.push({ key: term, label: TERM_LABELS[term], base: value >= 0 ? running : running + value, value, kind: BUNDLE_OF[term] });
    running += value;
  }
  steps.push({ key: "current", label: translate("me7d6bf90da31"), base: 0, value: running, kind: "total" });
  return steps;
}

// Exemplar lever bars around the eligible users' median. Rate levers differ in percentage
// points, the others in percent of the median (none without a positive median). `score` turns
// the lever's direction into "positive is better", so the better side is always drawn right;
// `width` is the share of the whole track (at most half: from the median line to an edge).
const RATE_LEVERS = new Set(["cache_hit_rate", "small_model_share"]);
export function exemplarBars(lever) {
  const unit = RATE_LEVERS.has(lever?.lever) ? "pt" : "pct";
  const median = finite(lever?.median);
  const rows = (Array.isArray(lever?.top) ? lever.top : []).map((u) => {
    const value = finite(u.value);
    const delta = value === null || median === null ? null
      : unit === "pt" ? (value - median) * 100 : median > 0 ? (value - median) / median * 100 : null;
    const score = delta === null ? null : lever.direction === "lower" ? -delta : delta;
    return { ...u, value, delta, score };
  });
  const max = Math.max(0, ...rows.map((r) => (r.score === null ? 0 : Math.abs(r.score))));
  const bars = rows.map(({ score, ...r }) => ({ ...r,
    better: score === null || score === 0 ? null : score > 0,
    width: score === null || max === 0 ? 0 : Math.abs(score) / max * 50 }));
  return { unit, median, bars };
}

// The server floors the requested (overview effective) bounds to the hour.
const HOUR = 3600000;
const floorIso = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(Math.floor(ms / HOUR) * HOUR).toISOString() : null;
};
export function expectedWindow(range) {
  const from = floorIso(range?.from), to = floorIso(range?.to);
  return from && to ? { from, to } : null;
}
// A response for another window is pending: it is never shown beside this overview.
export function responseWindowMatches(overviewRange, responseRange) {
  const expected = expectedWindow(overviewRange);
  return Boolean(expected && responseRange
    && Date.parse(responseRange.from) === Date.parse(expected.from)
    && Date.parse(responseRange.to) === Date.parse(expected.to));
}
