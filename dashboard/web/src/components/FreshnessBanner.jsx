import { translate, useLocale } from "../i18n/index.js";
import { AlertTriangle } from "lucide-react";
import { cn } from "../cn.js";
import { useFreshness } from "../FreshnessContext.jsx";

// 24시간 이상은 일/시간, 1시간 이상은 시간/분, 그 아래는 분 — "1440분 전"보다 "1일 0시간 전"이
// 장애 대응에서 바로 읽힌다.
function formatAge(ageMinutes) {
  const m = Math.max(0, Number(ageMinutes) || 0);
  if (m >= 1440) return translate("m1ffdb75a3595", [Math.floor(m / 1440), Math.floor((m % 1440) / 60)]);
  if (m >= 60) return translate("mb741be1f240d", [Math.floor(m / 60), m % 60]);
  return translate("m949d9fec534d", [m]);
}

export default function FreshnessBanner({ className }) {
  const _locale = useLocale();
  const { status, ageMinutes, staleAfterMinutes } = useFreshness();
  // ok는 물론 loading(첫 응답 전)에도 아무것도 그리지 않는다 — 정상 배포에서 배너가 한 프레임
  // 깜빡이면 그게 더 큰 오해를 만든다.
  if (status === "ok" || status === "loading") return null;

  const message =
    status === "stale"
      ? translate("m4560c4ff24ab", [staleAfterMinutes, formatAge(ageMinutes)])
      : translate("mc7be4799aa68");

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-surface px-4 py-3 shadow-sm",
        className
      )}
    >
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
      <p className="tabular text-[12px] leading-relaxed text-warning-text">{message}</p>
    </div>
  );
}
