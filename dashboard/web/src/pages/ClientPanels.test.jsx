import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RangeProvider, useRange } from "../RangeContext.jsx";
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
function hoverAt(chart, fraction) {
  const grid = chart.querySelector(".recharts-cartesian-grid-horizontal line");
  const left = Number(grid.getAttribute("x1")), right = Number(grid.getAttribute("x2"));
  fireEvent.mouseMove(chart, { clientX: left + (right - left) * fraction, clientY: 80 });
}
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
  expect(tile("관측 토큰").textContent).toContain("270");
  expect(tile("관측 사용자 ID").textContent).toContain("—");
  const comparison = screen.getByRole("region", { name: "클라이언트 비교" });
  expect(comparison.textContent).toContain("AWS 정가 추정");
  expect(comparison.textContent).toContain("$0.0042405");
});

function partialTokensFixture() {
  const data = fixture(["codex"]);
  const partial = { ...codexUsage, tokens: null, observed_tokens: 148, tokens_partial: true,
    input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null,
    reasoning_tokens: null, user: "fixture@example.test", project: "fixture-project", t: "2026-09-01T00:00:00Z" };
  data.totals = { ...partial };
  data.by_client = [{ ...partial }];
  const rows = [
    partial,
    { ...partial, observed_tokens: null, tokens: 999, t: "2026-09-01T01:00:00Z", model: "unknown" },
    { ...partial, observed_tokens: 0, t: "2026-09-01T03:00:00Z", model: "zero" },
  ];
  for (const key of ["by_model", "by_user", "by_project", "timeseries"]) data[key] = rows;
  data.effective_range = { from: "2026-09-01T00:00:00Z", to: "2026-09-01T05:00:00Z" };
  return data;
}

test("mixed known/missing usage retains the observed total and chart points with partial context", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  mount("overview", partialTokensFixture());
  expect(tile("관측 토큰").textContent).toContain("148");
  expect(tile("관측 토큰").textContent).toContain("부분합");
  const comparison = screen.getByRole("region", { name: "클라이언트 비교" });
  expect(comparison.textContent).toContain("148");
  expect(comparison.textContent).toContain("부분합");
  const chart = card("사용량·비용 추이");
  expect(chart.textContent).toContain("관측 토큰");
  expect(chart.textContent).toContain("부분합");
  const tokens = chart.querySelector(".recharts-wrapper");
  await waitFor(() => expect(tokens.querySelectorAll(".recharts-line-dot")).toHaveLength(1));
  const dots = [...tokens.querySelectorAll(".recharts-line-dot")];
  fireEvent.mouseMove(tokens, { clientX: Number(dots[0].getAttribute("cx")), clientY: 80 });
  await waitFor(() => expect(tokens.querySelector(".recharts-tooltip-wrapper").textContent).toContain("148"));
  expect(tokens.querySelector(".recharts-tooltip-wrapper").textContent).toContain("부분합");
  hoverAt(tokens, 1 / 5);
  await waitFor(() => expect(tokens.querySelector(".recharts-tooltip-wrapper").textContent).toContain("미확인"));
  hoverAt(tokens, 2 / 5);
  await waitFor(() => expect(tokens.querySelector(".recharts-tooltip-wrapper").textContent).toContain("0 (관측 사용량 없음)"));
});

test.each([
  [null, "—", "미확인"], [0, "0", "부분합"],
])("primary observed tokens %s never fall back to canonical totals", (observed_tokens, value, status) => {
  const data = partialTokensFixture();
  data.totals = { ...data.totals, tokens: 999, observed_tokens };
  mount("overview", data);
  expect(tile("관측 토큰").textContent).toContain(value);
  expect(tile("관측 토큰").textContent).toContain(status);
  expect(tile("관측 토큰").textContent).not.toContain("999");
});

