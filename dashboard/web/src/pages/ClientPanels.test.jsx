import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RangeProvider } from "../RangeContext.jsx";
import { ConfigProvider } from "../ConfigContext.jsx";
import { setPiiMask } from "../fmt.js";
import { clientOverview, codexUsage } from "../test/clientOverview.js";
import * as csv from "../csv.js";
import ClientPanels from "./ClientPanels.jsx";

class ResizeObserverStub {
  constructor(callback) { this.callback = callback; }
  observe(target) { this.callback([{ contentRect: target.getBoundingClientRect() }]); }
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300, x: 0, y: 0,
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setPiiMask(true);
});

function fixture(clients) {
  const rows = clients.map((client) => ({
    ...codexUsage, client, cost_basis: client === "claude" ? "client_reported" : "aws_list_estimate",
    reasoning_tokens: client === "claude" ? null : 15,
  }));
  return clientOverview({
    clients, by_client: rows, by_model: rows, by_user: rows.map((r) => ({ ...r, user: "alice@example.test" })),
    totals: clients.length === 1 ? { ...rows[0], users: null } : {
      ...rows[0], tokens: 540, input_tokens: 196, cache_read_tokens: 200, cache_write_tokens: 44,
      output_tokens: 100, reasoning_tokens: null, cost_usd: 0.008481, sessions: 2, users: null,
    },
    timeseries: rows.flatMap((r) => [
      { ...r, t: "2026-09-01T00:00:00.000Z" }, { ...r, t: "2026-09-01T01:00:00.000Z" },
    ]),
    tools: clients.map((client) => ({ client, tool: "shell", calls: 1, errors: 0, duration_ms: 80 })),
  });
}
function mount(page, data = fixture(["claude", "codex"]), clients = data.clients, piiMask = true) {
  setPiiMask(piiMask);
  return render(
    <MemoryRouter><ConfigProvider config={{ piiMask }}>
      <RangeProvider><ClientPanels page={page} data={data} clients={clients} /></RangeProvider>
    </ConfigProvider></MemoryRouter>,
  );
}
const card = (title) => screen.getByText(title, { exact: true }).closest(".shadow-card");
const tile = (label) => screen.getByText(label, { selector: "span.truncate" }).parentElement.parentElement;
const routes = [
  ["overview", "사용량·비용 추이", "모델별 사용량"],
  ["exec", "활동 단위별 비용", "모델별 비용·활동"],
  ["trends", "토큰 추이", "기간별 관측값"],
  ["productivity", "캐시·추론 비중", "모델별 관측 효율"],
  ["usage", "토큰 구성", "도구 사용"],
  ["users", "사용자별 사용량", "사용자당 세션"],
  ["cost", "모델별 비용", "사용자별 비용"],
  ["reliability", "요청·오류·응답 시간", "도구 신뢰성"],
  ["analytics", "모델·백엔드 진단", "관측 신호 범위"],
];

test.each(routes)("route %s has relevant, bounded content for each client selection", async (page, first, second) => {
  const signatures = [];
  for (const clients of [["claude", "codex"], ["claude"], ["codex"]]) {
    const { container, unmount } = mount(page, fixture(clients));
    expect(screen.getByText(first, { exact: true })).toBeTruthy();
    expect(screen.getAllByText(second, { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "클라이언트 비교" })).toBeTruthy();
    const headers = [...container.querySelectorAll("th")].map((h) => h.textContent);
    signatures.push(headers);
    await waitFor(() => expect(container.querySelector('.recharts-wrapper, svg circle[stroke-width="6"]')).not.toBeNull());
    expect(container.querySelectorAll("table").length).toBeLessThanOrEqual(4);
    expect(container.textContent).not.toMatch(/직원 ROI|절약 시간|커밋당|LOC/);
    if (!clients.includes("claude")) expect(container.textContent).not.toContain("Claude Code");
    if (!clients.includes("codex")) expect(container.textContent).not.toContain("Codex");
    unmount();
  }
  expect(signatures[1]).toEqual(signatures[0]);
  expect(signatures[2]).toEqual(signatures[0]);
});

test("overview uses server totals, visible per-client basis and tiny positive dollars", () => {
  mount("overview", fixture(["codex"]));
  expect(tile("비용 (USD)").textContent).toContain("$0.0042405");
  expect(tile("전체 토큰").textContent).toContain("270");
  expect(tile("관측 사용자 ID").textContent).toContain("—");
  const comparison = screen.getByRole("region", { name: "클라이언트 비교" });
  expect(comparison.textContent).toContain("AWS 정가 추정");
  expect(comparison.textContent).toContain("$0.0042405");
});

