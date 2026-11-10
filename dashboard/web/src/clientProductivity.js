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
      ttft_p90_ms: observedNumber(p.ttft_p90_ms), permission_wait_p50_ms: observedNumber(p.permission_wait_p50_ms),
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

// Productivity evidence the overview does not count (Claude user_prompt and llm_request
// spans, the commit/PR/LOC/active-time counters, Codex user_prompt): a window with only
// these must render the productivity sections, not the overview's empty state. A counter
// observed at 0 is evidence; null is not.
const EVIDENCE = ["prompts", "tool_calls", "decisions_total", "ttft_samples", "permission_wait_samples"];
const COUNTERS = ["active_user_seconds", "active_cli_seconds", "commits", "prs", "loc_added", "loc_removed"];
export function hasProductivityObservations(data) {
  return (data?.by_client || []).some((row) => EVIDENCE.some((key) => observedNumber(row?.[key]) > 0)
    || COUNTERS.some((key) => observedNumber(row?.[key]) !== null));
}

// Per-tool rows (sections 5 and 6): the server's top tools, then its remainder row. A client
// with an empty list keeps one "no observed tool" row with measured zeros; a client without a
// list (no response) keeps one row of unknowns, never zeros.
export const toolLabel = (row) => row.other ? `기타 (${observedNumber(row.tools) ?? "—"}개 도구)`
  : row.tool ? row.tool : "(도구 이름 없음)";
function perTool(productivity, clients, key, map, empty) {
  return clients.flatMap((client) => {
    const list = productivity.find((row) => row.client === client)?.[key];
    if (!Array.isArray(list)) return [{ client, tool_label: "—", other: false, unavailable: {} }];
    if (list.length === 0) return [{ client, tool_label: "관측된 도구 없음", other: false, unavailable: {}, ...empty }];
    return list.map((row) => ({ client, tool_label: toolLabel(row), other: row.other === true, unavailable: {}, ...map(row) }));
  });
}
export const sourceLabel = (row) => row.source === null || row.source === undefined ? null
  : row.source === "" ? "(출처 없음)" : row.source;
export function toolDecisionRows(productivity = [], clients = []) {
  return perTool(productivity, clients, "by_tool_decisions", (row) => ({
    allowed: observedNumber(row.allowed), denied: observedNumber(row.denied), allow_pct: percent(row.allow_rate),
    source_label: sourceLabel(row), source_pct: ratio(row.source_decisions, row.decisions, 100),
  }), { allowed: 0, denied: 0 });
}
export function toolResultRows(productivity = [], clients = []) {
  return perTool(productivity, clients, "by_tool_results", (row) => ({
    calls: observedNumber(row.calls), successes: observedNumber(row.successes), failures: observedNumber(row.failures),
    success_pct: percent(row.success_rate), duration_p50_ms: observedNumber(row.duration_p50_ms),
  }), { calls: 0, successes: 0, failures: 0 });
}

// Section 8: Claude's top users by activity index. Codex has no activity index, so its single
// row carries the server's reason in every measure; it is never ranked or shown as zero.
const USER_MEASURES = ["productivity_score", "accept_pct", "loc_added", "commits", "sessions", "active_days"];
export function topUserRows(productivity = [], clients = []) {
  return clients.flatMap((client) => {
    const p = productivity.find((row) => row.client === client);
    const reason = p?.unavailable?.top_users;
    if (reason) return [{ client, user: "", unavailable: Object.fromEntries(USER_MEASURES.map((key) => [key, reason])) }];
    if (!Array.isArray(p?.top_users) || p.top_users.length === 0) return [{ client, user: "", unavailable: {} }];
    return p.top_users.map((row) => ({ client, user: row.user, unavailable: {},
      productivity_score: observedNumber(row.productivity_score), accept_pct: percent(row.accept_rate),
      loc_added: observedNumber(row.loc_added), commits: observedNumber(row.commits),
      sessions: observedNumber(row.sessions), active_days: observedNumber(row.active_days) }));
  });
}
