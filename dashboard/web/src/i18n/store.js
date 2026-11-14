// The store contains presentation preferences only. It never changes URL or API state.
export const STORAGE_KEY = "ccdash.locale";
const placeholders = (text) => (text.match(/\{\d+\}/g) || []).sort().join(",");

export function createLocaleStore({ source, loaders, storage = () => globalThis.localStorage, onLocale = () => {} }) {
  let state = { locale: "ko", requested: "ko", pending: false, failed: false };
  let generation = 0;
  const listeners = new Set();
  const catalogs = new Map([["ko", source]]);
  const keys = Object.keys(source);
  const emit = (next) => {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  };
  const supported = (locale) => Object.hasOwn(loaders, locale);
  const persist = (locale) => {
    try { storage()?.setItem(STORAGE_KEY, locale); } catch { /* Storage is optional. */ }
  };
  const valid = (catalog) => catalog && Object.keys(catalog).length === keys.length
    && keys.every((key) => typeof catalog[key] === "string" && catalog[key].trim()
      && placeholders(catalog[key]) === placeholders(source[key]));

  const select = async (locale) => {
    if (!supported(locale)) return false;
    const ticket = ++generation;
    if (locale === state.locale) {
      persist(locale);
      emit({ requested: locale, pending: false, failed: false });
      return true;
    }
    emit({ requested: locale, pending: true, failed: false });
    try {
      if (!catalogs.has(locale)) {
        const loaded = await loaders[locale]();
        const catalog = loaded.default || loaded;
        if (!valid(catalog)) throw new Error("Invalid language catalog");
        catalogs.set(locale, catalog);
      }
      if (ticket !== generation) return false;
      persist(locale);
      onLocale(locale);
      emit({ locale, requested: locale, pending: false, failed: false });
      return true;
    } catch {
      if (ticket === generation) emit({ requested: state.locale, pending: false, failed: true });
      return false;
    }
  };

  return {
    getLocale: () => state.locale,
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    select,
    initialize: async () => {
      let saved;
      try { saved = storage()?.getItem(STORAGE_KEY); } catch { /* Use the Korean default. */ }
      if (supported(saved)) await select(saved);
      onLocale(state.locale);
    },
    translate: (key, values = []) => {
      const catalog = catalogs.get(state.locale);
      const message = catalog && Object.hasOwn(catalog, key) ? catalog[key]
        : Object.hasOwn(source, key) ? source[key] : key;
      // Interpolated values are opaque. Do not translate or interpret telemetry/user text.
      return message.replace(/\{(\d+)\}/g, (match, index) =>
        index < values.length ? String(values[index] ?? "") : match);
    },
  };
}
