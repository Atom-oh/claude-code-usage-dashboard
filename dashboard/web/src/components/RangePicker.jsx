import { formatUnit, localeTag, translate, useLocale } from "../i18n/index.js";
import { X } from "lucide-react";
import { useRange } from "../RangeContext.jsx";
import { useConfig } from "../ConfigContext.jsx";
import { PRESET_DAYS } from "../urlState.js";
import { SegmentedControl } from "./SegmentedControl.jsx";
import { DateRangePopover } from "./DateRangePopover.jsx";

const fmtDay = (d) => d.toLocaleDateString(localeTag(), { month: "numeric", day: "numeric" });
const fmtDateTime = (d) => d.toLocaleString(localeTag(), { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
// 달력 구간의 경계는 UTC 자정이라 표시도 UTC로 맞춘다 — 로컬 포맷터면 KST에서 하루 밀려 보인다.
const fmtDayUtc = (d) => d.toLocaleDateString(localeTag(), { month: "numeric", day: "numeric", timeZone: "UTC" });

export function RangePicker() {
  const _locale = useLocale();
  const { days, setDays, selectMonth, from, to, custom, mode } = useRange();
  const { rangeCapDays, defaultRangeDays } = useConfig();
  // 서버 기본 창(defaultRangeDays)이 프리셋 목록에 없을 수도 있다 — 그 값에도 버튼이 있어야
  // 첫 진입 상태가 선택 안 된 것처럼 보이지 않는다.
  const dayOptions = [...new Set([...PRESET_DAYS, defaultRangeDays])].sort((a, b) => a - b).filter((d) => d <= rangeCapDays);
  const options = [...dayOptions.map((d) => ({ value: String(d), label: formatUnit(d, "day") })), { value: "month", label: translate("m847ba673b64f") }];
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
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
          className="flex min-w-0 max-w-full items-center gap-1 rounded-md bg-brand-50 px-2 py-1 text-left text-[11px] font-medium text-brand-700 tabular hover:bg-brand-100"
          title={custom.source === "zoom" ? translate("m87bfc2328efd") : translate("m3114eb82f34a")}
        >
          {custom.source === "calendar"
            ? `${fmtDayUtc(custom.from)} – ${fmtDayUtc(new Date(custom.to.getTime() - 1))}`
            : `${fmtDateTime(custom.from)} – ${fmtDateTime(custom.to)}`}
          <X size={12} className="shrink-0" />
        </button>
      ) : (
        <span className="hidden md:inline text-[11px] text-ink-400 tabular whitespace-nowrap">
          {fmtDay(from)} – {fmtDay(to)}
        </span>
      )}
    </div>
  );
}
