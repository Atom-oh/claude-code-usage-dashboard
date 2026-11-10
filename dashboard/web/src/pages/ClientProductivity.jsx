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
const CLIENT = { key: "client", label: "클라이언트", render: clientName, toText: clientName };
const SUMMARY = [CLIENT, column("users", "관측 사용자 ID"), column("sessions", "세션"),
  column("prompts", "프롬프트·턴"), column("tokens_per_session", "세션당 토큰"),
  column("cost_per_session", "세션당 비용 (USD)", formatClientCost),
  { key: "cost_basis_label", label: "비용 기준", render: (v) => <span className="block min-w-[10rem]">{text(v)}</span>, toText: text },
  column("tool_calls", "도구 호출"), column("tool_success_pct", "도구 성공률 (%)", formatPercent),
  column("permission_allow_pct", "권한 허용률 (%)", formatPercent), column("ttft_p50_ms", "TTFT p50 (ms)")];
const ACTIVITY = [CLIENT, column("tool_calls_per_prompt", "프롬프트·턴당 도구 호출"),
  column("prompts_per_session", "세션당 프롬프트·턴"), column("active_user_hours", "활성 사용 시간 (시간)"),
  column("active_cli_hours", "CLI 처리 시간 (시간)")];
const CODE = [CLIENT, column("prs", "PR"), column("commits", "커밋"), column("loc_added", "추가 라인"),
  column("loc_removed", "삭제 라인"), column("loc_added_per_million_tokens", "100만 토큰당 추가 라인")];
const TOOL = { key: "tool_label", label: "도구", render: (v) => <span className="block min-w-[8rem] break-all">{text(v)}</span>, toText: text };
const sourceText = (v, row) => v ? `${v}${row.source_pct === null || row.source_pct === undefined ? "" : ` (${formatPercent(row.source_pct)})`}` : "—";
const DECISIONS = [CLIENT, TOOL, column("allowed", "허용"), column("denied", "거부"),
  column("allow_pct", "허용률 (%)", formatPercent),
  { key: "source_label", label: "주된 결정 출처", render: sourceText, toText: (v) => v ?? "" }];
const RESULTS = [CLIENT, TOOL, column("calls", "호출"), column("successes", "성공"), column("failures", "실패"),
  column("success_pct", "성공률 (%)", formatPercent), column("duration_p50_ms", "실행 시간 p50 (ms)")];
const LATENCY = [CLIENT, column("ttft_p50_ms", "TTFT p50 (ms)"), column("ttft_p90_ms", "TTFT p90 (ms)"),
  column("ttft_samples", "표본"), column("permission_wait_p50_ms", "권한 대기 p50 (ms)")];
// No toText on user: csv.js masks the user column itself; the screen masks with maskEmail.
const USERS = [CLIENT, { key: "user", label: "사용자", render: (v) => v ? maskEmail(v) : "—" },
  column("productivity_score", "활동 지수"), column("accept_pct", "코드 편집 수락률 (%)", formatPercent),
  column("loc_added", "추가 라인"), column("commits", "커밋"), column("sessions", "세션"), column("active_days", "활성일")];
const pinOther = (row) => row.other === true;

const SOURCES = {
  claude: { prompts: "Claude Code는 user_prompt 이벤트", ttft: "Claude Code는 모델 요청 스팬(traces beta 필요)",
    active: "Claude Code는 active_time 카운터의 사용자 입력·CLI 처리 시간" },
  codex: { prompts: "Codex는 codex.user_prompt 이벤트(사용자 턴)", ttft: "Codex는 턴별 turn_ttft 이벤트",
    active: "Codex의 turn.e2e_duration_ms는 턴 경과 시간이라 사람의 활성 시간이 아니므로 산출하지 않습니다" },
};
const sources = (clients, key) => clients.map((client) => SOURCES[client]?.[key]).filter(Boolean).join(" · ");