test.each([
  ["overview", "모델별 사용량"],
  ["exec", "모델별 비용·활동"],
  ["trends", "클라이언트별 비교"],
  ["trends", "기간별 관측값"],
  ["usage", "클라이언트별 사용량"],
  ["users", "사용자별 사용량"],
  ["cost", "모델별 비용"],
  ["cost", "사용자별 비용"],
  ["analytics", "클라이언트별 신호 비교"],
  ["analytics", "모델·백엔드 진단"],
  ["analytics", "프로젝트 태그별 사용량"],
])("%s %s exports numeric observed tokens and a separate per-row status", (page, title) => {
  const download = vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
  mount(page, partialTokensFixture());
  const table = card(title);
  const headers = within(table).getAllByRole("columnheader").map((node) => node.textContent.replace("↕", ""));
  const index = headers.indexOf("관측 토큰"), statusIndex = headers.indexOf("토큰 상태");
  expect(index).toBeGreaterThanOrEqual(0);
  expect(statusIndex).toBeGreaterThanOrEqual(0);
  const rows = within(table).getAllByRole("row").slice(1);
  const isComparison = rows.length === 1;
  expect(rows.map((row) => within(row).getAllByRole("cell")[index].textContent))
    .toEqual(isComparison ? ["148"] : ["148", "—", "0"]);
  expect(rows.map((row) => within(row).getAllByRole("cell")[statusIndex].textContent))
    .toEqual(isComparison ? ["부분합"] : ["부분합", "미확인", "부분합"]);
  fireEvent.click(within(table).getByRole("button", { name: "CSV" }));
  const exported = download.mock.calls[0][1].split("\r\n").slice(1).map((row) => row.split(","));
  expect(exported.map((row) => row[index])).toEqual(isComparison ? ["148"] : ["148", "", "0"]);
  expect(exported.map((row) => row[statusIndex])).toEqual(isComparison ? ["부분합"] : ["부분합", "미확인", "부분합"]);
});

test("partial observed tokens leave efficiency ratios and canonical component gauges unavailable", () => {
  const data = partialTokensFixture();
  data.by_model = [data.by_model[0]];
  mount("productivity", data);
  const table = card("모델별 관측 효율");
  const headers = within(table).getAllByRole("columnheader").map((node) => node.textContent.replace("↕", ""));
  const cells = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell"))[0];
  for (const label of ["세션당 토큰", "100만 토큰당 비용 (USD)", "캐시 읽기 / 전체 입력 (%)", "추론 / 출력 (%)"]) {
    expect(cells[headers.indexOf(label)].textContent).toBe("—");
  }
  expect(card("캐시·추론 비중").textContent).not.toMatch(/45.45%|30%|148/);
});

test("unpriced costs alone do not label observed tokens partial in cards or charts", () => {
  const data = fixture(["codex"]);
  const row = { ...codexUsage, observed_tokens: 148, tokens_partial: false, unpriced: 1, cost_partial: true };
  data.totals = row;
  data.by_client = [row];
  data.timeseries = [{ ...row, t: "2026-09-01T00:00:00Z" }];
  mount("overview", data);
  expect(tile("관측 토큰").textContent).toContain("148");
  expect(tile("관측 토큰").textContent).not.toContain("부분합");
  const legend = within(card("사용량·비용 추이")).getByText(/^Codex 관측 토큰/);
  expect(legend.textContent).toContain("Codex 관측 토큰");
  expect(legend.textContent).not.toContain("부분합");
});

test("empty recorded-usage buckets connect through zero on the elapsed-time axis", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
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
    await waitFor(() => expect(codex.querySelector(".recharts-line-curve")).not.toBeNull());
    expect(codex.querySelector(".recharts-line-curve").getAttribute("d").match(/M/g)).toHaveLength(1);
    hoverAt(chart, 6 / 12);
    await waitFor(() => expect(chart.querySelector(".recharts-tooltip-wrapper").textContent).toContain("0 (관측 사용량 없음)"));
    hoverAt(chart, 10 / 12);
    await waitFor(() => expect(chart.querySelector(".recharts-tooltip-wrapper").textContent)
      .toContain(chart === charts[0] ? "50" : "5"));
  }
});

test("a measured zero and unknown value in the same bucket have distinct tooltips", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  const data = fixture(["claude", "codex"]);
  data.effective_range = { from: "2026-09-01T00:00:00Z", to: "2026-09-01T04:00:00Z" };
  data.timeseries = [
    { client: "codex", t: "2026-09-01T01:00:00Z", tokens: 0, cost_usd: 0 },
    { client: "claude", t: "2026-09-01T01:00:00Z", tokens: null, cost_usd: null },
  ];
  mount("overview", data);
  const charts = card("사용량·비용 추이").querySelectorAll(".recharts-wrapper");
  for (const chart of charts) {
    hoverAt(chart, 1 / 4);
    await waitFor(() => expect(chart.querySelector(".recharts-tooltip-wrapper").textContent)
      .toContain(chart === charts[0] ? "미확인" : "미산정"));
    expect(chart.querySelector(".recharts-tooltip-wrapper").textContent).toContain("0");
    expect(chart.querySelector(".recharts-tooltip-wrapper").textContent).not.toContain("관측 사용량 없음");
  }
});

