import { localeTag, translate, useLocale } from "../i18n/index.js";
import { RefreshCw } from "lucide-react";
import { cn } from "../cn.js";
import { REFRESH_OPTIONS, useRefresh } from "../RefreshContext.jsx";

// FilterBar 오른쪽 끝에 붙는 자동 새로고침 컨트롤. 수동 버튼은 주기가 "끔"이어도 항상 눌린다.
export function RefreshControl({ className }) {
  const _locale = useLocale();
  const { intervalMs, setIntervalMs, refreshNow, lastRefreshedAt, lastError, isRefreshing } = useRefresh();
  const status = lastError ? translate("mdc707ee420b2")
    : isRefreshing ? translate("m6363fc35822a")
    : lastRefreshedAt ? translate("mf41aaa3ce53d", [lastRefreshedAt.toLocaleTimeString(localeTag())]) : "";
  return (
    <div className={cn("flex w-44 shrink-0 flex-col items-end gap-1", className)}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={refreshNow}
          aria-label={translate("m2c89bc03ed4b")}
          title={translate("m2c89bc03ed4b")}
          className="rounded-md border border-ink-200 bg-white px-2 py-1 text-ink-500 hover:bg-ink-50"
        >
          <RefreshCw size={14} />
        </button>
        <select
          value={intervalMs}
          onChange={(e) => setIntervalMs(Number(e.target.value))}
          aria-label={translate("m14f4dc612756")}
          className="text-sm px-3 py-1.5 rounded-lg border border-ink-200 bg-white focus:border-brand-500 focus:outline-none"
        >
          {REFRESH_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <span role="status" className={cn("h-4 text-[11px] leading-4 tabular whitespace-nowrap",
        lastError ? "text-warning-text" : "text-ink-500")}>
        {status}
      </span>
    </div>
  );
}
