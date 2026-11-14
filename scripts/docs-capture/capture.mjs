// Local React capture only. No DOM translations, injected labels, styling, or live APIs.
// Run: node scripts/docs-capture/capture.mjs [--only overview,task-call,tools]
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { apiResponse, from, to, task, validateFixtures } from "./fixtures.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "dashboard/web/package.json"));
const { chromium } = require("playwright");
const args = process.argv.slice(2), onlyAt = args.indexOf("--only");
assert.ok(onlyAt < 0 || args[onlyAt + 1], "--only needs comma-separated capture names");
const only = onlyAt < 0 ? null : new Set(args[onlyAt + 1].split(",").map((n) => n.replace(/^guide-/, "").replace(/\.png$/, "")));
const base = "http://127.0.0.1:4178";
const output = path.join(root, "site/assets/img");
const evidencePath = new URL("evidence.json", import.meta.url);
const viewport = { width: 1440, height: 1000 }, scale = 2;
const fixedTime = "2026-11-14T12:00:00.000Z";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sha = (data) => createHash("sha256").update(data).digest("hex");
const sourceFiles = (await readdir(path.join(root, "dashboard/web/src"), { recursive: true, withFileTypes: true }))
  .filter((d) => d.isFile()).map((d) => path.join(d.parentPath, d.name)).sort();
