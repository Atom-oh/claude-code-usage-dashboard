import { cn } from "../cn.js";

export function SectionLabel({ children, className }) {
  return <div className={cn("text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400", className)}>{children}</div>;
}
