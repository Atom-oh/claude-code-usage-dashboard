import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { useRange } from "../RangeContext.jsx";
import { useConfig } from "../ConfigContext.jsx";
import { BROWSER_TIME_ZONE } from "../clientPresentation.js";
import { SegmentedControl } from "./SegmentedControl.jsx";

const ymdUtc = (d) => d.toISOString().slice(0, 10);
const localDateTime = (d) => {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function DateRangePopover() {
  const { from, to, custom, mode, setRange } = useRange();
  const { rangeCapDays } = useConfig();
  const [open, setOpen] = useState(false);
  const [inputMode, setInputMode] = useState("date");
  const [fromStr, setFromStr] = useState("");
  const [toStr, setToStr] = useState("");
  const [err, setErr] = useState("");
  const wrapRef = useRef(null);
  const popoverRef = useRef(null);
  const [offset, setOffset] = useState(0);
  const fromId = useId();
  const toId = useId();

  const fillInputs = (nextMode) => {
    setInputMode(nextMode);
    const start = mode === "custom" ? custom.from : from;
    const end = mode === "custom" ? custom.to : to;
    setFromStr(nextMode === "time" ? localDateTime(start) : ymdUtc(start));
    // Calendar dates include the last day; exact times retain the exclusive boundary.
    setToStr(nextMode === "time" ? localDateTime(end) : ymdUtc(mode === "custom" ? new Date(end.getTime() - 1) : end));
    setErr("");
  };
  const openPopover = () => {
    fillInputs(mode === "custom" && custom.source !== "calendar" ? "time" : inputMode);
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const align = () => {
      const right = wrapRef.current.getBoundingClientRect().right;
      const width = popoverRef.current.getBoundingClientRect().width;
      const left = Math.max(16, Math.min(right - width, window.innerWidth - width - 16));
      setOffset(left - (right - width));
    };
    align();
    window.addEventListener("resize", align);
    return () => window.removeEventListener("resize", align);
  }, [open]);

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
    if (inputMode === "time") {
      if (!fromStr || !toStr) {
        setErr("시작 시각과 종료 시각을 모두 선택하세요");
        return;
      }
      const start = new Date(fromStr), end = new Date(toStr);
      // Reject invalid local times (including times skipped by a DST transition).
      const normalized = (s) => s.length === 16 ? `${s}:00` : s.replace(/\.0+$/, "");
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
        || localDateTime(start) !== normalized(fromStr) || localDateTime(end) !== normalized(toStr)) {
        setErr("선택한 시간대에서 유효한 날짜와 시각을 입력하세요");
        return;
      }
      if (start >= end) {
        setErr("종료 시각은 시작 시각보다 늦어야 합니다");
        return;
      }
      if (end - start > rangeCapDays * 86400000) {
        setErr(`최대 ${rangeCapDays}일까지 선택할 수 있습니다`);
        return;
      }
      if (end > new Date()) {
        setErr("미래 시각은 선택할 수 없습니다");
        return;
      }
      setRange(start, end, "time");
      setOpen(false);
      return;
    }
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
        <div ref={popoverRef} style={{ transform: `translateX(${offset}px)` }}
          className="absolute right-0 top-full mt-1 z-20 w-[min(24rem,calc(100vw-2rem))] bg-card border border-ink-100 rounded-lg shadow-card p-3">
          <div className="flex flex-col gap-2">
            <SegmentedControl options={[{ value: "date", label: "날짜" }, { value: "time", label: "날짜·시간" }]}
              value={inputMode} onChange={fillInputs} />
            <label className="flex flex-col gap-1 text-[12px] text-ink-500" htmlFor={fromId}>
              {inputMode === "time" ? "시작 시각" : "시작일"}
              <input
                id={fromId}
                type={inputMode === "time" ? "datetime-local" : "date"}
                step={inputMode === "time" ? 1 : undefined}
                value={fromStr}
                max={inputMode === "time" ? localDateTime(new Date()) : maxDay}
                onChange={(e) => setFromStr(e.target.value)}
                onKeyDown={onKeyDownInput}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-ink-500" htmlFor={toId}>
              {inputMode === "time" ? "종료 시각" : "종료일"}
              <input
                id={toId}
                type={inputMode === "time" ? "datetime-local" : "date"}
                step={inputMode === "time" ? 1 : undefined}
                value={toStr}
                max={inputMode === "time" ? localDateTime(new Date()) : maxDay}
                onChange={(e) => setToStr(e.target.value)}
                onKeyDown={onKeyDownInput}
                className={inputCls}
              />
            </label>
            <p className="text-[11px] text-ink-400">{inputMode === "time"
              ? `브라우저 시간 (${BROWSER_TIME_ZONE}) · 종료 시각 직전까지 조회합니다`
              : "날짜는 UTC 기준입니다"}</p>
            {err && <p role="alert" className="text-[11px] text-negative-text">{err}</p>}
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