test("rejected-request zeros explain the failure while unpriced completion costs stay unknown", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  const data = fixture(["codex"]);
  data.effective_range = { from: "2026-09-01T00:00:00Z", to: "2026-09-01T03:00:00Z" };
  data.timeseries = [
    { ...codexUsage, t: "2026-09-01T00:00:00Z", observed_tokens: 10, cost_usd: 1 },
    { ...codexUsage, t: "2026-09-01T01:00:00Z", tokens: 0, observed_tokens: 0, cost_usd: 0,
      observed_records: 3, rejected_requests: 3, request_rejections_only: true },
    { ...codexUsage, t: "2026-09-01T02:00:00Z", observed_tokens: 20, cost_usd: null, cost_partial: true },
  ];
  mount("overview", data);
  const charts = card("사용량·비용 추이").querySelectorAll(".recharts-wrapper");
  for (const chart of charts) {
    hoverAt(chart, 1 / 3);
    await waitFor(() => expect(chart.querySelector(".recharts-tooltip-wrapper").textContent).toContain("0 (요청 거절 3건)"));
  }
  hoverAt(charts[1], 2 / 3);
  await waitFor(() => expect(charts[1].querySelector(".recharts-tooltip-wrapper").textContent).toContain("미산정"));
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

// 공통 추이의 버킷 크기는 같은 응답(bucket_hours)에서 오므로 보정 폭은 늘 맞지만, stale인 동안에는
// 이전 기간의 행 위에서 구간을 고르게 되므로 줌을 멈춘다. stale은 trendProps를 거쳐 Trend로 간다.
test.each([[false, "2026-09-01T00:00:00.000Z / 2026-09-01T03:00:00.000Z"], [true, "none"]])(
  "the shared trend drag-zooms only while its data is not stale (stale=%s)", async (stale, expected) => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    function Selection() {
      const { custom } = useRange();
      return <output aria-label="선택 구간">{custom
        ? `${custom.from.toISOString()} / ${custom.to.toISOString()}` : "none"}</output>;
    }
    const data = fixture(["codex"]);
    data.effective_range = { from: "2026-09-01T00:00:00Z", to: "2026-09-01T03:00:00Z" };
    data.bucket_hours = 1;
    data.timeseries = ["00", "01", "02"].map((h, i) => ({ client: "codex", t: `2026-09-01T${h}:00:00Z`, tokens: 10 + i, cost_usd: 1 }));
    setPiiMask(true);
    render(
      <MemoryRouter><ConfigProvider config={{ piiMask: true }}>
        <RangeProvider><ClientPanels page="overview" data={data} clients={data.clients} stale={stale} /><Selection /></RangeProvider>
      </ConfigProvider></MemoryRouter>,
    );
    const chart = card("사용량·비용 추이").querySelector(".recharts-wrapper");
    await waitFor(() => expect(chart.querySelector(".recharts-cartesian-grid-horizontal line")).not.toBeNull());
    const grid = chart.querySelector(".recharts-cartesian-grid-horizontal line");
    const left = Number(grid.getAttribute("x1")), right = Number(grid.getAttribute("x2"));
    const x = (hour) => left + (right - left) * hour / 3;
    fireEvent.mouseDown(chart, { clientX: x(0), clientY: 60 });
    fireEvent.mouseMove(chart, { clientX: x(2), clientY: 60 });
    fireEvent.mouseUp(chart, { clientX: x(2), clientY: 60 });
    await waitFor(() => expect(screen.getByLabelText("선택 구간").textContent).toBe(expected));
  });

// Shared model cost fixture: timeseries costs equal the by_model_time known sums per bucket.
const bmt = (client, t, model, backend, cost_usd, extra = {}) => ({ client, t, model, backend, cost_usd,
  cost_partial: false, unpriced: 0, observed_tokens: 10, ...extra });
function modelTimeData(clients = ["claude", "codex"]) {
  const rows = [
    bmt("claude", "2026-09-01T00:00:00Z", "claude-sonnet-5", "anthropic", 2),
    bmt("claude", "2026-09-01T01:00:00Z", "claude-sonnet-5", "anthropic", 3),
    bmt("codex", "2026-09-01T00:00:00Z", "openai.gpt-6-astra", "bedrock-mantle", 1),
    bmt("codex", "2026-09-01T01:00:00Z", "global.openai.gpt-6-astra", "bedrock-mantle", null,
      { cost_partial: true, unpriced: 2, unpriced_reasons: { scope: 2 } }),
  ].filter((r) => clients.includes(r.client));
  return { ...fixture(clients), by_model_time: rows, bucket_hours: 1,
    effective_range: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-01T02:00:00.000Z" },
    timeseries: rows.map((r) => ({ client: r.client, t: r.t, cost_usd: r.cost_usd, cost_partial: r.cost_partial, unpriced: r.unpriced, tokens: 10 })) };
}
const trends = () => document.querySelector('section[aria-label="클라이언트별 모델 비용 추이"]');
const trendCards = () => [...trends().querySelectorAll(".shadow-card")];
const toggle = () => [...trends().children[0].querySelectorAll("button")]
  .map((b) => `${b.textContent}${b.className.includes("bg-brand-500") ? "*" : ""}`);
