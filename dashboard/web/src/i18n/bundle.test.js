// @vitest-environment node
import { expect, it } from "vitest";
import { build } from "vite";

it("makes every language available from the initially loaded application bundle", async () => {
  const result = await build({ logLevel: "silent", build: { write: false } });
  const outputs = Array.isArray(result) ? result.flatMap((part) => part.output) : result.output;
  const chunks = outputs.filter((part) => part.type === "chunk");
  const initial = new Set();
  const visit = (file) => {
    if (initial.has(file)) return;
    initial.add(file);
    const chunk = chunks.find((part) => part.fileName === file);
    for (const dependency of chunk?.imports || []) visit(dependency);
  };
  chunks.filter((chunk) => chunk.isEntry).forEach((chunk) => visit(chunk.fileName));
  const modules = chunks.filter((chunk) => initial.has(chunk.fileName)).flatMap((chunk) => chunk.moduleIds);
  for (const locale of ["ko", "en", "zh-CN", "ja", "es"]) {
    expect(modules.some((id) => id.endsWith(`/src/i18n/locales/${locale}.json`)), locale).toBe(true);
  }
}, 30_000);
