// Capture the real Settings page against read-only synthetic APIs on loopback.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { apiResponse } from "./fixtures.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../dashboard/web/package.json", import.meta.url));
const { chromium } = require("playwright");
const localized = process.argv.includes("--localized");
const base = localized ? "http://127.0.0.1:4178" : "http://127.0.0.1:4185";
const sourceRevision = process.env.DOCS_CAPTURE_SOURCE_REVISION
  || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
assert.match(sourceRevision, /^[0-9a-f]{40}$/, "Capture source revision must be a full commit hash");
execFileSync("git", ["diff", "--quiet", sourceRevision, "--", "dashboard/web/src"], { cwd: root });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const settings = {
  available: true, reason: null, poolId: "ap-northeast-2_Example",
  status: { available: true, lastSync: Date.parse("2026-11-14T11:58:00Z"), lastError: null,
    stale: false, users: 42, historyStart: Date.parse("2026-11-01T00:00:00Z"), reason: null },
  attributes: [{ attribute: "custom:department", from: 0 }],
  current: "custom:department", labels: { platform: "Platform", data: "Data" },
  options: ["custom:department", "custom:team"], directoryError: null, version: 3,
};
const preview = {
  attribute: "custom:department",
  values: [{ value: "platform", users: 18 }, { value: "data", users: 12 }, { value: "operations", users: 8 }],
  missing: 3, excluded: 1,
};
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  headless: true, args: ["--no-sandbox"],
});
const errors = [], checks = [], images = [];
let image;
try {
  for (const width of [1440, 390]) for (const locale of ["en", "zh-CN", "ja", "es", "ko"]) {
    console.log(`Checking Settings ${locale}/${width}`);
    const context = await browser.newContext({
      viewport: { width, height: width === 1440 ? 1100 : 844 }, deviceScaleFactor: 2, timezoneId: "UTC",
    });
    await context.addInitScript((value) => localStorage.setItem("ccdash.locale", value), locale);
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) {
        errors.push("Non-loopback request");
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (request.method() !== "GET") {
        errors.push("Unexpected mutation");
        return route.abort();
      }
      let data;
      if (url.pathname === "/api/settings/display") data = {
        available: true, reason: null,
        teamMask: { deployment: true, override: null, effective: true }, version: null,
      };
      else if (url.pathname === "/api/settings/teams") data = settings;
      else if (url.pathname === "/api/settings/teams/preview") data = preview;
      else {
        data = apiResponse(url);
        if (url.pathname === "/api/config") data.session.permissions.push("settings:manage");
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.setFixedTime(new Date("2026-11-14T12:00:00Z"));
    await page.goto(`${base}/settings`);
    await page.locator('input[placeholder="platform"]').waitFor();
    await page.waitForFunction((value) => document.documentElement.lang === value, locale, { timeout: 10000 }).catch(async (error) => {
      console.log(JSON.stringify(await page.evaluate(() => ({ language: document.documentElement.lang, saved: localStorage.getItem("ccdash.locale"), pickers: [...document.querySelectorAll("select")].map(s => ({ label: s.getAttribute("aria-label"), value: s.value })), text: document.body.innerText.slice(0, 500) }))));
      throw error;
    });
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('input[type="radio"]').count(), 5);
    assert.equal(await page.getByRole("alert").count(), 0);
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
    assert(dimensions.content <= dimensions.viewport + 1, `Overflow at ${locale}/${width}`);
    const text = await page.locator("main").innerText();
    assert(text.length > 200);
    if (locale !== "ko") {
      assert(!/[가-힣]/.test(text), `Korean authored text remains in ${locale}`);
      if (width === 1440) {
        const menu = await page.locator('nav a[href^="/settings"]').innerText();
        assert(!/[가-힣]/.test(menu), `Korean Settings navigation remains in ${locale}`);
      }
    }
    if (width === 1440 && (localized || locale === "en")) {
      const name = localized ? `guide-${locale}-settings.png` : "guide-settings.png";
      const target = new URL(`../../site/assets/img/${name}`, import.meta.url);
      await page.screenshot({ path: fileURLToPath(target), animations: "disabled" });
      const bytes = await readFile(target);
      image = { name, locale, bytes: bytes.length, sha256: sha(bytes),
        width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), pixel_scale: 2 };
      images.push(image);
    }
    checks.push({ locale, width, errors: 0 });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(new URL(localized ? "settings-localized-evidence.json" : "settings-evidence.json", import.meta.url), JSON.stringify({
    source_revision: sourceRevision, fixture_sha256: sha(await readFile(new URL(import.meta.url))),
    privacy: "Synthetic directory values and counts; no live APIs or account data.",
    checks, ...(localized ? { images } : { image }),
  }, null, 2) + "\n");
  console.log(JSON.stringify({ settings_checks: checks.length, ...(localized ? { images } : { image }), errors }));
} finally {
  await browser.close();
}
