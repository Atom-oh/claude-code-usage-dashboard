import { localeTag, localize, translate, translateSource, useLocale } from "../i18n/index.js";
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

const fmt = (n) => Number(n || 0).toLocaleString(localeTag());
export const fmtTurns = (v) => (v == null ? "—" : Number(v).toLocaleString(localeTag(), { maximumFractionDigits: 1 }));
export const fmtRatio = (v) => (v == null ? "—" : Number(v).toLocaleString(localeTag(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
// Known cost: unavailable is not $0; tiny positives stay visible.
export function fmtCost(v) {
  if (v == null || !Number.isFinite(Number(v))) return translate("m84dd6e381dca");
  const n = Number(v);
  return n > 0 && n < 0.01 ? "<$0.01" : "$" + n.toLocaleString(localeTag(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Unit values keep three significant digits below $1.
export function fmtUnit(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  return "$" + (n > 0 && n < 1 ? n.toLocaleString(localeTag(), { maximumSignificantDigits: 3 })
    : n.toLocaleString(localeTag(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}
export const costStatus = (r) => (r.cost_partial ? translate("md15c830a6f1c") : r.known_cost == null ? translate("m84dd6e381dca") : translate("mf2c10bf5d512"));
export const withCostStatus = (rows) => (Array.isArray(rows) ? rows : []).map((r) => ({ ...r, cost_status: costStatus(r) }));
export const shortSession = (v) => { const s = String(v ?? ""); return s.length > 8 ? `${s.slice(0, 8)}…` : s; };
// API timestamps are ISO UTC; display and CSV use the browser time zone.
export const startedText = (v) => (v ? new Date(v).toLocaleString(localeTag()) : "");
const userText = (v) => maskEmail(v) || translate("m4083695f59ed");
const partial = (text, r) => (r.cost_partial
  ? <span className="inline-flex items-center gap-1.5">{text}<Badge tone="warning">{translate("md15c830a6f1c")}</Badge></span>
  : text);
const unit = (v, r) => (v == null ? "—" : partial(fmtUnit(v), r));

export const USER_COLUMNS = localize([
  { key: "user", label: "사용자", render: userText },
  { key: "sessions", label: "세션", render: fmt },
  { key: "turns", label: "턴", render: fmt },
  { key: "known_cost", label: "보고 비용", render: (v, r) => partial(fmtCost(v), r) },
  { key: "cost_per_turn", label: "턴당 비용", render: unit },
  { key: "cost_per_session", label: "세션당 비용", render: unit },
  { key: "cost_status", label: "비용 상태" },
]);
export const SESSION_COLUMNS = localize([
  { key: "session", label: "세션", render: shortSession },
  { key: "user", label: "사용자", render: userText },
  { key: "group", label: "채널" },
  { key: "started", label: "첫 이벤트", render: (v) => startedText(v) || "—", toText: (v) => startedText(v) },
  { key: "turns", label: "턴", render: fmt },
  { key: "model_calls", label: "모델 호출", render: fmt },
  { key: "known_cost", label: "보고 비용", render: (v, r) => partial(fmtCost(v), r) },
  { key: "cost_per_turn", label: "턴당 비용", render: unit },
  { key: "cost_status", label: "비용 상태" },
]);

const TITLE = "세션·턴 비용";
const SUBTITLE = "Claude Code 세션 기준 · 턴 = 사용자 프롬프트 1건";
const MODEL_NOTE = " · 모델 필터는 해당 모델을 쓴 세션 전체 기준";
const HELP = "턴은 Claude Code 사용자 프롬프트(user_prompt 이벤트) 1건입니다. 중복 전송된 로그는 prompt.id(없으면 event.sequence와 시각) 기준으로 한 번만 셉니다. 세션 비용은 보고 비용의 알려진 부분합이며, 턴당 비용은 비용이 확인되고 턴이 1건 이상 관측된 세션만으로 계산합니다. 턴이 관측되지 않았거나 비용을 확인할 수 없는 세션은 0으로 보지 않고 제외한 뒤 개수를 표시합니다. 로그는 90일, 비용 카운터는 180일 보존됩니다.";
const NOTE = "턴 수와 턴당 비용은 사용 패턴을 설명하는 참고 지표입니다. 턴이 많거나 적다고 작업 품질이나 생산성이 높거나 낮다는 뜻은 아닙니다.";

export function SessionTurnsView({ data, loading, error, stale = false, modelFiltered = false }) {
  const _locale = useLocale();
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data && typeof data === "object" && !Array.isArray(data) && data.summary && typeof data.summary === "object" ? data : null;
  const subtitle = translateSource(SUBTITLE) + (modelFiltered ? translateSource(MODEL_NOTE) : "");
  if (!d || Number(d.summary.sessions) === 0) {
    return <Card title={translateSource(TITLE)} subtitle={subtitle} help={translateSource(HELP)}><EmptyState /></Card>;
  }
  const s = d.summary;
  return (
    <div className="flex flex-col gap-4">
      <Card title={translateSource(TITLE)} subtitle={subtitle} help={translateSource(HELP)}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatTile label={translate("m604eed18c1c8")}
            value={`${fmtTurns(s.median_turns_per_session)} / ${fmtTurns(s.p90_turns_per_session)}`}
            hint={translate("mabe60f36bf0c", [fmt(s.sessions_with_turns)])}
            help={translate("m8c05702584a8")} />
          <StatTile label={translate("med27085a15fe")} value={fmtUnit(s.cost_per_turn)}
            hint={translate("m1b5593f67b70", [s.cost_partial ? translate("m5bc294bd8c31") : "", fmt(s.sessions_without_turns), fmt(s.sessions_cost_unavailable)])}
            help={translate("m302c0c60d096")} />
          <StatTile label={translate("m269ddfa543e1")} value={fmtRatio(s.model_calls_per_turn)} hint="api_request ÷ user_prompt"
            help={translate("md6db1f700498")} />
        </div>
        <p className="mt-3 text-[12px] text-ink-500">{translateSource(NOTE)}</p>
      </Card>
      <DataTable title={translate("mbec54a179f55")} subtitle={translate("m3ff17bd5ad01")} columns={USER_COLUMNS}
        rows={withCostStatus(d.users)} exportName="overview_session_turns_users" stale={stale} />
      <DataTable title={translate("md0470e33cade")} subtitle={translate("m0740f5e72aca")} columns={SESSION_COLUMNS}
        rows={withCostStatus(d.sessions)} exportName="overview_session_turns_sessions" stale={stale} />
    </div>
  );
}

export default function SessionTurns() {
  const _locale = useLocale();
  const { model } = useFilters();
  const turns = useApi("/api/overview/session-turns");
  return <SessionTurnsView data={turns.data} loading={turns.loading} error={turns.error}
    stale={turns.stale} modelFiltered={!!model} />;
}
