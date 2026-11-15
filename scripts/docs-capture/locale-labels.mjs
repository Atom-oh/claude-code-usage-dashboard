import ko from "../../dashboard/web/src/i18n/locales/ko.json" with { type: "json" };
import en from "../../dashboard/web/src/i18n/locales/en.json" with { type: "json" };
import ja from "../../dashboard/web/src/i18n/locales/ja.json" with { type: "json" };
import zh from "../../dashboard/web/src/i18n/locales/zh-CN.json" with { type: "json" };
import es from "../../dashboard/web/src/i18n/locales/es.json" with { type: "json" };

const catalogs = { ko, en, ja, "zh-CN": zh, es };
const sourceKeys = new Map(Object.entries(ko).map(([key, value]) => [value, key]));
export const supportedLocales = Object.keys(catalogs);

export function message(key, locale, values = []) {
  if (!Object.hasOwn(catalogs, locale)) throw new Error(`Unsupported locale: ${locale}`);
  const text = catalogs[locale][key];
  if (typeof text !== "string") throw new Error(`Unknown message: ${key}`);
  return text.replace(/\{(\d+)\}/g, (part, index) => index < values.length ? String(values[index]) : part);
}

export function label(source, locale) {
  if (!Object.hasOwn(catalogs, locale)) throw new Error(`Unsupported locale: ${locale}`);
  const key = sourceKeys.get(source);
  if (!key) throw new Error(`Unknown source label: ${source}`);
  return message(key, locale);
}
