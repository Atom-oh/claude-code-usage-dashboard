import { X } from "lucide-react";
import { useRange } from "../RangeContext.jsx";
import { useConfig } from "../ConfigContext.jsx";
import { PRESET_DAYS } from "../urlState.js";
import { SegmentedControl } from "./SegmentedControl.jsx";
import { DateRangePopover } from "./DateRangePopover.jsx";

const fmtDay = (d) => d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
const fmtDateTime = (d) => d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
// 달력 구간의 경계는 UTC 자정이라 표시도 UTC로 맞춘다 — 로컬 포맷터면 KST에서 하루 밀려 보인다.
const fmtDayUtc = (d) => d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric", timeZone: "UTC" });

export function RangePicker() {
  const { days, setDays, selectMonth, from, to, custom, mode } = useRange();
  const { rangeCapDays, defaultRangeDays } = useConfig();
  // 서버 기본 창(defaultRangeDays)이 프리셋 목록에 없을 수도 있다 — 그 값에도 버튼이 있어야
  // 첫 진입 상태가 선택 안 된 것처럼 보이지 않는다.
  const dayOptions = [...new Set([...PRESET_DAYS, defaultRangeDays])].sort((a, b) => a - b).filter((d) => d <= rangeCapDays);
  const options = [...dayOptions.map((d) => ({ value: String(d), label: `${d}일` })), { value: "month", label: "이번 달" }];
  return (
    <div className="flex items-center gap-2">
      <SegmentedControl
        options={options}
        // 커스텀 구간(드래그 줌·달력) 중이면 아무 프리셋도 선택되지 않는다.
        value={mode === "preset" ? String(days) : mode === "month" ? "month" : ""}
        onChange={(v) => (v === "month" ? selectMonth() : setDays(Number(v)))}
      />
      <DateRangePopover />
      {mode === "custom" ? (
        <button
          type="button"
          onClick={() => setDays(days)}
          className="flex items-center gap-1 rounded-md bg-brand-50 px-2 py-1 text-[11px] font-medium text-brand-700 tabular whitespace-nowrap hover:bg-brand-100"
          title={custom.source === "calendar" ? "기간 선택 해제" : "확대 해제"}
        >
          {custom.source === "calendar"
            ? `${fmtDayUtc(custom.from)} – ${fmtDayUtc(new Date(custom.to.getTime() - 1))}`
            : `${fmtDateTime(custom.from)} – ${fmtDateTime(custom.to)}`}
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
