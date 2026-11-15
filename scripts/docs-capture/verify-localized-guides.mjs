// Run against a hydrated site served on http://127.0.0.1:48760.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(new URL("../../dashboard/web/package.json", import.meta.url));
const { chromium } = require("playwright");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ["--no-sandbox"],
});
const base = "http://127.0.0.1:48760/";
const locales = [["en", ""], ["ko", "ko/"], ["ja", "ja/"], ["zh-CN", "zh/"], ["es", "es/"]];
const names = ["index", "user-guide", "installation", "architecture", "api", "operations", "credits"];
const route = (locale, prefix, name) => locale === "en" && name === "credits"
  ? "assets/credits.html" : `${prefix}${name}.html`;
const siteRoot = fileURLToPath(new URL("../../site/", import.meta.url));
const errors = [];
let pages = 0, viewers = 0, videos = 0;
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    for (const [locale, prefix] of locales) for (const name of names) {
      console.log(`Checking ${locale} ${name} ${width}`);
      const response = await page.goto(base + route(locale, prefix, name), { waitUntil: "load" });
      assert.equal(response.status(), 200);
      assert.equal(await page.locator("html").getAttribute("lang"), locale);
      assert.equal(await page.locator('link[rel="alternate"][hreflang]').count(), 5);
      assert.equal(await page.locator(".languages a").count(), 4);
      if (["index", "user-guide", "architecture"].includes(name)) {
        await page.evaluate(() => document.querySelectorAll("img").forEach((img) => { img.loading = "eager"; }));
        await page.waitForFunction(() => [...document.images].filter((img) => img.getAttribute("src"))
          .every((img) => img.complete && img.naturalWidth > 0), null, { timeout: 40_000 });
      }
      const widthState = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth,
      }));
      assert.ok(widthState.content <= widthState.viewport + 1,
        `${locale}/${name} at ${width}: ${JSON.stringify(widthState)}`);
      if (name === "user-guide") {
        if (width === 390) {
          const contents = page.locator(".manual-nav");
          assert.equal(await contents.getAttribute("open"), null);
          await contents.locator("summary").click();
          assert.notEqual(await contents.getAttribute("open"), null);
        }
        const link = page.locator("a[data-lightbox]").first();
        await link.scrollIntoViewIfNeeded();
        const expected = await link.getAttribute("href");
        await link.click();
        const dialog = page.locator("dialog.image-viewer");
        await dialog.waitFor({ state: "visible" });
        assert.equal(await dialog.locator("img").getAttribute("src"), new URL(expected, page.url()).href);
        assert.ok(expected.includes(`guide-${locale}-`));
        await dialog.locator("button").first().click();
        assert.equal(await dialog.getAttribute("data-zoomed"), "true");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        assert.equal(await link.evaluate((node) => document.activeElement === node), true);
        viewers++;
      }
      if (name === "index") {
        const video = page.locator("video#product-tour");
        assert.equal(await video.count(), 1);
        assert.equal(await video.locator("track").count(), 2);
        const track = await video.locator('track[srclang="en"]').getAttribute("src");
        const captions = await (await page.request.get(new URL(track, page.url()).href)).text();
        assert.ok(captions.startsWith("WEBVTT"));
        const playback = await video.evaluate(async (element) => {
          element.muted = true;
          await element.play();
          await new Promise((resolve) => setTimeout(resolve, 300));
          const result = { playing: !element.paused, time: element.currentTime };
          element.pause();
          return result;
        });
        assert.ok(playback.playing && playback.time > 0, JSON.stringify(playback));
        videos++;
      }
      pages++;
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  const htmlPaths = locales.flatMap(([locale, prefix]) => names.map((name) => route(locale, prefix, name))).sort();
  const htmlRecords = await Promise.all(htmlPaths.map(async (name) => {
    const bytes = await readFile(path.join(siteRoot, name));
    return `${name}:${createHash("sha256").update(bytes).digest("hex")}`;
  }));
  const output = {
    pages, viewers, videos, browserVersion: browser.version(),
    scriptSha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),
    siteHtmlSha256: createHash("sha256").update(htmlRecords.join("\n")).digest("hex"), errors,
  };
  await writeFile(new URL("localized-browser-evidence.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify(output));
} finally {
  await browser.close();
}
