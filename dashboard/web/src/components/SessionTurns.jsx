// Claude detail Overview card for /api/overview/session-turns.
// Definitions live in docs/metrics.md#session-turns.
import { Badge } from "./Badge.jsx";
import { Card, Loading, ErrorBox } from "./Card.jsx";
import { DataTable } from "./DataTable.jsx";
import EmptyState from "./EmptyState.jsx";
import { StatTile } from "./StatTile.jsx";
import { useApi } from "../useApi.js";
import { useFilters } from "../FilterContext.jsx";
import { maskEmail } from "../fmt.js";

const fmt = (n) => Number(n || 0).toLocaleString();
export const fmtTurns = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: 1 }));
export const fmtRatio = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
// Known cost: unavailable is not $0; tiny positives stay visible.
export function fmtCost(v) {
  if (v == null || !Number.isFinite(Number(v))) return "확인 필요";
  const n = Number(v);
  return n > 0 && n < 0.01 ? "<$0.01" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Unit values keep three significant digits below $1.
export function fmtUnit(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  return "$" + (n > 0 && n < 1 ? n.toLocaleString("en-US", { maximumSignificantDigits: 3 })
    : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}
export const costStatus = (r) => (r.cost_partial ? "부분합" : r.known_cost == null ? "확인 필요" : "확인됨");
export const withCostStatus = (rows) => (Array.isArray(rows) ? rows : []).map((r) => ({ ...r, cost_status: costStatus(r) }));
export const shortSession = (v) => { const s = String(v ?? ""); return s.length > 8 ? `${s.slice(0, 8)}…` : s; };
// API timestamps are ISO UTC; display and CSV use the browser time zone.
export const startedText = (v) => (v ? new Date(v).toLocaleString("ko-KR") : "");
const userText = (v) => maskEmail(v) || "(미식별)";
const partial = (text, r) => (r.cost_partial
  ? <span className="inline-flex items-center gap-1.5">{text}<Badge tone="warning">부분합</Badge></span>
  : text);
const unit = (v, r) => (v == null ? "—" : partial(fmtUnit(v), r));

export const USER_COLUMNS = [
  { key: "user", label: "사용자", render: userText },
  { key: "sessions", label: "세션", render: fmt },
  { key: "turns", label: "턴", render: fmt },
  { key: "known_cost", label: "보고 비용", render: (v, r) => partial(fmtCost(v), r) },
  { key: "cost_per_turn", label: "턴당 비용", render: unit },
  { key: "cost_per_session", label: "세션당 비용", render: unit },
  { key: "cost_status", label: "비용 상태" },
];
export const SESSION_COLUMNS = [
  { key: "session", label: "세션", render: shortSession },
  { key: "user", label: "사용자", render: userText },
  { key: "group", label: "채널" },
  { key: "started", label: "첫 이벤트", render: (v) => startedText(v) || "—", toText: (v) => startedText(v) },
  { key: "turns", label: "턴", render: fmt },
  { key: "model_calls", label: "모델 호출", render: fmt },
  { key: "known_cost", label: "보고 비용", render: (v, r) => partial(fmtCost(v), r) },
  { key: "cost_per_turn", label: "턴당 비용", render: unit },
  { key: "cost_status", label: "비용 상태" },
];

const TITLE = "세션·턴 비용";
const SUBTITLE = "Claude Code 세션 기준 · 턴 = 사용자 프롬프트 1건";
const MODEL_NOTE = " · 모델 필터는 해당 모델을 쓴 세션 전체 기준";
const HELP = "턴은 Claude Code 사용자 프롬프트(user_prompt 이벤트) 1건입니다. 중복 전송된 로그는 prompt.id(없으면 event.sequence와 시각) 기준으로 한 번만 셉니다. 세션 비용은 보고 비용의 알려진 부분합이며, 턴당 비용은 비용이 확인되고 턴이 1건 이상 관측된 세션만으로 계산합니다. 턴이 관측되지 않았거나 비용을 확인할 수 없는 세션은 0으로 보지 않고 제외한 뒤 개수를 표시합니다. 로그는 90일, 비용 카운터는 180일 보존됩니다.";
const NOTE = "턴 수와 턴당 비용은 사용 패턴을 설명하는 참고 지표입니다. 턴이 많거나 적다고 작업 품질이나 생산성이 높거나 낮다는 뜻은 아닙니다.";

export function SessionTurnsView({ data, loading, error, stale = false, modelFiltered = false }) {
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data && typeof data === "object" && !Array.isArray(data) && data.summary && typeof data.summary === "object" ? data : null;
  const subtitle = SUBTITLE + (modelFiltered ? MODEL_NOTE : "");
  if (!d || Number(d.summary.sessions) === 0) {
    return <Card title={TITLE} subtitle={subtitle} help={HELP}><EmptyState /></Card>;
  }
  const s = d.summary;
  return (
    <div className="flex flex-col gap-4">
      <Card title={TITLE} subtitle={subtitle} help={HELP}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatTile label="세션당 턴 수"
            value={`${fmtTurns(s.median_turns_per_session)} / ${fmtTurns(s.p90_turns_per_session)}`}
            hint={`중앙값 / p90 · 턴 관측 세션 ${fmt(s.sessions_with_turns)}개`}
            help="턴이 1건 이상 관측된 세션의 턴 수 분포입니다. 중앙값은 가운데 두 값의 평균이고 p90은 nearest-rank 방식입니다." />
          <StatTile label="턴당 비용" value={fmtUnit(s.cost_per_turn)}
            hint={`${s.cost_partial ? "부분합 · " : ""}제외: 턴 미관측 ${fmt(s.sessions_without_turns)} · 비용 확인 필요 ${fmt(s.sessions_cost_unavailable)}`}
            help="비용이 확인되고 턴이 1건 이상 관측된 세션의 보고 비용 합계를 그 세션들의 턴 수로 나눈 값입니다." />
          <StatTile label="턴당 모델 호출" value={fmtRatio(s.model_calls_per_turn)} hint="api_request ÷ user_prompt"
            help="턴이 관측된 세션에서 모델 API 요청 수를 턴 수로 나눈 값입니다." />
        </div>
        <p className="mt-3 text-[12px] text-ink-500">{NOTE}</p>
      </Card>
      <DataTable title="사용자별 턴 비용" subtitle="보고 비용 상위 20명" columns={USER_COLUMNS}
        rows={withCostStatus(d.users)} exportName="overview_session_turns_users" stale={stale} />
      <DataTable title="비용 상위 세션" subtitle="보고 비용 상위 20개" columns={SESSION_COLUMNS}
        rows={withCostStatus(d.sessions)} exportName="overview_session_turns_sessions" stale={stale} />
    </div>
  );
}

export default function SessionTurns() {
  const { model } = useFilters();
  const turns = useApi("/api/overview/session-turns");
  return <SessionTurnsView data={turns.data} loading={turns.loading} error={turns.error}
    stale={turns.stale} modelFiltered={!!model} />;
}