const sourceHash = sha((await Promise.all(sourceFiles.map(async (p) => `${path.relative(root, p)}:${sha(await readFile(p))}`))).join("\n"));
const fixtureHash = sha(await readFile(new URL("fixtures.mjs", import.meta.url)));
const consistency = validateFixtures();
const errors = [], consoleErrors = [], unexpectedRequests = [], requests = [], screenshots = [];
let completed = false;
const wanted = (name) => !only || only.has(name);
const query = new URLSearchParams({ client: "claude", from, to, rangeMode: "time" }).toString();
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
let context, page;
try {
  context = await browser.newContext({ viewport, deviceScaleFactor: scale, timezoneId: "UTC", locale: "ko-KR" });
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.clock.setFixedTime(new Date(fixedTime));
  page.on("pageerror", (e) => errors.push({ url: page.url(), message: e.message }));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push({ url: page.url(), message: m.text() }); });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) {
      unexpectedRequests.push(request.url());
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    requests.push({ url: url.href, method: request.method() });
    try {
      assert.equal(request.method(), "GET", "Guide captures only read fixture APIs");
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(apiResponse(url)) });
    } catch (error) {
      errors.push({ url: url.href, message: error.message });
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: error.message }) });
    }
  });
  const card = (title) => page.getByText(title, { exact: true })
    .locator('xpath=ancestor::div[contains(@class,"shadow-card")]').first();
  async function settled() {
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(350);
  }
  async function goto(route, detail = false) {
    await page.goto(`${base}${route}?${query}${detail ? "&view=detail" : ""}`);
    await settled();
  }
  async function capture(name, locator = null, notes = "") {
    if (!wanted(name)) return;
    await settled();
    await page.mouse.move(5, 5);
    const text = await (locator || page.locator("main")).innerText();
    assert.ok(text.trim().length > 80, `${name} has no useful content`);
    assert.ok(!text.includes("NaN") && !text.includes("Infinity"), `${name} invalid numeric output`);
    assert.equal(await page.getByRole("alert").count(), 0, `${name} contains an error alert`);
    const target = path.join(output, `guide-${name}.png`);
    let clip = null;
    if (locator) {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      assert.ok(box && box.width > 200 && box.height > 80, `${name} empty crop`);
      assert.ok(box.height <= 1050, `${name} crop too tall (${box.height})`);
      await locator.screenshot({ path: target, animations: "disabled" });
      clip = box;
    } else {
      await page.screenshot({ path: target, animations: "disabled" });
    }
    const bytes = await readFile(target), width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    assert.ok(bytes.length > 15000, `${name} PNG suspiciously small`);
    screenshots.push({ name: path.basename(target), url: page.url(), viewport, device_scale_factor: scale,
      dimensions: { width, height }, clip_css_pixels: clip, bytes: bytes.length, sha256: sha(bytes),
      source_revision: sourceRevision, source_tree_sha256: sourceHash, fixture_sha256: fixtureHash,
      browser_errors: [...errors], console_errors: [...consoleErrors], notes });
    console.log(`Captured guide-${name}.png (${width}×${height})`);
  }
  async function scrollTo(locator, margin = 24) {
    await locator.evaluate((node, offset) => {
      let scroller = node.parentElement;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight
        && ["auto", "scroll"].includes(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      if (scroller) scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
      else window.scrollTo(0, window.scrollY + node.getBoundingClientRect().top - offset);
    }, margin);
    await page.waitForTimeout(250);
  }
  // Capture a contiguous section of the real page, without rearranging elements.
  async function captureRange(name, first, last, notes = "") {
    if (!wanted(name)) return;
    await scrollTo(first);
    await settled();
    assert.equal(await page.getByRole("alert").count(), 0, `${name} contains an error alert`);
    const content = `${await first.innerText()}\n${await last.innerText()}`;
    assert.ok(content.length > 80 && !/NaN|Infinity/.test(content), `${name} invalid content`);
    const a = await first.boundingBox(), b = await last.boundingBox();
    const clip = { x: Math.min(a.x, b.x), y: a.y,
      width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x), height: b.y + b.height - a.y };
    assert.ok(clip.height <= viewport.height && clip.y >= 0 && clip.y + clip.height <= viewport.height + 1,
      `${name}: contiguous section does not fit viewport (${JSON.stringify(clip)})`);
    const target = path.join(output, `guide-${name}.png`);
    await page.mouse.move(5, 5);
    await page.screenshot({ path: target, clip, animations: "disabled" });
    const bytes = await readFile(target);
    assert.ok(bytes.length > 15000, `${name} PNG suspiciously small`);
    screenshots.push({ name: path.basename(target), url: page.url(), viewport, device_scale_factor: scale,
      dimensions: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }, clip_css_pixels: clip,
      bytes: bytes.length, sha256: sha(bytes), source_revision: sourceRevision, source_tree_sha256: sourceHash,
      fixture_sha256: fixtureHash, browser_errors: [...errors], console_errors: [...consoleErrors], notes });
    console.log(`Captured guide-${name}.png`);
  }
  for (const [name, route] of [["overview", "/"], ["executive", "/exec"], ["trends", "/trends"],
    ["reliability", "/reliability"], ["analytics", "/analytics"]]) {
    if (!wanted(name)) continue;
    await goto(route);
    await capture(name, null, name === "analytics" ? "Model diagnostics. SQL chat is outside this synthetic permission scope." : "");
  }
  if (wanted("overview-trend")) {
    await goto("/");
    await capture("overview-trend", card("사용량·비용 추이"), "Full trend companion to the overview's global-controls viewport.");
  }
  if (wanted("executive-charts")) {
    await goto("/exec");
    await capture("executive-charts", card("Claude Code 모델별 비용 추이"),
      "Full chart companion to Executive; current fixed two-day window.");
  }
  if (wanted("trends-charts")) {
    await goto("/trends");
    await captureRange("trends-charts", card("토큰 추이"), card("비용 추이"),
      "Full token/cost charts accompanying the Trends global-controls viewport.");
  }
  if (["users", "user-detail", "task-list", "task-trace", "task-call", "task-call-reported", "task-context"].some(wanted)) {
    await goto("/users");
    await scrollTo(card("사용자별 사용량"));
    await capture("users", card("사용자별 사용량"), "Select the masked Alice example.test identity to open detail.");
    await page.getByRole("button", { name: "al******@example.test", exact: true }).click();
    await page.getByText("작업 목록 · 상위 20개", { exact: true }).waitFor();
    await settled();
    const detailSection = page.getByRole("region", { name: "사용자 상세", exact: true });
    await captureRange("user-detail", detailSection.locator("h2"), card("사용량·비용 추이"), "All endpoints filter to Alice.");
    await capture("task-list", card("작업 목록 · 상위 20개"), "Partially observed task subset; costs and calls reconcile.");
    if (["task-trace", "task-call", "task-call-reported", "task-context"].some(wanted)) {
      await card("작업 목록 · 상위 20개").getByText(task.models.join(", "), { exact: true }).first().click();
      await page.getByRole("region", { name: "세션 환경" }).waitFor();
      const dialog = page.getByRole("dialog", { name: "작업 상세" });
      assert.equal(await dialog.getByRole("group", { name: "Explore #1 레인", exact: true }).count(), 1);
      assert.equal(await dialog.getByRole("group", { name: "Explore #2 레인", exact: true }).count(), 1);
      await capture("task-trace", null, "Interaction KPIs, separately numbered Explore lanes and context.");
      await page.getByRole("button", { name: /Explore #1.*LLM|LLM.*Explore #1/ }).first().click();
      const panel = page.getByRole("region", { name: "선택한 span 상세" });
      assert.equal(await panel.getByText("시도", { exact: true }).evaluate((node) => node.nextElementSibling.textContent), "미수집");
      await panel.getByText("계산 추정", { exact: true }).waitFor();
      await capture("task-call", page.getByRole("region", { name: "선택한 span 상세" }),
        "Computed cost uses the fictional fixture prices. Attempt and TTFT remain uncollected.");
      if (wanted("task-context")) {
        await captureRange("task-context", page.getByRole("region", { name: "왜 많이 썼나", exact: true }),
          page.getByRole("region", { name: "모델별 호출", exact: true }),
          "Real context chart and model explanation within the trace dialog.");
      }
      if (wanted("task-call-reported")) {
        await page.getByRole("button", { name: /메인 세션.*LLM|LLM.*메인 세션/ }).first().click();
        await panel.getByText("클라이언트 보고", { exact: true }).waitFor();
        await capture("task-call-reported", panel, "Reported-cost main call, with measured attempt 1 and TTFT.");
      }
      await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    }
  }
  if (wanted("cost") || wanted("cost-summary")) {
    await goto("/cost");
    await capture("cost-summary", null, "Model and Effort shares, input/cache composition. Computed fallback is excluded from Effort.");
    await captureRange("cost", card("모델별 비용"), card("사용자별 비용"), "Model and user costs from the same synthetic ledger.");
  }
  if (wanted("economics") || wanted("unit-cost")) {
    await goto("/productivity");
    await page.getByRole("group", { name: "Claude Code 비용 방정식" }).waitFor();
    await captureRange("economics", card("비용 방정식"), card("Claude Code 드라이버 분해"),
      "Exact current/previous equations and LMDI contributions; all 48 synthetic sessions matched.");
    await capture("unit-cost", card("Claude Code · 단위 비용 추이"));
  }
  if (wanted("usage")) {
    await goto("/usage");
    await captureRange("usage", card("클라이언트별 토큰 구성"), card("도구 사용"), "Shared Usage token components and tool results.");
  }
  if (["tools", "mcp", "skills", "plugins"].some(wanted)) {
    await goto("/usage", true);
    await captureRange("tools", card("Tool / MCP 사용 현황 — bedrock"), card("도구 권한 결정 — bedrock"));
    await captureRange("mcp", card("MCP 커넥터 사용 현황 — bedrock"), card("MCP 연결 상태"));
    await captureRange("skills", card("Skill 사용 분포 — bedrock"), card("Skill 발동 방식 — bedrock"),
      "Skill attribution is reported spend, not additive to shared costs.");
    await capture("plugins", card("플러그인 목록"), "Synthetic plugin names and reserved example.test marketplace.");
  }
  if (wanted("collector") || wanted("collector-devices")) {
    await goto("/collector");
    await page.getByRole("button", { name: "macOS 선택" }).click();
    await capture("collector", card("터미널에서 설치"), "Reserved example.test installer URL. No token issued or command executed.");
    await capture("collector-devices", card("내 기기"));
  }
  if (wanted("installation")) {
    await goto("/installation");
    await capture("installation", null, "Synthetic installation status, explicitly fictional release version.");
  }
  assert.deepEqual(errors, [], "Browser or fixture errors");
  assert.deepEqual(consoleErrors, [], "Browser console errors");
  assert.deepEqual(unexpectedRequests, [], "Unexpected network requests");
  if (only) assert.deepEqual([...only].sort(), screenshots.map((s) => s.name.replace(/^guide-/, "").replace(/\.png$/, "")).sort(), "Unknown --only capture name");
  const imageChecks = JSON.parse(execFileSync("python3", ["-c", `
import json, sys
from PIL import Image, ImageStat
checks = {}
for filename in json.loads(sys.argv[1]):
    image = Image.open(filename)
    image.load()
    gray = image.convert("L")
    deviation = ImageStat.Stat(gray).stddev[0]
    dark_fraction = sum(gray.histogram()[:180]) / (image.width * image.height)
    assert deviation > 12 and dark_fraction > .004, "Blank image: " + filename
    checks[filename.rsplit("/", 1)[-1]] = {
        "decoded": True, "grayscale_stddev": round(deviation, 3),
        "dark_pixel_fraction": round(dark_fraction, 5), "nonblank": True
    }
print(json.dumps(checks))
`, JSON.stringify(screenshots.map((s) => path.join(output, s.name)))], { encoding: "utf8" }));
  screenshots.forEach((s) => { s.image_validation = imageChecks[s.name]; });
  completed = true;
} finally {
  await context?.close();
  await browser.close();
  let prior = {};
  if (only) {
    try { prior = JSON.parse(await readFile(evidencePath, "utf8")); } catch {}
  }
  const merged = [...(prior.screenshots || []).filter((s) => !screenshots.some((n) => n.name === s.name)), ...screenshots]
    .sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(evidencePath, JSON.stringify({
    captured_at_fixed: fixedTime, source_revision: sourceRevision, source_tree_sha256: sourceHash,
    capture_script_sha256: sha(await readFile(fileURLToPath(import.meta.url))), fixture_sha256: fixtureHash,
    base_url: base, viewport, device_scale_factor: scale, timezone: "UTC", locale: "ko-KR",
    range: { from, to }, browser_version: browser.version(), browser_executable_name: path.basename(executablePath),
    data_provenance: "Entirely synthetic fixed responses. Reserved example.test identities. Fictional prices; no vendor-price or invoice claim.",
    rendering: "Unmodified React DOM, Korean UI and English technical menus; application font rendering; no downloaded assets.",
    browser_errors: errors, console_errors: consoleErrors, unexpected_requests: unexpectedRequests,
    consistency_checks: consistency,
    api_requests: { scope: "This capture execution; each screenshot retains its page URL.", count: requests.length, paths: [...new Set(requests.map((r) => new URL(r.url).pathname))].sort() },
    screenshots: merged, browser_closed: !browser.isConnected(),
    completed, unavailable_views: ["SQL chat/model responses and code-outcome metrics are not captured."],
  }) + "\n");
}
