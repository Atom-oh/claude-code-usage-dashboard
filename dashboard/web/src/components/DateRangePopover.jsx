import { localizedMessage, messageText, translate, useLocale } from "../i18n/index.js";
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
  const _locale = useLocale();
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
        setErr(localizedMessage("maaa8d6e87991"));
        return;
      }
      const start = new Date(fromStr), end = new Date(toStr);
      // Reject invalid local times (including times skipped by a DST transition).
      const normalized = (s) => s.length === 16 ? `${s}:00` : s.replace(/\.0+$/, "");
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
        || localDateTime(start) !== normalized(fromStr) || localDateTime(end) !== normalized(toStr)) {
        setErr(localizedMessage("m6ac3d055663f"));
        return;
      }
      if (start >= end) {
        setErr(localizedMessage("m4702b62e9055"));
        return;
      }
      if (end - start > rangeCapDays * 86400000) {
        setErr(localizedMessage("m8c4ff6724d20", [rangeCapDays]));
        return;
      }
      if (end > new Date()) {
        setErr(localizedMessage("m31664ca80570"));
        return;
      }
      setRange(start, end, "time");
      setOpen(false);
      return;
    }
    if (!fromStr || !toStr) {
      setErr(localizedMessage("m76e4aef48bac"));
      return;
    }
    const [y1, m1, d1] = fromStr.split("-").map(Number);
    const [y2, m2, d2] = toStr.split("-").map(Number);
    const fromMs = Date.UTC(y1, m1 - 1, d1);
    const toMs = Date.UTC(y2, m2 - 1, d2);
    if (fromMs > toMs) {
      setErr(localizedMessage("m27cb2fc4f381"));
      return;
    }
    // 서버 parseRange와 같은 판정 — to는 다음 UTC 날의 시작이므로 포함 일수는 차이+1이고,
    // 상한과 정확히 같은 길이는 통과해야 한다.
    if ((toMs - fromMs) / 86400000 + 1 > rangeCapDays) {
      setErr(localizedMessage("m8c4ff6724d20", [rangeCapDays]));
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
        aria-label={translate("md8eef220eac1")}
        title={translate("md8eef220eac1")}
        aria-expanded={open}
        className="rounded-md border border-ink-200 bg-white px-2 py-1 text-ink-500 hover:bg-ink-50"
      >
        <CalendarDays size={14} />
      </button>
      {open && (
        <div ref={popoverRef} style={{ transform: `translateX(${offset}px)` }}
          className="absolute right-0 top-full mt-1 z-20 w-[min(24rem,calc(100vw-2rem))] bg-card border border-ink-100 rounded-lg shadow-card p-3">
          <div className="flex flex-col gap-2">
            <SegmentedControl options={[{ value: "date", label: translate("m09f76a1b7a67") }, { value: "time", label: translate("m2e988f0ffe70") }]}
              value={inputMode} onChange={fillInputs} />
            <label className="flex flex-col gap-1 text-[12px] text-ink-500" htmlFor={fromId}>
              {inputMode === "time" ? translate("m65bdaefd24da") : translate("mf86e346d4251")}
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
              {inputMode === "time" ? translate("m26c25fca2668") : translate("m9e586213e334")}
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
              ? translate("mcf496d8bac9f", [BROWSER_TIME_ZONE])
              : translate("m27d9b76bd2ec")}</p>
            {err && <p role="alert" className="text-[11px] text-negative-text">{messageText(err)}</p>}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={() => setOpen(false)} className="text-[12px] px-2 py-1 rounded-md text-ink-500 hover:bg-ink-50">{translate("mbe876433993a")}</button>
              <button type="button" onClick={apply} className="text-[12px] px-3 py-1 rounded-md bg-brand-500 text-white hover:bg-brand-600">{translate("m6a1c963d5bc5")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