test("isolated observed values remain visible and long gaps keep their elapsed-time width", async () => {
  const data = fixture(["claude", "codex"]);
  data.effective_range = { from: "2026-09-01T00:00:00Z", to: "2026-09-01T12:00:00Z" };
  data.bucket_hours = 1;
  data.timeseries = [
    { client: "codex", t: "2026-09-01T00:00:00Z", tokens: 10, cost_usd: 1 },
    { client: "claude", t: "2026-09-01T01:00:00Z", tokens: 20, cost_usd: 2 },
    { client: "codex", t: "2026-09-01T02:00:00Z", tokens: 30, cost_usd: 3 },
    { client: "claude", t: "2026-09-01T03:00:00Z", tokens: 40, cost_usd: 4 },
    { client: "codex", t: "2026-09-01T10:00:00Z", tokens: 50, cost_usd: 5 },
  ];
  mount("overview", data);
  const charts = card("사용량·비용 추이").querySelectorAll(".recharts-wrapper");
  expect(charts).toHaveLength(2);
  for (const chart of charts) {
    const codex = chart.querySelectorAll(".recharts-line")[1];
    await waitFor(() => expect(codex.querySelectorAll(".recharts-line-dot")).toHaveLength(3));
    const x = [...codex.querySelectorAll(".recharts-line-dot")].map(dot => Number(dot.getAttribute("cx")));
    // Two hours followed by eight hours: category spacing would compress this.
    expect((x[2] - x[1]) / (x[1] - x[0])).toBeCloseTo(4, 5);
  }
});

test("a lone measured zero is visible while unknown values have no marker", async () => {
  const data = fixture(["claude", "codex"]);
  data.effective_range = { from: "2026-09-01T00:00:00Z", to: "2026-09-01T04:00:00Z" };
  data.timeseries = [
    { client: "codex", t: "2026-09-01T01:00:00Z", tokens: 0, cost_usd: 0 },
    { client: "claude", t: "2026-09-01T01:00:00Z", tokens: null, cost_usd: null },
  ];
  mount("overview", data);
  const charts = card("사용량·비용 추이").querySelectorAll(".recharts-wrapper");
  for (const chart of charts) {
    await waitFor(() => expect(chart.querySelectorAll(".recharts-line-dot")).toHaveLength(1));
    const dot = chart.querySelector(".recharts-line-dot");
    expect(Number.isFinite(Number(dot.getAttribute("cx")))).toBe(true);
    expect(Number.isFinite(Number(dot.getAttribute("cy")))).toBe(true);
  }
});

test("mixed-client totals, cards and chart legends label only known-cost subtotals", () => {
  const data = fixture(["claude", "codex"]);
  data.by_client[1] = { ...data.by_client[1], cost_usd: null, cost_partial: true, unpriced: 2 };
  data.totals = { ...data.totals, cost_usd: codexUsage.cost_usd, cost_partial: true, unpriced: 2 };
  mount("overview", data);
  expect(tile("비용 (USD)").textContent).toContain("$0.0042405");
  expect(tile("비용 (USD)").textContent).toContain("클라이언트 보고 + AWS 정가 추정 · 부분합 · 미산정 2건 제외");
  const comparison = screen.getByRole("region", { name: "클라이언트 비교" });
  expect(within(comparison).getByText("Codex").closest(".shadow-card").textContent).toContain("AWS 정가 추정 · 미산정");
  expect(card("사용량·비용 추이").textContent).toContain("AWS 정가 추정 · 미산정");
});

test("cost legends and point tooltips describe partial series without range-wide excluded counts", async () => {
  // Recharts also needs a layout width to convert pointer coordinates in jsdom.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  const data = fixture(["claude", "codex"]);
  data.by_client[1] = { ...data.by_client[1], cost_partial: true, unpriced: 2 };
  mount("cost", data);
  const chart = card("비용 추이");
  const label = "Codex 비용 (USD · AWS 정가 추정 · 부분합 포함)";
  expect(chart.textContent).toContain(label);
  expect(chart.textContent).toContain("Claude Code 비용 (USD · 클라이언트 보고)");
  expect(chart.textContent).not.toContain("2건 제외");
  fireEvent.mouseMove(chart.querySelector(".recharts-wrapper"), { clientX: 200, clientY: 80 });
  await waitFor(() => expect(chart.querySelector(".recharts-tooltip-wrapper").textContent).toContain(label));
  expect(chart.querySelector(".recharts-tooltip-wrapper").textContent).not.toContain("2건 제외");
  expect(card("클라이언트별 비용 기준").textContent).toContain("미산정 2건 제외");
});

