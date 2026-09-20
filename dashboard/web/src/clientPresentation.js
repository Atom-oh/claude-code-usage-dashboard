import { formatObserved, observedTokens } from "./clientUsage.js";

export const CLIENT_NAMES = { claude: "Claude Code", codex: "Codex" };
export const clientName = (value) => CLIENT_NAMES[value] || value || "—";
export const basisLabel = (value) => ({
  client_reported: "클라이언트 보고", aws_list_estimate: "AWS 정가 추정",
})[value] || value || "기준 미제공";

const MEASURES = [
  "tokens", "input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens",
  "reasoning_tokens", "cost_usd", "sessions", "users", "requests", "api_errors",
  "tool_calls", "tool_errors", "request_duration_ms", "ttft_ms",
];
export function observedNumber(value) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function ratio(numerator, denominator, scale = 1) {
  const n = observedNumber(numerator), d = observedNumber(denominator);
  return n === null || d === null || d === 0 ? null : observedNumber(n / d * scale);
}
function subsetPercent(part, whole) {
  return part !== null && whole !== null && part <= whole ? ratio(part, whole, 100) : null;
}

export function costBasisLabel(source, label = basisLabel(source.cost_basis)) {
  const unpriced = observedNumber(source.unpriced);
  const unknown = observedNumber(source.cost_usd) === null;
  const partial = source.cost_partial === true || unpriced > 0;
  return [label, unknown ? "미산정" : partial ? "부분합" : null,
    unpriced > 0 ? `${unknown ? "" : "미산정 "}${formatObserved(unpriced)}건 제외` : null]
    .filter(Boolean).join(" · ");
}

export const OBSERVED_TOKEN_HELP = "확인된 토큰의 합계입니다. Claude Code는 토큰 메트릭, Codex는 완료 응답의 입력·출력 쌍을 사용하며 캐시·추론을 중복 합산하지 않습니다. 일부 사용량 정보가 불완전하면 부분합, 확인된 합계가 없으면 —로 표시합니다. 비율은 기존 전체 토큰·구성값 기준입니다.";
export function tokenStatusLabel(row) {
  return observedTokens(row) === null ? "미확인" : row.tokens_partial === true ? "부분합" : "관측됨";
}

export function presentationRow(source = {}) {
  const row = { ...source };
  const unobserved = observedNumber(source.observed_records) === 0 && source.timeline_observed !== true;
  for (const key of MEASURES) row[key] = unobserved ? null : observedNumber(source[key]);
  row.observed_tokens = unobserved ? null : observedTokens(source);
  row.tokens_partial = source.tokens_partial === true;
  const input = [row.input_tokens, row.cache_read_tokens, row.cache_write_tokens];
  row.input_total = input.includes(null) ? null : input.reduce((sum, n) => sum + n, 0);
  return {
    ...row,
    token_status: tokenStatusLabel(row),
    cost_basis_label: costBasisLabel(row),
    cache_read_pct: subsetPercent(row.cache_read_tokens, row.input_total),
    reasoning_pct: subsetPercent(row.reasoning_tokens, row.output_tokens),
    tokens_per_session: row.tokens_partial ? null : ratio(row.tokens, row.sessions),
    sessions_per_user: ratio(row.sessions, row.users),
    cost_per_session: ratio(row.cost_usd, row.sessions),
    cost_per_user: ratio(row.cost_usd, row.users),
    usd_per_million_tokens: row.tokens_partial ? null : ratio(row.cost_usd, row.tokens, 1e6),
    error_records_per_request: ratio(row.api_errors, row.requests),
    tool_error_pct: subsetPercent(row.tool_errors, row.tool_calls),
  };
}
export function formatPercent(value) {
  const n = observedNumber(value);
  return n === null ? "—" : n > 0 && n < 0.01 ? "<0.01%" : `${formatObserved(n)}%`;
}
const shortTime = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const fullTime = new Intl.DateTimeFormat("en-GB", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23", timeZoneName: "short",
});
export const BROWSER_TIME_ZONE = shortTime.resolvedOptions().timeZone;
function clientDate(value) {
  if (typeof value === "number" || value instanceof Date) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (!value) return null;
  const raw = String(value).trim().replace(" ", "T");
  const qualified = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z`
    : /(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? raw : `${raw}Z`;
  const date = new Date(qualified);
  return Number.isNaN(date.getTime()) ? null : date;
}
export function formatClientTime(value) {
  const date = clientDate(value);
  return date ? shortTime.format(date) : "—";
}
export function formatClientTimestamp(value) {
  const date = clientDate(value);
  if (!date) return "—";
  const parts = Object.fromEntries(fullTime.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond} ${parts.timeZoneName}`;
}
