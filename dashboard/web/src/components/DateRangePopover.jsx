import { localizedMessage, messageText, translate, useLocale } from "../i18n/index.js";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import DatePicker from "react-datepicker";
import { ko, enUS, ja, zhCN, es } from "date-fns/locale";
import "react-datepicker/dist/react-datepicker.css";
import { useRange } from "../RangeContext.jsx";
import { useConfig } from "../ConfigContext.jsx";
import { BROWSER_TIME_ZONE } from "../clientPresentation.js";
import { SegmentedControl } from "./SegmentedControl.jsx";

const ymdUtc = (d) => d.toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, "0");
const ymdLocal = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const calendarLocale = { ko, en: enUS, ja, "zh-CN": zhCN, es };
const calendarHeader = { ko: "yyyy년 M월", en: "LLLL yyyy", ja: "yyyy年M月", "zh-CN": "yyyy年M月", es: "LLLL yyyy" };
const calendarDay = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
};
const localDateTime = (d) => {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

function PickerField({ id, label, value, setValue, mode, locale, active, onOpen, onDone, trigger, maxDay, onKeyDown }) {
  const labelId = `${id}-label`;
  const time = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.0+)?)?$/.exec(value);
  const timeParts = [time?.[2] || "00", time?.[3] || "00", time?.[4] || "00"];
  const setPart = (index, next) => {
    if (!time) return;
    const parts = [...timeParts];
    parts[index] = next;
    setValue(`${time[1]}T${parts.join(":")}`);
  };
  const changeDay = (date) => {
    if (!date) return;
    const suffix = mode === "time" ? `T${timeParts.join(":")}` : "";
    setValue(`${ymdLocal(date)}${suffix}`);
  };
  return <div className="flex flex-col gap-1 text-[12px] text-ink-500">
    <label id={labelId} htmlFor={id}>{label}</label>
    <div className="flex min-w-0 items-center gap-2">
      <input id={id} type={mode === "time" ? "datetime-local" : "date"}
        step={mode === "time" ? 1 : undefined} value={value}
        max={mode === "time" ? localDateTime(new Date()) : maxDay}
        onChange={(event) => setValue(event.target.value)} onKeyDown={onKeyDown}
        className="range-picker-input min-w-0 flex-1 rounded-md border border-ink-200 bg-white px-2 py-1 text-sm focus:border-brand-500 focus:outline-none" />
      <button ref={trigger} type="button" onClick={onOpen} aria-expanded={active}
        aria-label={translate("m230bfa94fe54", [label])}
        className="shrink-0 rounded-md border border-ink-200 bg-white p-2 text-ink-600 hover:bg-ink-50">
        <CalendarDays size={15} aria-hidden="true" />
      </button>
    </div>
    {active && <div className="rounded-md border border-ink-200 bg-white p-2" role="group" aria-label={label}>
      <DatePicker inline selected={calendarDay(value)} onChange={changeDay}
        locale={calendarLocale[locale]} dateFormatCalendar={calendarHeader[locale]}
        maxDate={mode === "date" ? calendarDay(maxDay) : new Date()}
        previousMonthAriaLabel={translate("m77f9e6084937")} nextMonthAriaLabel={translate("m4c33c6a0b753")}
        chooseDayAriaLabelPrefix={translate("m83e222c2fb52")} disabledDayAriaLabelPrefix={translate("m49e86c3288d4")} />
      {mode === "time" && <div className="mt-2 flex gap-2">
        {[["mbfa42cf6a12e", 24], ["mca4a187881db", 60], ["m1fd639e1ec96", 60]].map(([key, limit], index) => {
          const partId = `${id}-${index}`;
          return <div className="min-w-0 flex-1" key={key}>
            <label id={`${partId}-label`} htmlFor={partId} className="block">{translate(key)}</label>
            <select id={partId} aria-labelledby={`${labelId} ${partId}-label`} value={timeParts[index]}
              disabled={!time} onChange={(event) => setPart(index, event.target.value)}
              className="w-full rounded-md border border-ink-200 bg-white px-2 py-1 text-sm">
              {Array.from({ length: limit }, (_, n) => <option key={n} value={pad(n)}>{pad(n)}</option>)}
            </select>
          </div>;
        })}
      </div>}
      <div className="mt-2 flex justify-end">
        <button type="button" onClick={() => { onDone(); trigger.current?.focus(); }}
          className="rounded-md bg-brand-600 px-3 py-1 text-sm text-white hover:bg-brand-700">
          {translate("meeabcb446f68", [label])}
        </button>
      </div>
    </div>}
  </div>;
}

export function DateRangePopover() {
  const locale = useLocale();
  const { from, to, custom, mode, setRange } = useRange();
  const { rangeCapDays } = useConfig();
  const [open, setOpen] = useState(false);
  const [inputMode, setInputMode] = useState("date");
  const [activePicker, setActivePicker] = useState(null);
  const [fromStr, setFromStr] = useState("");
  const [toStr, setToStr] = useState("");
  const [err, setErr] = useState("");
  const wrapRef = useRef(null);
  const popoverRef = useRef(null);
  const fromTrigger = useRef(null);
  const toTrigger = useRef(null);
  const [position, setPosition] = useState({ left: 16, top: 16 });
  const fromId = useId();
  const toId = useId();

  const fillInputs = (nextMode) => {
    setActivePicker(null);
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
      if (!wrapRef.current || !popoverRef.current) return;
      const anchor = wrapRef.current.getBoundingClientRect();
      const panel = popoverRef.current.getBoundingClientRect();
      const left = Math.max(16, Math.min(anchor.right - panel.width, window.innerWidth - panel.width - 16));
      const top = Math.max(16, Math.min(anchor.bottom + 4, window.innerHeight - panel.height - 16));
      setPosition((old) => old.left === left && old.top === top ? old : { left, top });
    };
    align();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(align);
    observer?.observe(popoverRef.current);
    window.addEventListener("resize", align);
    window.addEventListener("scroll", align, true);
    return () => { observer?.disconnect(); window.removeEventListener("resize", align); window.removeEventListener("scroll", align, true); };
  }, [open, activePicker, locale, err]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (activePicker) {
          (activePicker === "from" ? fromTrigger : toTrigger).current?.focus();
          setActivePicker(null);
        }
        else setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, activePicker]);

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
        <div ref={popoverRef} style={position} role="group" aria-label={translate("md8eef220eac1")}
          className="fixed z-20 max-h-[calc(100vh-2rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-ink-100 bg-card p-3 shadow-card">
          <div className="flex flex-col gap-2">
            <SegmentedControl options={[{ value: "date", label: translate("m09f76a1b7a67") }, { value: "time", label: translate("m2e988f0ffe70") }]}
              value={inputMode} onChange={fillInputs} />
            <PickerField id={fromId} label={translate(inputMode === "time" ? "m65bdaefd24da" : "mf86e346d4251")}
              value={fromStr} setValue={setFromStr} mode={inputMode} locale={locale} maxDay={maxDay}
              active={activePicker === "from"} onOpen={() => setActivePicker(activePicker === "from" ? null : "from")}
              onDone={() => setActivePicker(null)} trigger={fromTrigger} onKeyDown={onKeyDownInput} />
            <PickerField id={toId} label={translate(inputMode === "time" ? "m26c25fca2668" : "m9e586213e334")}
              value={toStr} setValue={setToStr} mode={inputMode} locale={locale} maxDay={maxDay}
              active={activePicker === "to"} onOpen={() => setActivePicker(activePicker === "to" ? null : "to")}
              onDone={() => setActivePicker(null)} trigger={toTrigger} onKeyDown={onKeyDownInput} />
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
