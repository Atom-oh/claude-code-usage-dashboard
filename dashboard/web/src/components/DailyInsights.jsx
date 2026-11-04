// Claude detail Overview card for stored daily AI insights (/api/insights/daily).
// Model text renders as plain text only; numbers come from the stored aggregates.
import { useState } from "react";
import { Badge } from "./Badge.jsx";
import { Card, Loading, ErrorBox } from "./Card.jsx";
import { fmtCost, fmtUnit } from "./SessionTurns.jsx";
import { useApi } from "../useApi.js";
import { maskEmail } from "../fmt.js";

const TITLE = "AI 인사이트 (Haiku 5.5 · 매일)";
const SUBTITLE = "전날(UTC) 집계 기준";
const HELP = "매일 00:30 UTC 이후 전날(UTC) 집계로 한 번 생성합니다. 모델에는 프롬프트 내용, 코드, 파일 경로, 도구 입력, 이메일을 보내지 않고, 보고 비용 상위 10명을 U1~U10 가명으로 바꾼 집계만 보냅니다.";
export const DISCLAIMER = "집계 텔레메트리만으로 AI가 생성한 요약입니다. 생산성이나 성과 평가가 아니며 틀릴 수 있습니다. 표시된 숫자는 저장된 집계값입니다.";
const fmt = (n) => Number(n || 0).toLocaleString();
export const userLabel = (pseudonym, user) => (pseudonym ? `${pseudonym} · ${maskEmail(user) || "(미식별)"}` : "조직 전체");
export const statsText = (s) => `보고 비용 ${fmtCost(s.cost_usd)}${s.cost_partial ? " (부분합)" : ""} · 턴 ${fmt(s.turns)} · 턴당 비용 ${fmtUnit(s.cost_per_turn)}`;
export function periodOptions(data) {
  const list = Array.isArray(data?.available) ? [...data.available] : [];
  if (typeof data?.period === "string" && !list.includes(data.period)) list.push(data.period);
  return list.sort().reverse();
}
export function footerText(data) {
  const parts = [`생성 ${new Date(data.generatedAt).toLocaleString("ko-KR")}`];
  if (data.model) parts.push(data.model);
  const u = data.usage;
  if (u) {
    parts.push(`입력 ${fmt(u.inputTokens)} / 출력 ${fmt(u.outputTokens)} 토큰`);
    if (u.estimatedCostUsd != null) parts.push(`추정 호출 비용 ${fmtUnit(u.estimatedCostUsd)}`);
  }
  return parts.join(" · ");
}

function ReadyBody({ data }) {
  const org = data.org?.period;
  const users = Array.isArray(data.users) ? data.users : [];
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const caveats = Array.isArray(data.caveats) ? data.caveats : [];
  return (
    <>
      {org && <p className="text-[12px] text-ink-600 tabular">{`${statsText(org)} · 세션 ${fmt(org.sessions)}`}</p>}
      <p className="mt-3 text-[14px] text-ink-800 whitespace-pre-line">{data.summary}</p>
      {findings.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {findings.map((f, i) => {
            const stored = f.pseudonym ? users.find((u) => u.pseudonym === f.pseudonym) : null;
            return (
              <li key={i} className="rounded-md border border-ink-100 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-ink-800">{f.title}</span>
                  <Badge tone={f.pseudonym ? "brand" : "neutral"}>{userLabel(f.pseudonym, f.user)}</Badge>
                </div>
                <p className="mt-1 text-[13px] text-ink-700 whitespace-pre-line">{f.detail}</p>
                {f.metric ? <p className="mt-1 text-[12px] text-ink-500">{f.metric}</p> : null}
                {stored && <p className="mt-1 text-[12px] text-ink-500 tabular">{`저장된 집계: ${statsText(stored)}`}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {caveats.length > 0 && (
        <div className="mt-4">
          <div className="text-[12px] font-semibold text-ink-600">유의 사항</div>
          <ul className="mt-1 list-disc pl-5 text-[12px] text-ink-600">
            {caveats.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}
      <p className="mt-3 text-[11px] text-ink-400">{footerText(data)}</p>
    </>
  );
}

export function DailyInsightsView({ data, loading, error, period, onPeriod }) {
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data || typeof data !== "object" || Array.isArray(data) || data.enabled !== true) return null;
  const options = periodOptions(data);
  const right = options.length > 0 ? (
    <select aria-label="인사이트 날짜" value={period ?? data.period ?? ""} onChange={(e) => onPeriod?.(e.target.value)}
      className="rounded-md border border-ink-100 bg-card px-2 py-1 text-[12px] text-ink-700">
      {options.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>
  ) : null;
  let body;
  if (data.status === "pending") body = <p className="text-sm text-ink-500">{`${data.period} 인사이트는 아직 생성되지 않았습니다. 매일 00:30 UTC 이후 생성됩니다.`}</p>;
  else if (data.status === "failed") body = <p className="text-sm text-ink-500">{`${data.period} 인사이트를 생성하지 못했습니다.`}</p>;
  else if (data.status !== "ready") body = <p className="text-sm text-ink-500">표시할 인사이트가 없습니다.</p>;
  else if (data.empty === true) body = <p className="text-sm text-ink-500">{`${data.period}에는 집계할 사용 데이터가 없습니다.`}</p>;
  else body = <ReadyBody data={data} />;
  return (
    <Card title={TITLE} subtitle={SUBTITLE} help={HELP} right={right}>
      {body}
      <p className="mt-4 text-[12px] text-ink-500">{DISCLAIMER}</p>
    </Card>
  );
}

export default function DailyInsights() {
  const [period, setPeriod] = useState(null);
  const insights = useApi("/api/insights/daily", period ? { period } : {});
  return <DailyInsightsView data={insights.data} loading={insights.loading} error={insights.error}
    period={period} onPeriod={setPeriod} />;
}
