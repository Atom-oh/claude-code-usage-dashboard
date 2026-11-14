import { localeTag, translate, translateSource, useLocale } from "../i18n/index.js";
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
const fmt = (n) => Number(n || 0).toLocaleString(localeTag());
export const userLabel = (pseudonym, user) => (pseudonym ? `${pseudonym} · ${maskEmail(user) || translate("m4083695f59ed")}` : translate("mdc1b7afca656"));
export const statsText = (s) => translate("m85b64c685a5c", [fmtCost(s.cost_usd), s.cost_partial ? translate("m830e860c2bd2") : "", fmt(s.turns), fmtUnit(s.cost_per_turn)]);
export function periodOptions(data) {
  const list = Array.isArray(data?.available) ? [...data.available] : [];
  if (typeof data?.period === "string" && !list.includes(data.period)) list.push(data.period);
  return list.sort().reverse();
}
export function footerText(data) {
  const parts = [translate("md6984726c63f", [new Date(data.generatedAt).toLocaleString(localeTag())])];
  if (data.model) parts.push(data.model);
  const u = data.usage;
  if (u) {
    parts.push(translate("m05dc59977847", [fmt(u.inputTokens), fmt(u.outputTokens)]));
    if (u.estimatedCostUsd != null) parts.push(translate("me37043bb5679", [fmtUnit(u.estimatedCostUsd)]));
  }
  return parts.join(" · ");
}

function ReadyBody({ data }) {
  const _locale = useLocale();
  const org = data.org?.period;
  const users = Array.isArray(data.users) ? data.users : [];
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const caveats = Array.isArray(data.caveats) ? data.caveats : [];
  return (
    <>
      {org && <p className="text-[12px] text-ink-600 tabular">{translate("m650f46e00f49", [statsText(org), fmt(org.sessions)])}</p>}
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
                {stored && <p className="mt-1 text-[12px] text-ink-500 tabular">{translate("m05408d35e0b6", [statsText(stored)])}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {caveats.length > 0 && (
        <div className="mt-4">
          <div className="text-[12px] font-semibold text-ink-600">{translate("m048defc02c26")}</div>
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
  const _locale = useLocale();
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data || typeof data !== "object" || Array.isArray(data) || data.enabled !== true) return null;
  const options = periodOptions(data);
  const right = options.length > 0 ? (
    <select aria-label={translate("mae42e50e22a1")} value={period ?? data.period ?? ""} onChange={(e) => onPeriod?.(e.target.value)}
      className="rounded-md border border-ink-100 bg-card px-2 py-1 text-[12px] text-ink-700">
      {options.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>
  ) : null;
  let body;
  if (data.status === "pending") body = <p className="text-sm text-ink-500">{translate("mffc9608e381a", [data.period])}</p>;
  else if (data.status === "failed") body = <p className="text-sm text-ink-500">{translate("m142ab955e341", [data.period])}</p>;
  else if (data.status !== "ready") body = <p className="text-sm text-ink-500">{translate("m1002b28685f9")}</p>;
  else if (data.empty === true) body = <p className="text-sm text-ink-500">{translate("mca1ac2e588c6", [data.period])}</p>;
  else body = <ReadyBody data={data} />;
  return (
    <Card title={translateSource(TITLE)} subtitle={translateSource(SUBTITLE)} help={translateSource(HELP)} right={right}>
      {body}
      <p className="mt-4 text-[12px] text-ink-500">{translateSource(DISCLAIMER)}</p>
    </Card>
  );
}

export default function DailyInsights() {
  const _locale = useLocale();
  const [period, setPeriod] = useState(null);
  const insights = useApi("/api/insights/daily", period ? { period } : {});
  return <DailyInsightsView data={insights.data} loading={insights.loading} error={insights.error}
    period={period} onPeriod={setPeriod} />;
}
