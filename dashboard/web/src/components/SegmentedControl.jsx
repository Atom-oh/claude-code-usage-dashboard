import { cn } from "../cn.js";

// ../awsops web/components/ui/SegmentedControl.tsx 포팅.
export function SegmentedControl({ options, value, onChange, className }) {
  return (
    <div className={cn("inline-flex items-center gap-0.5 bg-card border border-ink-100 rounded-md p-0.5", className)}>
      {options.map((o) => {
        const opt = typeof o === "string" ? { value: o, label: o } : o;
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange?.(opt.value)}
            className={cn(
              "h-[26px] px-3 rounded-[6px] text-[12px] font-medium whitespace-nowrap transition-colors duration-[120ms] cursor-pointer",
              active ? "bg-brand-500 text-white shadow-sm" : "text-ink-500 hover:text-ink-800"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
