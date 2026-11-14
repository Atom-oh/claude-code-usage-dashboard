import { Languages } from "lucide-react";
import { LOCALES, localeStore, translateSource, useLocaleState } from "../i18n/index.js";

export function LanguagePicker({ compact = false }) {
  const { locale, requested, pending, failed } = useLocaleState();
  const label = translateSource("언어");
  return (
    <div className={compact ? "min-w-0 max-w-36" : "mt-3 border-t border-chrome-border pt-3"}>
      <label className="flex min-w-0 items-center gap-2 text-xs text-chrome-fg-muted">
        <Languages size={15} aria-hidden="true" className="shrink-0" />
        <span className={compact ? "sr-only" : "shrink-0"}>{label}</span>
        <select
          aria-label={label}
          value={pending ? requested : locale}
          onChange={(event) => { void localeStore.select(event.target.value); }}
          className="min-w-0 flex-1 rounded border border-chrome-border bg-chrome px-2 py-1.5 text-xs text-chrome-fg"
        >
          {LOCALES.map(({ code, name }) => <option key={code} value={code} lang={code}>{name}</option>)}
        </select>
      </label>
      {pending && <p role="status" className="mt-1 text-xs text-chrome-fg-muted">{translateSource("언어를 불러오는 중…")}</p>}
      {failed && <p role="alert" className="mt-1 text-xs text-negative-text">{translateSource("언어를 불러오지 못했습니다. 다시 선택해 주세요.")}</p>}
    </div>
  );
}
