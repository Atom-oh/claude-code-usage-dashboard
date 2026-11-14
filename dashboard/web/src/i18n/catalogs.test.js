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

it("covers literal bridges, core help constants and server-authored chat status messages", async () => {
  const sources = new Set(Object.values(ko));
  const { SPEND_HELP } = await import("../spend.js");
  const { APPROVAL_HELP } = await import("../score.js");
  const { OBSERVED_TOKEN_HELP } = await import("../clientPresentation.js");
  for (const message of [SPEND_HELP, APPROVAL_HELP, OBSERVED_TOKEN_HELP]) expect(sources.has(message), message).toBe(true);
  const sourceRoot = resolve(process.cwd(), "src");
  for (const name of readdirSync(sourceRoot, { recursive: true })) {
    if (!/\.(js|jsx)$/.test(name) || name.includes(".test.")) continue;
    const source = readFileSync(resolve(sourceRoot, name), "utf8");
    for (const match of source.matchAll(/\btranslateSource\("([^"\\]*)"\)/g)) {
      expect(sources.has(match[1]), `${name}: ${match[1]}`).toBe(true);
    }
  }
  const server = readFileSync(resolve(process.cwd(), "../server/chat.js"), "utf8");
  const statuses = [...server.matchAll(/send\("status", \{ message: "([^"\\]*)"/g)];
  expect(statuses.length).toBeGreaterThan(0);
  for (const [, message] of statuses) expect(sources.has(message), message).toBe(true);
});
