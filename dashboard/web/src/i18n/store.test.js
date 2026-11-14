import { describe, expect, it, vi } from "vitest";
import { createLocaleStore } from "./store.js";

const ko = { greeting: "안녕하세요 {0}", empty: "미수집" };
const en = { greeting: "Hello {0}", empty: "Not collected" };
const make = (options = {}) => createLocaleStore({
  source: ko,
  loaders: { ko: async () => ko, en: async () => en, es: async () => ({ greeting: "Hola {0}", empty: "Sin recopilar" }) },
  ...options,
});

describe("locale store", () => {
  it("changes authored messages without changing interpolation values", async () => {
    const store = make();
    expect(store.translate("greeting", ["<script>raw</script>"])).toBe("안녕하세요 <script>raw</script>");
    await store.select("en");
    expect(store.translate("greeting", ["도구"])).toBe("Hello 도구");
    expect(store.translate("empty")).toBe("Not collected");
    expect(store.translate("unknown.key")).toBe("unknown.key");
  });

  it("persists only supported locales and tolerates blocked storage", async () => {
    const storage = { getItem: () => "en", setItem: vi.fn(() => { throw new Error("blocked"); }) };
    const store = make({ storage: () => storage });
    await store.initialize();
    expect(store.getLocale()).toBe("en");
    await store.select("es");
    expect(store.getLocale()).toBe("es");
    await expect(store.select("../../unknown")).resolves.toBe(false);
    expect(store.getLocale()).toBe("es");
    expect(storage.setItem).toHaveBeenLastCalledWith("ccdash.locale", "es");
  });

  it("ignores invalid stored preferences", async () => {
    const store = make({ storage: () => ({ getItem: () => "cn" }) });
    await store.initialize();
    expect(store.getLocale()).toBe("ko");
  });

  it("keeps the previous language on a failed load and can retry", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(en);
    const store = make({ loaders: { ko: async () => ko, en: load } });
    expect(await store.select("en")).toBe(false);
    expect(store.getLocale()).toBe("ko");
    expect(store.getState()).toMatchObject({ pending: false, failed: true });
    expect(await store.select("en")).toBe(true);
    expect(store.getState()).toMatchObject({ locale: "en", failed: false });
  });

  it("does not let a slower request overwrite the latest selection", async () => {
    let finish;
    const store = make({ loaders: { ko: async () => ko, en: () => new Promise((r) => { finish = r; }), es: async () => en } });
    const first = store.select("en");
    await store.select("es");
    finish(en);
    await first;
    expect(store.getLocale()).toBe("es");
  });

  it("cancels pending selection when returning to the current language", async () => {
    let finish;
    const store = make({ loaders: { ko: async () => ko, en: () => new Promise((r) => { finish = r; }) } });
    const first = store.select("en");
    await store.select("ko");
    finish(en);
    await first;
    expect(store.getState()).toMatchObject({ locale: "ko", requested: "ko", pending: false });
  });

  it("rejects incomplete or malformed catalogs instead of mixing languages", async () => {
    const store = make({ loaders: { ko: async () => ko, en: async () => ({ greeting: "Hello" }) } });
    expect(await store.select("en")).toBe(false);
    expect(store.getLocale()).toBe("ko");
  });
});
