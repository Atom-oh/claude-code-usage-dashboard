import { cn } from "../cn.js";
import { Badge } from "./Badge.jsx";
import { useFreshness } from "../FreshnessContext.jsx";

// ../awsops web/components/ui/PageHeader.tsx 포팅.
export function PageHeader({ title, subtitle, live = false, right, className }) {
  // live pill은 "지금 데이터가 흐르고 있다"는 주장이다 — 수신이 멈춘 동안 그대로 띄우면 화면이
  // 거짓말을 한다. 판단 보류(loading/unknown)에서는 아무 배지도 걸지 않는다: 배너
  // (FreshnessBanner)가 이미 그 상태를 말하고 있어 여기서 또 말하면 중복 경고다.
  const { status } = useFreshness();
  return (
    <header className={cn("flex flex-col gap-3 px-8 pt-[26px] pb-5 bg-chrome border-b border-chrome-border lg:flex-row lg:items-start lg:justify-between lg:gap-4", className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[24px] font-semibold tracking-[-0.01em] text-chrome-fg leading-tight">{title}</h1>
          {live && status === "ok" && (
            <Badge tone="positive" dot>
              실시간
            </Badge>
          )}
          {live && status === "stale" && (
            // Badge에는 warning tone이 없고 cn()은 tailwind-merge가 아니라 단순 문자열 합침이라
            // (cn.js) tone 클래스를 className으로 덮을 수 없다 — 같은 모양의 span을 직접 쓴다.
            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap bg-warning-surface text-warning-text">
              <span className="h-1.5 w-1.5 rounded-full bg-warning" />
              수신 중단
            </span>
          )}
        </div>
        {subtitle != null && <p className="text-[14px] text-chrome-fg-muted mt-1.5 max-w-[680px]">{subtitle}</p>}
      </div>
      {right != null && <div className="flex items-center gap-3 shrink-0">{right}</div>}
    </header>
  );
}
