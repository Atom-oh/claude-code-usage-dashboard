import { localize, translate, translateSource, useLocale } from "../i18n/index.js";
import { Card, ErrorBox, Loading } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { Badge } from "../components/Badge.jsx";
import { formatClientCost, formatObserved } from "../clientUsage.js";
import { clientName, formatPercent } from "../clientPresentation.js";
import { productivityRows, toolDecisionRows, toolResultRows, topUserRows, unavailableLabel, UNAVAILABLE_HELP,
  UNAVAILABLE_LABELS } from "../clientProductivity.js";
import { maskEmail } from "../fmt.js";

const text = (v) => v || "—";
// A labelled value renders as a chip (CSV: the label), never as a number or zero.
function column(key, label, format = formatObserved) {
  return { key, label,
    render: (value, row) => {
      const status = unavailableLabel(row, key);
      return status ? <Badge tone="neutral" className="text-[11px]">{status}</Badge> : format(value);
    },
    toText: (value, row) => unavailableLabel(row, key) ?? value ?? "" };
}
const CLIENT = localize({ key: "client", label: "클라이언트", render: clientName, toText: clientName });
const SUMMARY = localize([CLIENT, column("users", "관측 사용자 ID"), column("sessions", "세션"),
  column("prompts", "프롬프트·턴"), column("tokens_per_session", "세션당 토큰"),
  column("cost_per_session", "세션당 비용 (USD)", formatClientCost),
  { key: "cost_basis_label", label: "비용 기준", render: (v) => <span className="block min-w-[10rem]">{text(v)}</span>, toText: text },
  column("tool_calls", "도구 호출"), column("tool_success_pct", "도구 성공률 (%)", formatPercent),
  column("permission_allow_pct", "권한 허용률 (%)", formatPercent), column("ttft_p50_ms", "TTFT p50 (ms)")]);
const ACTIVITY = localize([CLIENT, column("tool_calls_per_prompt", "프롬프트·턴당 도구 호출"),
  column("prompts_per_session", "세션당 프롬프트·턴"), column("active_user_hours", "활성 사용 시간 (시간)"),
  column("active_cli_hours", "CLI 처리 시간 (시간)")]);
const CODE = localize([CLIENT, column("prs", "PR"), column("commits", "커밋"), column("loc_added", "추가 라인"),
  column("loc_removed", "삭제 라인"), column("loc_added_per_million_tokens", "100만 토큰당 추가 라인")]);
const TOOL = localize({ key: "tool_label", label: "도구", render: (v) => <span className="block min-w-[8rem] break-all">{text(v)}</span>, toText: text });
const sourceText = (v, row) => v ? `${v}${row.source_pct === null || row.source_pct === undefined ? "" : ` (${formatPercent(row.source_pct)})`}` : "—";
const DECISIONS = localize([CLIENT, TOOL, column("allowed", "허용"), column("denied", "거부"),
  column("allow_pct", "허용률 (%)", formatPercent),
  { key: "source_label", label: "주된 결정 출처", render: sourceText, toText: (v) => v ?? "" }]);
const RESULTS = localize([CLIENT, TOOL, column("calls", "호출"), column("successes", "성공"), column("failures", "실패"),
  column("success_pct", "성공률 (%)", formatPercent), column("duration_p50_ms", "실행 시간 p50 (ms)")]);
const LATENCY = localize([CLIENT, column("ttft_p50_ms", "TTFT p50 (ms)"), column("ttft_p90_ms", "TTFT p90 (ms)"),
  column("ttft_samples", "표본"), column("permission_wait_p50_ms", "권한 대기 p50 (ms)")]);
// No toText on user: csv.js masks the user column itself; the screen masks with maskEmail.
const USERS = localize([CLIENT, { key: "user", label: "사용자", render: (v) => v ? maskEmail(v) : "—" },
  column("productivity_score", "활동 지수"), column("accept_pct", "코드 편집 수락률 (%)", formatPercent),
  column("loc_added", "추가 라인"), column("commits", "커밋"), column("sessions", "세션"), column("active_days", "활성일")]);
const pinOther = (row) => row.other === true;

const SOURCES = localize({
  claude: { prompts: "Claude Code는 user_prompt 이벤트", ttft: "Claude Code는 모델 요청 스팬(traces beta 필요)",
    active: "Claude Code는 active_time 카운터의 사용자 입력·CLI 처리 시간" },
  codex: { prompts: "Codex는 codex.user_prompt 이벤트(사용자 턴)", ttft: "Codex는 턴별 turn_ttft 이벤트",
    active: "Codex의 turn.e2e_duration_ms는 턴 경과 시간이라 사람의 활성 시간이 아니므로 산출하지 않습니다" },
});
const sources = (clients, key) => clients.map((client) => SOURCES[client]?.[key]).filter(Boolean).join(" · ");

