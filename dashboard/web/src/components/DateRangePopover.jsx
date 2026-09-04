import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { useRange } from "../RangeContext.jsx";
import { useConfig } from "../ConfigContext.jsx";

const ymdUtc = (d) => d.toISOString().slice(0, 10);

export function DateRangePopover() {
  const { from, to, custom, mode, setRange } = useRange();
  const { rangeCapDays } = useConfig();
  const [open, setOpen] = useState(false);
  const [fromStr, setFromStr] = useState("");
  const [toStr, setToStr] = useState("");
  const [err, setErr] = useState("");
  const wrapRef = useRef(null);
  const fromId = useId();
  const toId = useId();

  const openPopover = () => {
    // custom.to는 배타적 경계다 — 입력창에는 사용자가 고른 마지막 날짜를 되돌려 준다.
    setFromStr(ymdUtc(mode === "custom" ? custom.from : from));
    setToStr(ymdUtc(mode === "custom" ? new Date(custom.to.getTime() - 1) : to));
    setErr("");
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const apply = () => {
    if (!fromStr || !toStr) {
      setErr("시작일과 종료일을 모두 선택하세요");
      return;
    }
    const [y1, m1, d1] = fromStr.split("-").map(Number);
    const [y2, m2, d2] = toStr.split("-").map(Number);
    const fromMs = Date.UTC(y1, m1 - 1, d1);
    const toMs = Date.UTC(y2, m2 - 1, d2);
    if (fromMs > toMs) {
      setErr("시작일이 종료일보다 늦습니다");
      return;
    }
    // 서버 parseRange와 같은 판정 — to는 다음 UTC 날의 시작이므로 포함 일수는 차이+1이고,
    // 상한과 정확히 같은 길이는 통과해야 한다.
    if ((toMs - fromMs) / 86400000 + 1 > rangeCapDays) {
      setErr(`최대 ${rangeCapDays}일까지 선택할 수 있습니다`);
      return;
    }
    // 서버는 TimeUnix < to로 자르므로 고른 종료일이 온전히 포함되려면 다음 UTC 날의 시작을 보낸다.
    setRange(new Date(fromMs), new Date(toMs + 86400000), "calendar");
    setOpen(false);
  };

  const onKeyDownInput = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    }
  };

  const maxDay = ymdUtc(new Date());
  const inputCls = "text-sm px-2 py-1 rounded-md border border-ink-200 bg-white focus:border-brand-500 focus:outline-none";

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPopover())}
        aria-label="기간 직접 선택"
        title="기간 직접 선택"
        aria-expanded={open}
        className="rounded-md border border-ink-200 bg-white px-2 py-1 text-ink-500 hover:bg-ink-50"
      >
        <CalendarDays size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-72 bg-card border border-ink-100 rounded-lg shadow-card p-3">
          <div className="flex flex-col gap-2">
            <label className="flex items-center justify-between gap-2 text-[12px] text-ink-500" htmlFor={fromId}>
              시작일
              <input
                id={fromId}
                type="date"
                value={fromStr}
                max={maxDay}
                onChange={(e) => setFromStr(e.target.value)}
                onKeyDown={onKeyDownInput}
                className={inputCls}
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-[12px] text-ink-500" htmlFor={toId}>
              종료일
              <input
                id={toId}
                type="date"
                value={toStr}
                max={maxDay}
                onChange={(e) => setToStr(e.target.value)}
                onKeyDown={onKeyDownInput}
                className={inputCls}
              />
            </label>
            <p className="text-[11px] text-ink-400">날짜는 UTC 기준입니다</p>
            {err && <p className="text-[11px] text-negative-text">{err}</p>}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={() => setOpen(false)} className="text-[12px] px-2 py-1 rounded-md text-ink-500 hover:bg-ink-50">
                취소
              </button>
              <button type="button" onClick={apply} className="text-[12px] px-3 py-1 rounded-md bg-brand-500 text-white hover:bg-brand-600">
                적용
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
