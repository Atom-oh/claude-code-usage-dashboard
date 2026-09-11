export const SPEND_HELP = "Claude Code가 보고한 비용을 사용합니다. 보고 비용이 0인데 토큰 사용이 있으면 Claude Code 단가표에 없는 모델일 수 있어 미산정으로 처리합니다. 계산 비용과의 차이는 캐시 TTL·단가·수집 상태를 확인하는 비교 지표이며, 보고값도 실제 청구액이나 수집 완전성을 보장하지 않습니다.";

const TOKEN_FIELDS = ["tokens", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"];

function amount(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function selectedCost(row, prefix = "") {
  const cost = amount(row[`${prefix}reported_cost`]);
  const unverifiedZero = cost === 0 && TOKEN_FIELDS.some((key) => Number(row[`${prefix}${key}`]) > 0);
  return row[`${prefix}reported_unpriced`] === true || unverifiedZero ? null : cost;
}

export function asSpendRow(row) {
  const current = selectedCost(row);
  const previous = selectedCost(row, "prev_");
  return {
    ...row,
    computed_cost: Object.hasOwn(row, "computed_cost") ? row.computed_cost : row.cost ?? null,
    prev_computed_cost: Object.hasOwn(row, "prev_computed_cost") ? row.prev_computed_cost : row.prev_cost ?? null,
    cost: current,
    reported_unpriced: current === null,
    prev_cost: previous,
    prev_reported_unpriced: previous === null,
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
