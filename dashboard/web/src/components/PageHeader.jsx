import { cn } from "../cn.js";
import { Badge } from "./Badge.jsx";

// ../awsops web/components/ui/PageHeader.tsx 포팅.
export function PageHeader({ title, subtitle, live = false, right, className }) {
  return (
    <header className={cn("flex flex-col gap-3 px-8 pt-[26px] pb-5 bg-chrome border-b border-chrome-border lg:flex-row lg:items-start lg:justify-between lg:gap-4", className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[24px] font-semibold tracking-[-0.01em] text-chrome-fg leading-tight">{title}</h1>
          {live && (
            <Badge tone="positive" dot>
              실시간
            </Badge>
          )}
        </div>
        {subtitle != null && <p className="text-[14px] text-chrome-fg-muted mt-1.5 max-w-[680px]">{subtitle}</p>}
      </div>
      {right != null && <div className="flex items-center gap-3 shrink-0">{right}</div>}
    </header>
  );
}
