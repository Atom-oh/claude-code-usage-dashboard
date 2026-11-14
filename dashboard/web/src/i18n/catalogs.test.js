import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ko from "./locales/ko.json";
import en from "./locales/en.json";
import zh from "./locales/zh-CN.json";
import ja from "./locales/ja.json";
import es from "./locales/es.json";

const slots = (value) => (value.match(/\{\d+\}/g) || []).sort();

it("keeps stable source identities and resolves every authored message reference", () => {
  for (const [key, value] of Object.entries(ko)) {
    expect(key).toBe("m" + createHash("sha256").update(value).digest("hex").slice(0, 12));
  }
  const sourceRoot = resolve(process.cwd(), "src");
  for (const name of readdirSync(sourceRoot, { recursive: true })) {
    if (!/\.(js|jsx)$/.test(name) || name.includes(".test.") || name.startsWith("test/")) continue;
    const source = readFileSync(resolve(sourceRoot, name), "utf8");
    for (const match of source.matchAll(/\b(?:translate|richMessage|localizedMessage)\(["'](m[0-9a-f]{12})["']/g)) {
      expect(Object.hasOwn(ko, match[1]), `${name}: ${match[1]}`).toBe(true);
    }
  }
});

it.each([["en", en], ["zh-CN", zh], ["ja", ja], ["es", es]])(
  "%s has every source message and exactly the original interpolation slots",
  (_locale, catalog) => {
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(ko).sort());
    for (const [key, source] of Object.entries(ko)) {
      expect(typeof catalog[key], key).toBe("string");
      expect(catalog[key].trim(), key).not.toBe("");
      expect(slots(catalog[key]), key).toEqual(slots(source));
    }
  },
);