test.each([
  ["cost", "모델별 비용", "by_model"],
  ["cost", "사용자별 비용", "by_user"],
  ["productivity", "모델별 관측 효율", "by_model"],
  ["trends", "기간별 관측값", "timeseries"],
  ["analytics", "프로젝트 태그별 사용량", "by_project"],
])("%s %s displays and exports cost status without extra shared columns", (page, title, group) => {
  const data = fixture(["codex"]);
  const partial = { ...codexUsage, cost_partial: true, unpriced: 2, sessions: 2, users: null,
    user: "alice@example.test", project: "fixture-project", t: "2026-09-01T00:00:00Z" };
  data[group] = [partial, { ...partial, model: "unknown", user: "unknown", project: "unknown", cost_usd: null }];
  data.by_client = [partial];
  data.totals = partial;
  const download = vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
  mount(page, data);
  const table = card(title);
  expect(table.textContent).toContain("AWS 정가 추정 · 부분합 · 미산정 2건 제외");
  expect(table.textContent).toContain("AWS 정가 추정 · 미산정");
  expect(within(table).getAllByRole("columnheader").filter((c) => c.textContent.includes("비용 기준"))).toHaveLength(1);
  fireEvent.click(within(table).getByRole("button", { name: "CSV" }));
  const exported = download.mock.calls[0][1];
  expect(exported).toContain("AWS 정가 추정 · 부분합 · 미산정 2건 제외");
  expect(exported).toContain("AWS 정가 추정 · 미산정");
  expect(exported).toContain(page === "productivity" ? "0.00212025" : "0.0042405");
  if (page === "cost") {
    expect(tile("세션당 비용 (USD)").textContent).toContain("$0.00212025");
    expect(tile("세션당 비용 (USD)").textContent).toContain("부분합");
    expect(tile("사용자당 비용 (USD)").textContent).toContain("—");
    expect(card("비용 추이").textContent).toContain("부분합");
  }
});

test("token composition does not add reasoning a second time", () => {
  mount("usage", fixture(["codex"]));
  const composition = card("토큰 구성");
  expect(composition.textContent).toContain("270");
  expect(composition.textContent).not.toContain("285");
  expect(screen.getAllByText("입력 (캐시 제외)").length).toBeGreaterThan(0);
  expect(screen.getAllByText("추론 (출력의 일부)").length).toBeGreaterThan(0);
});
test("analytics retains project-tag usage with the selected client and reported cost basis", () => {
  const data = fixture(["codex"]);
  data.by_project = [{ ...data.by_client[0], project: "workshop-app" },
    { ...data.by_client[0], client: "claude", project: "excluded" }];
  mount("analytics", data);
  const projects = card("프로젝트 태그별 사용량");
  expect(projects.textContent).toContain("workshop-app");
  expect(projects.textContent).not.toContain("excluded");
  expect(projects.textContent).toContain("$0.0042405");
  expect(projects.textContent).toContain("AWS 정가 추정");
});

test("productivity exposes correct cache/input and reasoning/output percentages", () => {
  mount("productivity", fixture(["codex"]));
  const table = card("모델별 관측 효율");
  expect(table.textContent).toContain("45.45%");
  expect(table.textContent).toContain("30%");
  expect(table.textContent).toContain("15.71");
  expect(table.textContent).toContain("AWS 정가 추정");
});

test("unpriced totals and unsupported reasoning do not become zero or recomputed totals", () => {
  const data = fixture(["claude", "codex"]);
  data.totals.cost_usd = null;
  data.by_client[0].cost_usd = null;
  data.by_client[0].reasoning_tokens = null;
  mount("exec", data);
  expect(tile("비용 (USD)").textContent).toContain("—");
  const comparison = screen.getByRole("region", { name: "클라이언트 비교" });
  expect(comparison.textContent).toContain("클라이언트 보고");
  expect(comparison.textContent).toContain("AWS 정가 추정");
  expect(comparison.textContent).not.toContain("$0 ");
});

