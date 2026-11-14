import { Fragment, createElement, useSyncExternalStore } from "react";
import ko from "./locales/ko.json" with { type: "json" };
import { createLocaleStore } from "./store.js";

export const LOCALES = [
  { code: "en", name: "English", tag: "en-US", guide: "" },
  { code: "zh-CN", name: "简体中文", tag: "zh-CN", guide: "zh/" },
  { code: "ja", name: "日本語", tag: "ja-JP", guide: "ja/" },
  { code: "es", name: "Español", tag: "es-ES", guide: "es/" },
  { code: "ko", name: "한국어", tag: "ko-KR", guide: "ko/" },
];

export const localeStore = createLocaleStore({
  source: ko,
  loaders: {
    ko: async () => ko,
    en: () => import("./locales/en.json", { with: { type: "json" } }),
    "zh-CN": () => import("./locales/zh-CN.json", { with: { type: "json" } }),
    ja: () => import("./locales/ja.json", { with: { type: "json" } }),
    es: () => import("./locales/es.json", { with: { type: "json" } }),
  },
  onLocale: (locale) => { if (typeof document !== "undefined") document.documentElement.lang = locale; },
});

export const translate = localeStore.translate;
export const localizedMessage = (key, values = []) => ({ key, values });
export const messageText = (message) => message && typeof message === "object"
  && typeof message.key === "string" && Array.isArray(message.values)
  ? translate(message.key, message.values) : message;
export function richMessage(key, values) {
  return translate(key).split(/(\{\d+\})/g).map((part, index) => {
    const slot = /^\{(\d+)\}$/.exec(part);
    const value = slot && Number(slot[1]) < values.length ? values[Number(slot[1])] : part;
    return createElement(Fragment, { key: index }, value);
  });
}
export const getLocale = localeStore.getLocale;
export const useLocale = () => useSyncExternalStore(localeStore.subscribe, getLocale, () => "ko");
export const useLocaleState = () => useSyncExternalStore(localeStore.subscribe, localeStore.getState, localeStore.getState);
export const localeTag = () => LOCALES.find((item) => item.code === getLocale()).tag;
export const guidePath = () => LOCALES.find((item) => item.code === getLocale()).guide;
export const formatUnit = (value, unit) => new Intl.NumberFormat(localeTag(), {
  style: "unit", unit, unitDisplay: "long", maximumFractionDigits: 0,
}).format(value);

const sourceKeys = new Map(Object.entries(ko).map(([key, value]) => [value, key]));
export const translateSource = (source) => typeof source === "string" && sourceKeys.has(source)
  ? translate(sourceKeys.get(source)) : source;

// Static presentation records (column labels, help, release notes) must resolve on
// access, not once at module initialization. Only authored records opt in here.
// The proxy and nested records retain their identity across language changes.
const records = new WeakMap();
export function localize(record) {
  if (typeof record === "string") return translateSource(record);
  if (!record || typeof record !== "object") return record;
  if (records.has(record)) return records.get(record);
  const proxy = new Proxy(record, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return value && typeof value === "object" ? localize(value) : translateSource(value);
    },
  });
  records.set(record, proxy);
  records.set(proxy, proxy);
  return proxy;
}

// Resolve Intl instances by locale while keeping module-level chart handles stable.
export function localizedFormat(kind, options) {
  const cache = new Map();
  const current = () => {
    const locale = localeTag();
    if (!cache.has(locale)) cache.set(locale, new Intl[kind](locale, options));
    return cache.get(locale);
  };
  return {
    format: (value) => current().format(value),
    formatToParts: (value) => current().formatToParts(value),
    resolvedOptions: () => current().resolvedOptions(),
  };
}
