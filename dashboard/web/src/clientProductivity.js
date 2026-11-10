import { observedNumber, presentationRow } from "./clientPresentation.js";

// /api/clients/productivity `unavailable` reasons. A labelled value is never shown as a number.
export const UNAVAILABLE_LABELS = { not_collected: "미수집", not_aggregated: "미집계", not_derived: "미산출" };
export const UNAVAILABLE_HELP = {
  not_collected: "기본 OTel에 해당 지표가 없습니다. Git/CI 연동 같은 별도 수집이 필요합니다.",
  not_aggregated: "확인된 원천 지표가 없어 대시보드가 집계하지 않습니다.",
  not_derived: "대시보드가 계산하는 값이지만 필요한 입력이 없어 산출하지 않습니다.",
};
export const unavailableLabel = (row, key) => UNAVAILABLE_LABELS[row?.unavailable?.[key]] || null;

const ratio = (n, d, scale = 1) => {
  const a = observedNumber(n), b = observedNumber(d);
  return a === null || b === null || b === 0 ? null : a / b * scale;
};
const percent = (value) => observedNumber(value) === null ? null : observedNumber(value) * 100;
const hours = (seconds) => observedNumber(seconds) === null ? null : observedNumber(seconds) / 3600;

// Joins each selected client's overview row (users, sessions, tokens, cost basis) with its
// productivity row. Both responses cover the same effective range. A missing productivity row
// keeps every productivity value unknown rather than zero.
export function productivityRows(overviewRows = [], productivity = [], clients = []) {
  return clients.map((client) => {
    const base = presentationRow(overviewRows.find((row) => row.client === client) || { client, observed_records: 0 });
    const p = productivity.find((row) => row.client === client) || { client, unavailable: {} };
    const unavailable = { ...(p.unavailable || {}) };
    // Derived from a labelled input: inherit its reason instead of showing a number.
    if (unavailable.loc_added) unavailable.loc_added_per_million_tokens = unavailable.loc_added;
    if (unavailable.active_user_seconds) unavailable.active_user_hours = unavailable.active_user_seconds;
    if (unavailable.active_cli_seconds) unavailable.active_cli_hours = unavailable.active_cli_seconds;
    const prompts = observedNumber(p.prompts);
    return {
      client, users: base.users, sessions: base.sessions, prompts,
      tokens_per_session: base.tokens_per_session, cost_per_session: base.cost_per_session,
      cost_basis_label: base.cost_basis_label,
      tool_calls: observedNumber(p.tool_calls), tool_unknown: observedNumber(p.tool_unknown),
      tool_success_pct: percent(p.tool_success_rate),
      decisions_total: observedNumber(p.decisions_total), decisions_unknown: observedNumber(p.decisions_unknown),
      permission_allow_pct: percent(p.permission_allow_rate),
      ttft_p50_ms: observedNumber(p.ttft_p50_ms), ttft_samples: observedNumber(p.ttft_samples),
      tool_calls_per_prompt: ratio(p.tool_calls, prompts),
      prompts_per_session: ratio(prompts, base.sessions),
      active_user_hours: hours(p.active_user_seconds), active_cli_hours: hours(p.active_cli_seconds),
      prs: observedNumber(p.prs), commits: observedNumber(p.commits),
      loc_added: observedNumber(p.loc_added), loc_removed: observedNumber(p.loc_removed),
      // Canonical tokens only: a partial observed subtotal never becomes a ratio denominator.
      loc_added_per_million_tokens: base.tokens_partial ? null : ratio(p.loc_added, base.tokens, 1e6),
      unavailable,
    };
  });
}