const trendTitles = () => trendCards().map((c) => c.querySelector(".truncate").textContent);

// Cost defaults to the global interval (2 days → 1h); exec defaults to 24h up to 30 days.
test.each([["cost", "시간별*"], ["exec", "일간*"]])(
  "%s renders one model cost trend card per client with its own basis and the default bucket %s", async (page, active) => {
    mount(page, modelTimeData());
    expect(trendTitles()).toEqual(["Claude Code 모델별 비용 추이", "Codex 모델별 비용 추이"]);
    expect(toggle()).toEqual(["시간별", "일간", "주간"].map((label) => (`${label}*` === active ? active : label)));
    const [claude, codex] = trendCards();
    expect(claude.textContent).toContain("Claude 보고 비용");
    expect(claude.textContent).not.toContain("Codex AWS 정가 추정");
    expect(codex.textContent).toContain("Codex AWS 정가 추정");
    expect(codex.textContent).not.toContain("Claude 보고 비용");
    await waitFor(() => expect(codex.querySelector('[data-reason="scope"]')).not.toBeNull());
    expect(codex.querySelector('[data-reason="scope"]').textContent)
      .toBe("범위·백엔드 불일치 2건 — global.openai.gpt-6-astra · bedrock-mantle 2건");
    expect(claude.querySelector("[data-status-headline]").textContent).toBe("확인이 필요한 버킷이 없습니다.");
    expect([...claude.querySelectorAll('ul[aria-label="범례"] li')].map((li) => li.textContent)).toEqual(["claude-sonnet-5"]);
  });

// ADR-017: the overview can fill a Claude cell with a token-computed estimate when no
// report is usable. The static basis chip must disclose that, not draw it as an ordinary
// report — Codex's chip is unaffected since it never carries a Claude cost_basis.
test("the Claude trend basis chip discloses an estimated cell; Codex's stays unaffected", () => {
  const data = modelTimeData();
  data.by_model_time[0].cost_basis = "computed_estimate";
  mount("cost", data);
  const [claude, codex] = trendCards();
  expect(claude.textContent).toContain("Claude 보고 비용 · 일부 계산 추정");
  expect(codex.textContent).toContain("Codex AWS 정가 추정");
  expect(codex.textContent).not.toContain("일부 계산 추정");
});

test("a response without by_model_time leaves each model cost trend card unavailable, never $0", () => {
  mount("cost", { ...modelTimeData(), by_model_time: undefined });
  const cards = trendCards();
  expect(cards).toHaveLength(2);
  for (const node of cards) {
    expect(node.querySelector('[role="status"]').textContent).toBe("모델별 비용 정보가 없어 추이를 확인할 수 없습니다.");
    expect(node.querySelector(".recharts-wrapper")).toBeNull();
    expect(node.textContent).not.toContain("$0");
  }
});

// The toggle never offers a bucket smaller than the response's bucket_hours.
test.each([
  [1, ["시간별*", "일간", "주간"]],
  [1 / 60, ["1분", "시간별*", "일간", "주간"]],
  // Host-added: a coarser source (not returned today) drops the finer options.
  [24, ["일간*", "주간"]],
])(
  "bucket_hours=%s limits the model cost trend toggle", (bucket_hours, expected) => {
    mount("cost", { ...modelTimeData(["claude"]), bucket_hours });
    expect(toggle()).toEqual(expected);
  });

test("picking 일간 rolls hourly model cells up into one day bucket", async () => {
  mount("cost", modelTimeData());
  fireEvent.click(within(trends().children[0]).getByRole("button", { name: "일간" }));
  await waitFor(() => expect(toggle()).toEqual(["시간별", "일간*", "주간"]));
  const claude = trendCards()[0];
  fireEvent.click(within(claude).getByRole("button", { name: "표 보기" }));
  await waitFor(() => expect(claude.querySelectorAll("tr[data-bucket]")).toHaveLength(1));
  const row = claude.querySelector("tr[data-bucket]");
  expect(row.getAttribute("data-bucket")).toBe("2026-09-01 00:00:00");
  // 2 + 3 rolled into one day; there is no 기타 column.
  expect([...row.querySelectorAll("td")].slice(1).map((td) => td.textContent)).toEqual(["$5", "$5", "확인됨"]);
});

