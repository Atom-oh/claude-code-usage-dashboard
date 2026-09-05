import { RefreshCw } from "lucide-react";
import { cn } from "../cn.js";
import { REFRESH_OPTIONS, useRefresh } from "../RefreshContext.jsx";

// FilterBar 오른쪽 끝에 붙는 자동 새로고침 컨트롤. 수동 버튼은 주기가 "끔"이어도 항상 눌린다.
export function RefreshControl({ className }) {
  const { intervalMs, setIntervalMs, refreshNow, lastRefreshedAt, lastError } = useRefresh();
  return (
    <div className={cn("flex items-center gap-2", className)}>
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
      {lastError ? (
        <span className="hidden md:inline text-[11px] tabular text-warning-text whitespace-nowrap">갱신 실패</span>
      ) : lastRefreshedAt ? (
        <span className="hidden md:inline text-[11px] tabular text-ink-400 whitespace-nowrap">
          {lastRefreshedAt.toLocaleTimeString("ko-KR")} 갱신
        </span>
      ) : null}
    </div>
  );
}
