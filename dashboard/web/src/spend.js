export const SPEND_HELP = "Claude Code 보고 비용을 기준으로 한 추정치입니다. 수집 누락과 클라이언트 버전별 단가 차이로 실제 청구액과 다를 수 있습니다. 확인 필요 표시는 현재 집계 단위에서 판별된 누락·비정상값에 한합니다. 양수 합계 안에 가려진 사용자·세션·요청의 누락까지 탐지하거나 수집 완전성을 보장하지 않습니다.";

const TOKEN_FIELDS = ["tokens", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"];

function amount(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function selectedCost(row, prefix = "") {
  const field = Object.hasOwn(row, `${prefix}display_cost`) ? `${prefix}display_cost` : `${prefix}reported_cost`;
  const cost = amount(row[field]);
  const unverifiedZero = cost === 0 && TOKEN_FIELDS.some((key) => Number(row[`${prefix}${key}`]) > 0);
  return {
    cost: unverifiedZero ? null : cost,
    status: unverifiedZero ? "unverified_zero" : cost === null ? "unavailable" : "reported",
  };
}

export function asSpendRow(row) {
  const current = selectedCost(row);
  const previous = selectedCost(row, "prev_");
  return {
    ...row,
    computed_cost: Object.hasOwn(row, "computed_cost") ? row.computed_cost : row.cost ?? null,
    prev_computed_cost: Object.hasOwn(row, "prev_computed_cost") ? row.prev_computed_cost : row.prev_cost ?? null,
    cost: current.cost,
    display_cost: current.cost,
    reported_cost_status: row.reported_cost_status ?? current.status,
    prev_cost: previous.cost,
    prev_display_cost: previous.cost,
  };
}

export function asSpendRows(rows = []) {
  return (rows || []).map(asSpendRow);
}

export function sumSpend(rows, key = "cost") {
  let total = 0;
  for (const row of rows || []) {
    const value = amount(row[key]);
    if (value === null) return null;
    total += value;
  }
  return Number.isFinite(total) ? total : null;
}