test("an unselected client renders no model cost trend card", () => {
  mount("cost", modelTimeData(["codex"]), ["codex"]);
  expect(trendTitles()).toEqual(["Codex 모델별 비용 추이"]);
  expect(trends().textContent).not.toContain("Claude 보고 비용");
});

// The drag zoom uses the displayed (rolled-up) interval, not the response's bucket_hours, and stops while stale.
test.each([[false, "2026-09-01T00:00:00.000Z / 2026-09-04T00:00:00.000Z"], [true, "none"]])(
  "the model cost trend drag-zooms by the displayed interval only while not stale (stale=%s)", async (stale, expected) => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    function Selection() {
      const { custom } = useRange();
      return <output aria-label="선택 구간">{custom
        ? `${custom.from.toISOString()} / ${custom.to.toISOString()}` : "none"}</output>;
    }
    const days = [1, 2, 3].map((d) => bmt("claude", `2026-09-0${d}T00:00:00Z`, "claude-sonnet-5", "anthropic", d));
    const data = { ...fixture(["claude"]), bucket_hours: 1,
      effective_range: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-04T00:00:00.000Z" },
      by_model_time: days,
      timeseries: days.map((r) => ({ client: "claude", t: r.t, cost_usd: r.cost_usd, cost_partial: false, unpriced: 0, tokens: 10 })) };
    setPiiMask(true);
    render(
      <MemoryRouter><ConfigProvider config={{ piiMask: true }}>
        <RangeProvider><ClientPanels page="cost" data={data} clients={data.clients} stale={stale} /><Selection /></RangeProvider>
      </ConfigProvider></MemoryRouter>,
    );
    fireEvent.click(within(trends().children[0]).getByRole("button", { name: "일간" }));
    await waitFor(() => expect(toggle()).toEqual(["시간별", "일간*", "주간"]));
    const chart = trendCards()[0].querySelector(".recharts-wrapper");
    await waitFor(() => expect(chart.querySelector(".recharts-cartesian-grid-horizontal line")).not.toBeNull());
    const grid = chart.querySelector(".recharts-cartesian-grid-horizontal line");
    const left = Number(grid.getAttribute("x1")), right = Number(grid.getAttribute("x2"));
    const x = (i) => left + (right - left) * (i + 0.5) / 3;
    fireEvent.mouseDown(chart, { clientX: x(0), clientY: 60 });
    fireEvent.mouseMove(chart, { clientX: x(2), clientY: 60 });
    fireEvent.mouseUp(chart, { clientX: x(2), clientY: 60 });
    await waitFor(() => expect(screen.getByLabelText("선택 구간").textContent).toBe(expected));
  });

// Host-added with the wiring: a minute-level global interval over hourly data must not ask
// rollupBuckets for a smaller target, and a bucket pick lasts only until the range changes.
test("the shared bucket is clamped to bucket_hours", () => {
  render(<MemoryRouter initialEntries={["/?from=2026-09-01T00:00:00.000Z&to=2026-09-01T02:00:00.000Z"]}>
    <ConfigProvider config={{ piiMask: true }}><RangeProvider>
      <ClientPanels page="cost" data={modelTimeData(["claude"])} clients={["claude"]} />
    </RangeProvider></ConfigProvider></MemoryRouter>);
  expect(toggle()).toEqual(["시간별*", "일간", "주간"]);
});

test("a shared bucket pick lasts until the range changes", () => {
  function Seven() { const { setDays } = useRange(); return <button type="button" onClick={() => setDays(7)}>range-7</button>; }
  render(<MemoryRouter><ConfigProvider config={{ piiMask: true }}><RangeProvider>
    <ClientPanels page="cost" data={modelTimeData(["claude"])} clients={["claude"]} /><Seven />
  </RangeProvider></ConfigProvider></MemoryRouter>);
  fireEvent.click(within(trends().children[0]).getByRole("button", { name: "주간" }));
  expect(toggle()).toEqual(["시간별", "일간", "주간*"]);
  fireEvent.click(screen.getByRole("button", { name: "range-7" }));
  expect(toggle()).toEqual(["시간별", "일간*", "주간"]);
});
