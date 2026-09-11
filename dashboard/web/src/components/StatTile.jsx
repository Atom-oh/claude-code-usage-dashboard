import { Info } from "lucide-react";
import { cn } from "../cn.js";

// ../awsops web/components/ui/StatTile.tsx 포팅.
function trendTone(trend) {
  const t = trend.trim();
  if (t.startsWith("↑") || t.startsWith("+")) return "bg-positive-surface text-positive-text";
  if (t.startsWith("↓") || t.startsWith("-") || t.startsWith("−")) return "bg-negative-surface text-negative-text";
  return "bg-ink-100 text-ink-600";
}

// 타일 안 미니 추세(dataviz: 스탯 타일 = 값 + 델타 + 스파크라인). 축·그리드 없이 선 + 은은한
// 면 + 끝점 강조만 — 정확한 값은 타일의 숫자가, 여기는 방향과 모양만 나른다.
function Sparkline({ points }) {
  const W = 120, H = 26, PAD = 3;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const x = (i) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const path = points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const lastX = x(points.length - 1), lastY = y(points[points.length - 1]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-[26px] w-full" preserveAspectRatio="none" aria-hidden="true">
      <path d={`${path}L${lastX},${H}L${x(0)},${H}Z`} fill="var(--chart-1)" opacity="0.08" />
      <path d={path} fill="none" stroke="var(--chart-1)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r="2.5" fill="var(--chart-1)" stroke="var(--surface-card)" strokeWidth="1.5" />
    </svg>
  );
}

// style은 그룹/계열 색 틴트처럼 값이 동적인 색상만 넘기는 용도 — 정적 스타일은 className으로.
export function StatTile({ label, value, eyebrow, help, trend, hint, spark, variant = "default", className, style }) {
  const border = variant === "accent" ? "border-brand-200" : variant === "danger" ? "border-negative-border" : "border-ink-100";
  const valueColor = variant === "danger" ? "text-negative-text" : variant === "warn" ? "text-brand-700" : "text-ink-800";

  return (
    <div className={cn("relative overflow-hidden bg-card border rounded-lg shadow-card p-4", border, className)} style={style}>
      <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">
        <span className="truncate">{eyebrow ?? label}</span>
        {help && <Info size={12} className="shrink-0 text-ink-400" title={help} aria-label={help} />}
      </div>
      <div className={cn("tabular text-base sm:text-[26px] font-semibold leading-tight mt-1", valueColor)}>{value}</div>
      {Array.isArray(spark) && spark.length > 1 && <Sparkline points={spark.map(Number)} />}
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
