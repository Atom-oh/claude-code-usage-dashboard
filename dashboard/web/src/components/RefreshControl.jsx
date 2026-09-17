import { RefreshCw } from "lucide-react";
import { cn } from "../cn.js";
import { REFRESH_OPTIONS, useRefresh } from "../RefreshContext.jsx";

// FilterBar 오른쪽 끝에 붙는 자동 새로고침 컨트롤. 수동 버튼은 주기가 "끔"이어도 항상 눌린다.
export function RefreshControl({ className }) {
  const { intervalMs, setIntervalMs, refreshNow, lastRefreshedAt, lastError, isRefreshing } = useRefresh();
  const status = lastError ? "갱신 실패 · 이전 데이터 표시"
    : isRefreshing ? "갱신 중 · 이전 데이터 표시"
    : lastRefreshedAt ? `${lastRefreshedAt.toLocaleTimeString("ko-KR")} 갱신 시도` : "";
  return (
    <div className={cn("flex w-44 shrink-0 flex-col items-end gap-1", className)}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={refreshNow}
          aria-label="지금 새로고침"
          title="지금 새로고침"
          className="rounded-md border border-ink-200 bg-white px-2 py-1 text-ink-500 hover:bg-ink-50"
        >
          <RefreshCw size={14} />
        </button>
        <select
          value={intervalMs}
          onChange={(e) => setIntervalMs(Number(e.target.value))}
          aria-label="자동 새로고침 간격"
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
