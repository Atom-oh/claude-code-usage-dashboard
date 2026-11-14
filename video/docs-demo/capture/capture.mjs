// Capture the current React UI with synthetic responses and translated display labels.
// Start dashboard/web's Vite server first. No production navigation or model calls.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { apiResponse, from, to, task } from "./fixtures.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(path.join(root, "dashboard/web/package.json"));
const { chromium } = require("playwright");
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const collect = args.includes("--collect");
const labels = collect ? {} : JSON.parse(await readFile(new URL("labels.en.json", import.meta.url), "utf8"));
const base = process.env.CCDASH_CAPTURE_URL || "http://127.0.0.1:4178";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname), "Capture only a local fixture server");
const output = path.join(root, "site/assets/img");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"],
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 },
  deviceScaleFactor: 2, timezoneId: "UTC", locale: "en-US" });
const page = await context.newPage();
page.setDefaultTimeout(10000);
await page.clock.setFixedTime(new Date("2026-11-14T12:00:00.000Z"));
const errors = [], strings = new Set(), evidence = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json",
  body: JSON.stringify(apiResponse(new URL(route.request().url()))) }));
const query = `client=claude&from=${from}&to=${to}&rangeMode=time`;
const card = (title) => page.getByText(title, { exact: true }).locator('xpath=ancestor::div[contains(@class,"shadow-card")]').first();

async function capture(name, locator) {
  await locator.scrollIntoViewIfNeeded();
  const words = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const values = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement.closest("script,style") && /[가-힣]/.test(node.textContent)) values.push(node.textContent.trim());
    }
    return [...new Set(values)];
  });
  words.forEach((word) => strings.add(word));
  console.log(`${collect ? "Collecting labels" : "Capturing"}: ${name}`);
  if (collect) return;
  const missing = words.filter((word) => !labels[word]);
  assert.deepEqual(missing, [], `Missing English labels for ${name}`);
  const element = await locator.elementHandle();
  await page.evaluate((mapping) => {
    window.__captureText = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, original = node.textContent, key = original.trim();
      if (mapping[key] && !node.parentElement.closest("script,style")) {
        window.__captureText.push([node, original]);
        node.textContent = original.replace(key, mapping[key]);
      }
    }
  }, labels);
  try {
    await page.evaluate(() => document.fonts.ready);
    await element.screenshot({ path: path.join(output, name), animations: "disabled" });
    const png = await readFile(path.join(output, name));
    evidence.push({ name, width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
  } finally {
    await page.evaluate(() => { for (const [node, original] of window.__captureText) node.textContent = original; });
  }
}

try {
  await page.goto(`${base}/users?${query}`);
  await page.getByRole("button", { name: "al******@example.test", exact: true }).click();
  await page.getByText("작업 목록 · 상위 20개", { exact: true }).waitFor();
  await page.getByRole("button", { name: "기간 직접 선택" }).click();
  await page.getByLabel("시작 시각").fill("2026-11-12T10:15:30");
  await page.getByLabel("종료 시각").fill("2026-11-13T18:45");
  await capture("time-range-en.png", page.getByLabel("종료 시각")
    .locator('xpath=ancestor::div[contains(@class,"shadow-card")]').first());
  await page.getByRole("button", { name: "취소", exact: true }).click();
  const trend = card("사용량·비용 추이").locator(".recharts-wrapper").first();
  await trend.scrollIntoViewIfNeeded();
  const plot = await trend.locator(".recharts-cartesian-grid-horizontal line").first().evaluate((line) => {
    const rect = line.ownerSVGElement.getBoundingClientRect();
    return { left: rect.left + Number(line.getAttribute("x1")), right: rect.left + Number(line.getAttribute("x2")), top: rect.top };
  });
  await page.mouse.move(plot.left + (plot.right - plot.left) * .45, plot.top + 50);
  await page.mouse.down();
  await page.mouse.move(plot.left + (plot.right - plot.left) * .8, plot.top + 50, { steps: 10 });
  const taskResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/users/tasks" && url.searchParams.get("from") !== from;
  });
  await page.mouse.up();
  const requested = new URL((await taskResponse).url()), selected = new URL(page.url());
  assert.equal(requested.searchParams.get("from"), selected.searchParams.get("from"));
  assert.equal(requested.searchParams.get("to"), selected.searchParams.get("to"));
  await page.getByText("작업 목록 · 상위 20개", { exact: true }).waitFor();
  await capture("user-tasks-en.png", card("사용량·비용 추이"));
  await capture("task-list-en.png", card("작업 목록 · 상위 20개"));
  await card("작업 목록 · 상위 20개").getByText(task.models.join(", "), { exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "작업 상세" });
  await page.getByRole("region", { name: "세션 환경" }).waitFor();
  await capture("task-trace-overview-en.png", dialog);
  await capture("task-lanes-en.png", page.locator('svg[aria-label="에이전트 레인 타임라인"]'));
  await capture("task-environment-en.png", page.getByRole("region", { name: "세션 환경" }));
  await page.getByRole("button", { name: /Explore #1.*LLM|LLM.*Explore #1/ }).first().click();
  if (!collect) await dialog.screenshot({ path: path.join(output, "task-trace.png") });
  await capture("task-trace-en.png", dialog);
  await capture("call-detail-en.png", page.getByRole("region", { name: "선택한 span 상세" }));
  const models = page.getByRole("region", { name: "모델별 호출" });
  await models.getByRole("button").filter({ hasText: "claude-haiku-5-5" }).first().click();
  await capture("task-trace-model-en.png", dialog);
  await capture("task-trace-model-table-en.png", models);
  await page.goto(`${base}/productivity?${query}`);
  await card("Claude Code · 단위 비용 추이").waitFor();
  assert.ok(await card("Claude Code · 단위 비용 추이").locator(".chart-gap-connector").count() > 0);
  await capture("unit-cost-en.png", card("Claude Code · 단위 비용 추이"));
  await page.goto(`${base}/collector`);
  await page.getByRole("heading", { name: "터미널에서 설치" }).waitFor();
  await page.getByRole("button", { name: "macOS 선택" }).click();
  await capture("collector-setup-en.png", page.getByRole("heading", { name: "터미널에서 설치" })
    .locator('xpath=ancestor::div[contains(@class,"shadow-card")]').first());
  assert.deepEqual(errors, []);
  if (collect) await writeFile(option("--collect"), JSON.stringify([...strings].sort(), null, 2) + "\n");
  else await writeFile(new URL("evidence.json", import.meta.url), JSON.stringify({ date: "2026-11-14",
    source_revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    drag_and_task_bounds_match: true, browser_errors: errors, screenshots: evidence }, null, 2) + "\n");
  console.log(JSON.stringify({ collected_labels: strings.size, screenshots: evidence.length, browser_errors: errors }));
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(0, 1500));
  throw error;
} finally {
  await context.close();
  await browser.close();
}
