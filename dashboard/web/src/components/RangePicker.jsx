import { useRange } from "../RangeContext.jsx";
import { SegmentedControl } from "./SegmentedControl.jsx";

const fmtDay = (d) => d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });

export function RangePicker() {
  const { days, setDays, from, to } = useRange();
  return (
    <div className="flex items-center gap-2">
      <SegmentedControl
        options={[
          { value: "1", label: "1일" },
          { value: "2", label: "2일" },
          { value: "7", label: "7일" },
          { value: "14", label: "14일" },
          { value: "30", label: "30일" },
        ]}
        value={String(days)}
        onChange={(v) => setDays(Number(v))}
      />
      <span className="hidden md:inline text-[11px] text-ink-400 tabular whitespace-nowrap">
        {fmtDay(from)} – {fmtDay(to)}
      </span>
    </div>
  );
}
