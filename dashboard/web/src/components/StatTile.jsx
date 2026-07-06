import { cn } from "../cn.js";

// ../awsops web/components/ui/StatTile.tsx 포팅.
function trendTone(trend) {
  const t = trend.trim();
  if (t.startsWith("↑") || t.startsWith("+")) return "bg-positive-surface text-positive-text";
  if (t.startsWith("↓") || t.startsWith("-") || t.startsWith("−")) return "bg-negative-surface text-negative-text";
  return "bg-ink-100 text-ink-600";
}

export function StatTile({ label, value, eyebrow, trend, hint, variant = "default", className }) {
  const border = variant === "accent" ? "border-brand-200" : variant === "danger" ? "border-negative-border" : "border-ink-100";
  const valueColor = variant === "danger" ? "text-negative-text" : variant === "warn" ? "text-brand-700" : "text-ink-800";

  return (
    <div className={cn("relative overflow-hidden bg-card border rounded-lg shadow-card p-4", border, className)}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{eyebrow ?? label}</div>
      <div className={cn("tabular text-[26px] font-semibold leading-tight mt-1", valueColor)}>{value}</div>
      {(trend || hint != null) && (
        <div className="flex items-center gap-2 mt-1.5">
          {trend && (
            <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular", trendTone(trend))}>
              {trend}
            </span>
          )}
          {hint != null && <span className="text-[11px] text-ink-400 truncate">{hint}</span>}
        </div>
      )}
    </div>
  );
}
