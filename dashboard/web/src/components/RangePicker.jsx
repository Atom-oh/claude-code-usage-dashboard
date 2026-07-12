import { X } from "lucide-react";
import { useRange } from "../RangeContext.jsx";
import { SegmentedControl } from "./SegmentedControl.jsx";

const fmtDay = (d) => d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
const fmtDateTime = (d) => d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function RangePicker() {
  const { days, setDays, from, to, custom } = useRange();
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
        // 차트 드래그 줌 중이면 프리셋은 미선택 — 프리셋을 다시 누르면 setDays가 줌을 해제한다.
        value={custom ? "" : String(days)}
        onChange={(v) => setDays(Number(v))}
      />
      {custom ? (
        <button
          type="button"
          onClick={() => setDays(days)}
          className="flex items-center gap-1 rounded-md bg-brand-50 px-2 py-1 text-[11px] font-medium text-brand-700 tabular whitespace-nowrap hover:bg-brand-100"
          title="확대 해제"
        >
          {fmtDateTime(custom.from)} – {fmtDateTime(custom.to)}
          <X size={12} />
        </button>
      ) : (
        <span className="hidden md:inline text-[11px] text-ink-400 tabular whitespace-nowrap">
          {fmtDay(from)} – {fmtDay(to)}
        </span>
      )}
    </div>
  );
}
