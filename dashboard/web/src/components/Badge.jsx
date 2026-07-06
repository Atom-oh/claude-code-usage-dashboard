import { cn } from "../cn.js";

// ../awsops web/components/ui/Badge.tsx 포팅.
const SOFT = {
  neutral: "bg-ink-100 text-ink-600",
  brand: "bg-brand-50 text-brand-700",
  positive: "bg-positive-surface text-positive-text",
  negative: "bg-negative-surface text-negative-text",
  inverse: "bg-ink-800 text-paper",
};
const DOT = {
  neutral: "bg-ink-400",
  brand: "bg-brand-500",
  positive: "bg-positive",
  negative: "bg-negative",
  inverse: "bg-paper",
};

export function Badge({ children, tone = "neutral", dot = false, className }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap", SOFT[tone], className)}>
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", DOT[tone])} />}
      {children}
    </span>
  );
}
