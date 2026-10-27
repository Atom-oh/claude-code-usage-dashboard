export const SPEND_HELP = "Claude Code가 보고한 비용을 사용합니다. 단, Claude Code로 쓴 Anthropic 외 모델(OpenAI·xAI·Z.ai 등)은 Claude Code가 기본 Opus 단가로 보고하므로 AWS 공시가 추정으로 바꿔 표시합니다. 보고 비용이 0인데 토큰 사용이 있으면 Claude Code 단가표에 없는 모델일 수 있어 미산정으로 처리합니다. 계산 비용과의 차이는 캐시 TTL·단가·수집 상태를 확인하는 비교 지표이며, 보고값도 실제 청구액이나 수집 완전성을 보장하지 않습니다. 이 총액은 Claude Code 텔레메트리로 수집된 값만 포함하며, Anthropic Console 조직 사용량 리포트와 모수가 다릅니다(Console은 Claude Code 외 API 사용을 포함하고, 이 페이지의 전체 합계는 Anthropic이 과금하지 않는 Bedrock 채널도 포함) — 두 수치를 직접 대조하지 마세요.";

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

// Cost panels opt into the additive API subtotal. Older servers and other detail
// consumers retain strict report selection. A measured partial zero has its own evidence
// on the server; the group's excluded positive tokens must not invalidate that zero.
export function asKnownSpendRows(rows = []) {
  return (rows || []).map((row) => {
    const view = asSpendRow(row);
    if (!Object.hasOwn(row, "known_reported_cost")) return view;
    const cost = amount(row.known_reported_cost);
    return { ...view, cost, reported_unpriced: cost === null,
      cost_partial: cost !== null && row.reported_partial === true };
  });
}

export const asCostSummaryRows = asKnownSpendRows;

export function sumSpend(rows, key = "cost") {
  let total = 0;
  for (const row of rows || []) {
    const value = amount(row[key]);
    if (value === null) return null;
    total += value;
  }
  return Number.isFinite(total) ? total : null;
}

// ADR-013 known subtotal: sums usable amounts with the same rule as sumSpend, never counts an
// unusable piece as $0, and is null only when every supplied piece is unusable. `partial` marks
// a mixed sum or a usable piece that is itself a partial subtotal.
export function sumKnownSpend(rows, key = "cost") {
  let total = 0;
  let known = false;
  let unknown = false;
  let partial = false;
  for (const row of rows || []) {
    const value = amount(row[key]);
    if (value === null) {
      unknown = true;
      continue;
    }
    known = true;
    total += value;
    partial ||= row.cost_partial === true;
  }
  if (!known) return { total: unknown ? null : 0, partial: false };
  return Number.isFinite(total) ? { total, partial: partial || unknown } : { total: null, partial: false };
}