test("an unobserved enabled client remains visible and explicitly unavailable", () => {
  const data = fixture(["claude", "codex"]);
  data.by_client[0] = { ...data.by_client[0], observed_records: 0, tokens: 0, cost_usd: 0 };
  mount("overview", data);
  const comparison = screen.getByRole("region", { name: "클라이언트 비교" });
  expect(comparison.textContent).toContain("관측 없음");
  expect(within(comparison).getByText("Claude Code").closest(".shadow-card").textContent).not.toContain("$0");
});

test("missing token composition is disclosed instead of charting a partial total", () => {
  const data = fixture(["codex"]);
  data.by_client[0].cache_write_tokens = null;
  mount("usage", data);
  const composition = card("클라이언트별 토큰 구성");
  expect(within(composition).getByRole("status").textContent).toContain("확인 필요");
  expect(composition.querySelector("svg.recharts-surface")).toBeNull();
});

test("all-unpriced time series explain absent costs instead of plotting zero", () => {
  const data = fixture(["codex"]);
  data.timeseries = data.timeseries.map((row) => ({ ...row, cost_usd: null }));
  mount("trends", data);
  const costs = card("비용 추이");
  expect(costs.textContent).toContain("표시할 관측값이 없습니다");
  expect(costs.querySelector(".recharts-wrapper")).toBeNull();
  expect(card("토큰 추이").querySelector(".recharts-wrapper")).not.toBeNull();
});

test("long period tables initially show a bounded set and expand explicitly; CSV matches visible rows", () => {
  const data = fixture(["codex"]);
  data.timeseries = Array.from({ length: 48 }, (_, i) => ({
    ...codexUsage, t: new Date(Date.UTC(2026, 8, 1, i)).toISOString(),
  }));
  const download = vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
  mount("trends", data);
  const periods = card("기간별 관측값");
  expect(within(periods).getAllByRole("row")).toHaveLength(21);
  fireEvent.click(within(periods).getByRole("button", { name: "CSV" }));
  expect(download.mock.calls[0][1].split("\r\n")).toHaveLength(21);
  fireEvent.click(within(periods).getByRole("button", { name: /전체 48행/ }));
  expect(within(periods).getAllByRole("row")).toHaveLength(49);
});

test("reliability uses error records/request without capping it or treating it as success rate", () => {
  const data = fixture(["codex"]);
  data.by_client[0] = { ...data.by_client[0], requests: 2, api_errors: 5, ttft_ms: null };
  mount("reliability", data);
  const operations = card("요청·오류·응답 시간");
  expect(operations.textContent).toContain("2.5");
  expect(operations.textContent).toContain("—");
  expect(operations.textContent).not.toContain("250%");
  expect(screen.getByText(/1을 초과/)).toBeTruthy();
});

test.each([true, false])("user CSV preserves displayed order, masking=%s, raw costs and each row's basis", (piiMask) => {
  const data = fixture(["claude", "codex"]);
  data.by_user = [
    { ...data.by_user[1], user: "zoe@example.test", hidden: "secret-column", cost_usd: null, unpriced: 1 },
    { ...data.by_user[0], user: "alice@example.test", hidden: "secret-column" },
  ];
  const download = vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
  mount("users", data, data.clients, piiMask);
  const users = card("사용자별 사용량");
  fireEvent.click(within(users).getByRole("columnheader", { name: /^사용자/ }));
  fireEvent.click(within(users).getByRole("button", { name: "CSV" }));
  const exported = download.mock.calls[0][1];
  expect(exported).toContain("0.0042405");
  expect(exported).toContain("클라이언트 보고");
  expect(exported).toContain("AWS 정가 추정");
  expect(exported).not.toMatch(/secret-column|hidden/);
  const alice = piiMask ? "al******@example.test" : "alice@example.test";
  const zoe = piiMask ? "zo******@example.test" : "zoe@example.test";
  expect(exported.indexOf(alice)).toBeLessThan(exported.indexOf(zoe));
  if (piiMask) expect(exported + users.textContent).not.toMatch(/alice@|zoe@/);
  const lines = exported.replace(/^\uFEFF/, "").split("\r\n");
  const headers = lines[0].split(",");
  expect(headers).toHaveLength(within(users).getAllByRole("columnheader").length);
  expect(lines[2].split(",")[headers.indexOf("비용 (USD)")]).toBe("");
});