function Legend() {
  return <section aria-label="값 상태 안내" className="flex flex-col gap-2 rounded-lg border border-ink-100 px-4 py-3 text-[12px] text-ink-600">
    <dl className="flex flex-col gap-1.5">
      {Object.entries(UNAVAILABLE_LABELS).map(([reason, label]) => <div key={reason} className="flex flex-wrap items-center gap-2">
        <dt><Badge tone="neutral" className="text-[11px]">{label}</Badge></dt>
        <dd>{UNAVAILABLE_HELP[reason]}</dd>
      </div>)}
    </dl>
    <p>측정된 0은 0으로, 관측이 없거나 분모가 없는 값은 —로 표시합니다. 활동·승인 지표는 생산성이나 코드 품질을 증명하지 않습니다.</p>
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
    summary: <section key="summary" aria-label="클라이언트 비교">{state || <DataTable title="클라이언트별 요약"
      subtitle="클라이언트마다 같은 열입니다. 사용자·세션·토큰·비용은 개요 집계와 같은 구간을 씁니다. 도구 성공률·권한 허용률은 결과가 확인된 기록만 분모로 씁니다."
      help={`프롬프트·턴: ${sources(clients, "prompts")}. TTFT p50: ${sources(clients, "ttft")}. 권한 허용은 자동 승인을 포함하며 코드 채택률이 아닙니다.`}
      columns={SUMMARY} rows={rows} exportName="clients_productivity_summary" stale={pending} />}</section>,
    activity: <section key="activity" aria-label="활동">{state || <DataTable title="활동"
      subtitle="관측된 프롬프트·턴과 세션 기준 비율입니다. 분모가 없거나 0이면 —로 표시합니다."
      help={`활성 시간: ${sources(clients, "active")}.`}
      columns={ACTIVITY} rows={rows} exportName="clients_productivity_activity" stale={pending} />}</section>,
    code: <section key="code" aria-label="코드 결과">{state || <DataTable title="코드 결과"
      subtitle={clients.includes("codex") ? "Codex: 기본 OTel에 PR·커밋·라인 지표가 없습니다. Git/CI 연동이 필요합니다." : undefined}
      help="카운터 증가량 기준이며 유지된 코드나 품질을 뜻하지 않습니다. 100만 토큰당 비율은 전체 토큰이 확인된 경우에만 계산합니다."
      columns={CODE} rows={rows} exportName="clients_productivity_code" stale={pending} />}</section>,
    decisions: <section key="decisions" aria-label="도구별 권한 결정" className="flex flex-col gap-2">{state || <>
      <DataTable title="도구별 권한 결정" subtitle={TOP_TOOLS}
        help="Claude Code tool_decision accept/reject, Codex codex.tool_decision 승인·거부와 각 source. 허용률은 허용·거부가 확인된 결정만 분모로 씁니다. 출처 옆 비율은 그 도구 결정 중 해당 출처의 비중입니다."
        columns={DECISIONS} rows={toolDecisionRows(byClient, clients)}
        exportName="clients_productivity_decisions" stale={pending} pinLast={pinOther} />
      <p className="text-[12px] text-ink-600">권한 결정은 자동 승인을 포함하며 코드 채택이 아닙니다.</p></>}</section>,
    results: <section key="results" aria-label="도구별 실행 결과">{state || <DataTable title="도구별 실행 결과"
      subtitle={TOP_TOOLS}
      help="Claude Code tool_result(error가 있으면 실패), Codex codex.tool_result의 success. 성공률은 결과가 확인된 호출, 실행 시간 p50은 유효한 duration_ms만 씁니다."
      columns={RESULTS} rows={toolResultRows(byClient, clients)}
      exportName="clients_productivity_tool_results" stale={pending} pinLast={pinOther} />}</section>,
    latency: <section key="latency" aria-label="응답·대기">{state || <DataTable title="응답·대기"
      subtitle={clients.includes("codex") ? "Codex: 권한 대기 시간을 나타내는 확인된 원천 지표가 없어 집계하지 않습니다." : undefined}
      help={`TTFT: ${sources(clients, "ttft")}. 표본은 TTFT 표본 수입니다. 권한 대기: Claude Code tool.blocked_on_user 스팬(traces beta, 2.1.214+).`}
      columns={LATENCY} rows={rows} exportName="clients_productivity_latency" stale={pending} />}</section>,
    users: <section key="users" aria-label="활동 지수 상위 사용자">{state || <DataTable title="활동 지수 상위 사용자"
      subtitle={`${clients.includes("claude") ? "Claude Code: 활동 지수 상위 10명입니다. " : ""}${clients.includes("codex") ? "Codex: 산식에 필요한 추가 라인·커밋이 Codex에 없어 계산하지 않습니다." : ""}`.trim() || undefined}
      help="Claude 상세 사용자 화면과 같은 활동 지수 산식을 채널 구분 없이 사용자별로 계산합니다. 코드 편집 결정이 없으면 계산하지 않으며, 생산성·품질 순위가 아닙니다."
      columns={USERS} rows={topUserRows(byClient, clients)}
      exportName="clients_productivity_top_users" stale={pending} />}</section> };
}
const TOP_TOOLS = "클라이언트마다 기록이 많은 도구 상위 10개와 나머지(기타)입니다.";