function Legend() {
  const _locale = useLocale();
  return <section aria-label={translate("mc7f7a6117705")} className="flex flex-col gap-2 rounded-lg border border-ink-100 px-4 py-3 text-[12px] text-ink-600">
    <dl className="flex flex-col gap-1.5">
      {Object.entries(UNAVAILABLE_LABELS).map(([reason, label]) => <div key={reason} className="flex flex-wrap items-center gap-2">
        <dt><Badge tone="neutral" className="text-[11px]">{label}</Badge></dt>
        <dd>{UNAVAILABLE_HELP[reason]}</dd>
      </div>)}
    </dl>
    <p>{translate("m46f513249f83")}</p>
  </section>;
}

// Sections 1, 3 and 4 of the shared Productivity page. Every selected client gets one row in
// the same columns; the per-model efficiency table (section 2) stays in ClientPanels.
export function productivitySections({ overview, productivity, clients, stale = false }) {
  const data = productivity?.data;
  const bounds = overview?.effective_range;
  // A response for another window is pending: never joined with this overview, CSV disabled.
  const otherWindow = Boolean(data && bounds
    && (data.effective_range?.from !== bounds.from || data.effective_range?.to !== bounds.to));
  const pending = stale || productivity?.stale === true || otherWindow;
  const byClient = otherWindow ? [] : data?.by_client || [];
  const rows = productivityRows(overview?.by_client || [], byClient, clients);
  const state = productivity?.error ? <ErrorBox error={productivity.error} /> : productivity?.loading ? <Loading /> : null;
  return { legend: <Legend key="legend" />,
    summary: <section key="summary" aria-label={translate("maf4a21d13f0b")}>{state || <DataTable title={translate("ma24a8bc93dc3")}
      subtitle={translate("mc098d3149a0c")}
      help={translate("m19c168374344", [sources(clients, "prompts"), sources(clients, "ttft")])}
      columns={SUMMARY} rows={rows} exportName="clients_productivity_summary" stale={pending} />}</section>,
    activity: <section key="activity" aria-label={translate("md4b47a5cf760")}>{state || <DataTable title={translate("md4b47a5cf760")}
      subtitle={translate("m748397753bf8")}
      help={translate("m81549c567693", [sources(clients, "active")])}
      columns={ACTIVITY} rows={rows} exportName="clients_productivity_activity" stale={pending} />}</section>,
    code: <section key="code" aria-label={translate("mc7272f9f6b16")}>{state || <DataTable title={translate("mc7272f9f6b16")}
      subtitle={clients.includes("codex") ? translate("md849a8c4fc96") : undefined}
      help={translate("mca8c9a08291b")}
      columns={CODE} rows={rows} exportName="clients_productivity_code" stale={pending} />}</section>,
    decisions: <section key="decisions" aria-label={translate("m6e52e582d31c")} className="flex flex-col gap-2">{state || <>
      <DataTable title={translate("m6e52e582d31c")} subtitle={translateSource(TOP_TOOLS)}
        help={translate("mbe6245bdcc38")}
        columns={DECISIONS} rows={toolDecisionRows(byClient, clients)}
        exportName="clients_productivity_decisions" stale={pending} pinLast={pinOther} />
      <p className="text-[12px] text-ink-600">{translate("m36348795b12a")}</p></>}</section>,
    results: <section key="results" aria-label={translate("ma0d20664e0a4")}>{state || <DataTable title={translate("ma0d20664e0a4")}
      subtitle={translateSource(TOP_TOOLS)}
      help={translate("mc01d0ab5084c")}
      columns={RESULTS} rows={toolResultRows(byClient, clients)}
      exportName="clients_productivity_tool_results" stale={pending} pinLast={pinOther} />}</section>,
    latency: <section key="latency" aria-label={translate("m54e66373522c")}>{state || <DataTable title={translate("m54e66373522c")}
      subtitle={clients.includes("codex") ? translate("md8ecde7ba1f0") : undefined}
      help={translate("m8a3f7c6582cf", [sources(clients, "ttft")])}
      columns={LATENCY} rows={rows} exportName="clients_productivity_latency" stale={pending} />}</section>,
    users: <section key="users" aria-label={translate("m7c178ab4aa83")}>{state || <DataTable title={translate("m7c178ab4aa83")}
      subtitle={`${clients.includes("claude") ? translate("mcae4ba53dc9c") : ""}${clients.includes("codex") ? translate("m97bf97c1d58d") : ""}`.trim() || undefined}
      help={translate("m5cf0482b9856")}
      columns={USERS} rows={topUserRows(byClient, clients)}
      exportName="clients_productivity_top_users" stale={pending} />}</section> };
}
const TOP_TOOLS = "클라이언트마다 기록이 많은 도구 상위 10개와 나머지(기타)입니다.";
