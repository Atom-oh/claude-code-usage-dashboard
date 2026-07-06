import { cn } from "../cn.js";

// ../awsops web/components/ui/Card.tsx 포팅 — white surface, ink-100 hairline, radius-lg, shadow-card.
export function Card({ children, title, subtitle, right, padded = true, className }) {
  const hasHeader = title != null || subtitle != null || right != null;
  return (
    <div className={cn("bg-card border border-ink-100 rounded-lg shadow-card overflow-hidden", className)}>
      {hasHeader && (
        <div className="flex items-start justify-between gap-4 px-4 pt-4 pb-3 border-b border-ink-100">
          <div className="min-w-0">
            {title != null && <div className="text-[14px] font-semibold text-ink-800 truncate">{title}</div>}
            {subtitle != null && <div className="text-[12px] text-ink-500 mt-0.5">{subtitle}</div>}
          </div>
          {right != null && <div className="shrink-0">{right}</div>}
        </div>
      )}
      <div className={cn(padded && "p-4")}>{children}</div>
    </div>
  );
}

export function Loading() {
  return <div className="text-ink-400 text-sm">불러오는 중...</div>;
}

export function ErrorBox({ error }) {
  return <div className="text-negative text-sm">오류: {error.message}</div>;
}
