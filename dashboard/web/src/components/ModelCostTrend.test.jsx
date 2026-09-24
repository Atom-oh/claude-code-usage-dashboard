import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RangeProvider, useRange } from "../RangeContext.jsx";
import { ModelCostTrend } from "./ModelCostTrend.jsx";
import { fromByModelTime } from "../modelCostTrend.js";

// jsdom has no layout or ResizeObserver. Keep the real Recharts render path and
// supply only the browser dimensions its ResponsiveContainer and Tooltip need.
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300, x: 0, y: 0,
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function Providers({ children }) { return <MemoryRouter><RangeProvider>{children}</RangeProvider></MemoryRouter>; }
function Selection() {
  const { custom } = useRange();
  return <output aria-label="선택 구간">{custom ? `${custom.from.toISOString()} / ${custom.to.toISOString()}` : "none"}</output>;
}

const idle = (t) => ({ t, model: null, channel: null, known: null, partial: false, unavailable: 0,
  reasons: {}, observed_tokens: null, idle: true });
const c = (t, model, channel, known, extra = {}) => ({ t, model, channel, known, partial: false,
  unavailable: 0, reasons: {}, observed_tokens: 10, ...extra });
const D1 = "2026-09-01 00:00:00", D2 = "2026-09-02 00:00:00", D3 = "2026-09-03 00:00:00",
  D4 = "2026-09-04 00:00:00", D5 = "2026-09-05 00:00:00", D6 = "2026-09-06 00:00:00";
const CELLS = [
  c(D1, "claude-sonnet-5", "enterprise", 5),
  c(D1, "zai.glm-5", "bedrock", 1),
  c(D1, "claude-haiku-4-5", "enterprise", 0.5),
  c(D2, "claude-sonnet-5", "enterprise", 3),
  c(D2, "claude-opus-5", "bedrock", 0, { partial: true, unavailable: 2, reasons: { report_zero_with_tokens: 2 } }),
  c(D3, "claude-opus-5", "bedrock", null, { unavailable: 1, reasons: { report_missing: 1 }, observed_tokens: null }),
  c(D4, "claude-sonnet-5", "enterprise", 0),
  idle(D5),
];
const BOUNDS = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-07T00:00:00.000Z" };
const CODEX = [
  c(D1, "openai.gpt-6-astra", "bedrock-mantle", 4),
  c(D1, "global.openai.gpt-6-astra", "bedrock-mantle", null, { unavailable: 2, reasons: { scope: 2 } }),
  c(D1, "openai.gpt-6-astra", "unknown", null, { unavailable: 1, reasons: { unknown_backend: 1 } }),
  c(D1, "kimi-k3", "bedrock-mantle", null, { unavailable: 3, reasons: { unknown_model: 3 } }),
  c(D1, "openai.gpt-5.6-luna", "bedrock-mantle", 1, { partial: true, unavailable: 1, reasons: { invalid_usage: 1 } }),
  c(D1, "", "bedrock-mantle", null, { unavailable: 1, reasons: { missing_usage: 1 } }),
];
const mount = (props) => render(<><ModelCostTrend title="모델별 비용 추이" xKey="t" bucketHours={24} {...props} /><Selection /></>, { wrapper: Providers });
const chartReady = (container) => waitFor(() => expect(container.querySelector(".recharts-wrapper svg")).not.toBeNull());

const MAIN = { cells: CELLS, top: 2, bounds: BOUNDS, basis: "Claude 보고 비용" };

// Bucket-center x for a hover or drag across n buckets, read from the first horizontal grid line.
function bucketX(chart, n) {
  const grid = chart.querySelector(".recharts-cartesian-grid-horizontal line");
  const left = Number(grid.getAttribute("x1")), right = Number(grid.getAttribute("x2"));
  return (i) => left + (right - left) * (i + 0.5) / n;
}

const texts = (root, sel) => [...root.querySelectorAll(sel)].map((el) => el.textContent);
const reason = (status, key) => status.querySelector(`[data-reason="${key}"]`)?.textContent ?? null;
const keysOf = (tip) => [...tip.querySelectorAll("[data-entry]")].map((el) => el.getAttribute("data-entry"));
// Selection's <output> also has the implicit role "status": match the explicit attribute.
const statusOf = (container) => {
  const found = container.querySelectorAll('[role="status"]');
  expect(found.length).toBe(1);
  return found[0];
};

test("stacked series plus 기타 with stable fills", async () => {
  const { container } = mount(MAIN);
  await chartReady(container);
  const paths = [...container.querySelectorAll(".recharts-bar-rectangle path")];
  expect(paths.length).toBe(4);
  const fills = paths.map((p) => p.getAttribute("fill"));
  expect(fills[0]).toBe("#5B6BDB");
  expect(fills[1]).toBe("#5B6BDB");
  expect(fills[2]).toMatch(/^url\(#.+-s1\)$/);
  expect(fills[3]).toBe("#A3A9B6");
  const id = fills[2].slice("url(#".length, -1);
  const pattern = container.querySelector(`pattern[id="${id}"]`);
  expect(pattern).not.toBeNull();
  const rectFills = [...pattern.querySelectorAll("rect")].map((r) => r.getAttribute("fill"));
  expect(rectFills).toContain("#AB9E70");
  const legend = screen.getByRole("list", { name: "범례" });
  expect(texts(legend, "li")).toEqual(["claude-sonnet-5", "zai.glm-5", "기타 2개 모델"]);
  expect([...legend.querySelectorAll("[data-swatch]")].map((el) => el.getAttribute("data-swatch")))
    .toEqual(["solid", "hatch", "others"]);
});

test("bucket marks by state", async () => {
  const { container } = mount(MAIN);
  await chartReady(container);
  for (const state of ["partial", "unavailable", "zero", "idle", "nodata", "known"]) {
    expect(container.querySelectorAll(`[data-state="${state}"]`).length).toBe(1);
  }
  const gridYs = [...container.querySelectorAll(".recharts-cartesian-grid-horizontal line")]
    .map((line) => Number(line.getAttribute("y1")));
  const plotTop = Math.min(...gridYs);
  const partial = container.querySelector('[data-state="partial"]');
  expect(partial.getAttribute("aria-label")).toContain("부분합");
  expect(Number(partial.querySelector("circle").getAttribute("cy"))).toBeLessThan(plotTop);
  expect(partial.querySelector("text").textContent).toBe("!");
  const unavailable = container.querySelector('[data-state="unavailable"]');
  expect(unavailable.getAttribute("aria-label")).toContain("비용 확인 불가");
  expect(unavailable.querySelector("text").textContent).toBe("?");
  const zero = container.querySelector('[data-state="zero"]');
  expect(zero.querySelector("rect").getAttribute("height")).toBe("2");
  const idleMark = container.querySelector('[data-state="idle"]');
  expect(idleMark.getAttribute("aria-label")).toContain("기록된 사용 없음");
  expect(container.querySelector('[data-state="nodata"]').children.length).toBe(0);
  expect(container.querySelector('[data-state="known"]').children.length).toBe(0);
});

test("Claude status names each reason with identities, including 기타", async () => {
  const { container } = mount(MAIN);
  await chartReady(container);
  const status = statusOf(container);
  expect(status.querySelector("[data-status-headline]").textContent).toBe("확인 필요 2개 버킷 · 1개 항목");
  expect(reason(status, "report_missing")).toBe("보고 비용 없음 1건 — claude-opus-5 · bedrock (기타) 1건");
  expect(reason(status, "report_zero_with_tokens")).toBe("보고 0·토큰 있음 2건 — claude-opus-5 · bedrock (기타) 2건");
  expect(reason(status, "scope")).toBeNull();
  expect(status.querySelector("[data-status-note]")).not.toBeNull();
  expect(status.querySelector("[data-status-idle]").textContent)
    .toBe("기록된 사용 없음 1개 버킷 — 수집이 완전하다는 뜻은 아닙니다.");
  expect(container.querySelector(".recharts-wrapper")).not.toBeNull();
});

test("Codex reasons stay distinct from missing usage", async () => {
  const { container } = mount({ cells: CODEX, basis: "Codex AWS 정가 추정" });
  await chartReady(container);
  const status = statusOf(container);
  expect(status.querySelector("[data-status-headline]").textContent).toBe("확인 필요 1개 버킷 · 5개 항목");
  expect(reason(status, "scope")).toBe("범위·백엔드 불일치 3건 — global.openai.gpt-6-astra · bedrock-mantle 2건, openai.gpt-6-astra · unknown 1건");
  expect(reason(status, "unknown_model")).toBe("단가 미등록 모델 3건 — kimi-k3 · bedrock-mantle 3건");
  expect(reason(status, "invalid_usage")).toBe("유효하지 않은 사용량 1건 — openai.gpt-5.6-luna · bedrock-mantle 1건");
  expect(reason(status, "missing_usage")).toBe("사용량 미기록 1건 — (모델 미상) · bedrock-mantle 1건");
  expect(reason(status, "report_missing")).toBeNull();
  expect(reason(status, "report_zero_with_tokens")).toBeNull();
  expect(screen.getByText("Codex AWS 정가 추정")).toBeTruthy();
  const legend = screen.getByRole("list", { name: "범례" });
  expect(texts(legend, "li")).toEqual(["openai.gpt-6-astra", "openai.gpt-5.6-luna", "(모델 미상)", "kimi-k3"]);
});

test("basis chip", async () => {
  const first = mount(MAIN);
  await chartReady(first.container);
  expect(screen.getByText("Claude 보고 비용")).toBeTruthy();
  cleanup();
  const second = mount({ cells: CELLS, top: 2, bounds: BOUNDS });
  await chartReady(second.container);
  expect(screen.queryByText("Claude 보고 비용")).toBeNull();
});

test("table toggle", async () => {
  const { container } = mount(MAIN);
  await chartReady(container);
  const toggle = screen.getByRole("button", { name: "표 보기" });
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(container.querySelector("table")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  const table = screen.getByRole("table", { name: "버킷별 비용 표" });
  expect(texts(table, "thead th")).toEqual(["버킷", "claude-sonnet-5", "zai.glm-5", "기타 2개 모델", "알려진 합계", "상태"]);
  const rows = [...table.querySelectorAll("tr[data-bucket]")]
    .map((tr) => [...within(tr).getAllByRole("cell")].slice(1).map((td) => td.textContent));
  expect(rows).toEqual([
    ["$5", "$1", "$0.5", "$6.5", "확인됨"],
    ["$3", "—", "$0 ⚠", "$3", "부분합"],
    ["—", "—", "— ⚠", "—", "확인 불가"],
    ["$0", "—", "—", "$0", "$0 (측정값)"],
    ["—", "—", "—", "$0", "기록된 사용 없음"],
    ["—", "—", "—", "—", "데이터 없음"],
  ]);
  const others = screen.getByRole("table", { name: "기타 모델 내역" });
  const otherRows = [...others.querySelectorAll("tbody tr")]
    .map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
  expect(otherRows).toEqual([
    ["claude-haiku-4-5", "enterprise", "$0.5", "—"],
    ["claude-opus-5", "bedrock", "$0", "3건"],
  ]);
});

test("tooltip sorted by value with known total and partial note", async () => {
  const { container } = mount(MAIN);
  await chartReady(container);
  const chart = container.querySelector(".recharts-wrapper");
  const x = bucketX(chart, 6);
  fireEvent.mouseMove(chart, { clientX: x(0), clientY: 80 });
  await waitFor(() => expect(container.querySelector("[data-mct-tooltip]")).not.toBeNull());
  let tip = container.querySelector("[data-mct-tooltip]");
  expect(keysOf(tip))
    .toEqual(["s0", "s1", "__others"]);
  expect(texts(tip, "[data-value]")).toEqual(["$5.00", "$1.00", "$0.50"]);
  expect(tip.querySelector("[data-tooltip-total]").textContent).toBe("알려진 합계 $6.50");
  expect(tip.querySelector("[data-tooltip-note]")).toBeNull();
  fireEvent.mouseMove(chart, { clientX: x(1), clientY: 80 });
  await waitFor(() => expect(container.querySelector("[data-mct-tooltip] [data-tooltip-total]").textContent)
    .toBe("알려진 합계 (부분합) $3.00"));
  tip = container.querySelector("[data-mct-tooltip]");
  expect(keysOf(tip))
    .toEqual(["s0", "__others"]);
  expect(texts(tip, "[data-value]")).toEqual(["$3.00", "$0.00"]);
  expect(tip.querySelector("[data-tooltip-note]").textContent)
    .toBe("확인 필요: claude-opus-5 · bedrock (보고 0·토큰 있음)");
});

test("empty, missing-dimension and all-unavailable states", async () => {
  const empty = mount({ cells: [] });
  expect(screen.getByText("선택한 기간에 데이터가 없습니다.")).toBeTruthy();
  expect(empty.container.querySelector('[role="status"]')).toBeNull();
  expect(empty.container.querySelector(".recharts-wrapper")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();

  const missing = mount({ cells: null });
  expect(statusOf(missing.container).textContent).toBe("모델별 비용 정보가 없어 추이를 확인할 수 없습니다.");
  expect(missing.container.querySelector(".recharts-wrapper")).toBeNull();
  cleanup();

  const all = mount({ cells: [c(D1, "claude-opus-5", "bedrock", null, { unavailable: 1, reasons: { report_missing: 1 } })] });
  await waitFor(() => expect(all.container.querySelector('[role="status"]')).not.toBeNull());
  const status = statusOf(all.container);
  expect(all.container.querySelector(".recharts-wrapper")).toBeNull();
  expect(status.querySelector("[data-status-all-unavailable]").textContent).toBe("선택한 기간의 비용을 모두 확인할 수 없습니다.");
  expect(status.querySelector('[data-reason="report_missing"]')).not.toBeNull();
});

const DAILY = [c(D1, "a", "e", 1), c(D2, "a", "e", 2), c(D3, "a", "e", 3)];
const WEEKLY = [c("2026-09-10 00:00:00", "a", "e", 1), c("2026-09-17 00:00:00", "a", "e", 2), c("2026-09-24 00:00:00", "a", "e", 3)];

test.each([
  [24, false, "2026-09-01T00:00:00.000Z / 2026-09-04T00:00:00.000Z", DAILY],
  [168, false, "2026-09-10T00:00:00.000Z / 2026-10-01T00:00:00.000Z", WEEKLY],
  [24, true, "none", DAILY],
])("drag zoom uses the displayed bucket size and honours zoomDisabled (bucketHours=%s, zoomDisabled=%s)", async (bucketHours, zoomDisabled, expected, cells) => {
  const { container } = mount({ cells, bucketHours, zoomDisabled });
  await chartReady(container);
  const chart = container.querySelector(".recharts-wrapper");
  const x = bucketX(chart, 3);
  fireEvent.mouseDown(chart, { clientX: x(0), clientY: 80 });
  fireEvent.mouseMove(chart, { clientX: x(2), clientY: 80 });
  // A left margin of 0 made Recharts discard the drag highlight (host-measured).
  expect(chart.querySelectorAll(".recharts-reference-area").length).toBe(zoomDisabled ? 0 : 1);
  fireEvent.mouseUp(chart, { clientX: x(2), clientY: 80 });
  await waitFor(() => expect(screen.getByLabelText("선택 구간").textContent).toBe(expected));
});

// Host-added: in the fixture above series rank matches bucket values, hiding a missing sort.
test("tooltip order follows the bucket's values, not the series rank", async () => {
  const { container } = mount({ cells: [c(D1, "a", "e", 1), c(D1, "b", "e", 10), c(D2, "a", "e", 30)] });
  await chartReady(container);
  const chart = container.querySelector(".recharts-wrapper");
  fireEvent.mouseMove(chart, { clientX: bucketX(chart, 2)(0), clientY: 80 });
  await waitFor(() => expect(container.querySelector("[data-mct-tooltip]")).not.toBeNull());
  const tip = container.querySelector("[data-mct-tooltip]");
  expect(keysOf(tip)).toEqual(["s1", "s0"]);
  expect(texts(tip, "[data-value]")).toEqual(["$10.00", "$1.00"]);
});

// Host-added: each re-render changes exactly one memo input (top, bounds, then cells).
test("the frame follows cells, top and bounds changes after mount", async () => {
  const el = (props) => <><ModelCostTrend title="모델별 비용 추이" xKey="t" bucketHours={24} {...props} /><Selection /></>;
  const { container, rerender } = mount(MAIN);
  await chartReady(container);
  const legend = () => texts(screen.getByRole("list", { name: "범례" }), "li");
  expect(legend()).toEqual(["claude-sonnet-5", "zai.glm-5", "기타 2개 모델"]);
  expect(container.querySelectorAll('[data-state="nodata"]').length).toBe(1);
  const top1 = { ...MAIN, top: 1 };
  rerender(el(top1));
  expect(legend()).toEqual(["claude-sonnet-5", "기타 3개 모델"]);
  const narrow = { ...top1, bounds: { from: BOUNDS.from, to: "2026-09-04T00:00:00.000Z" } };
  rerender(el(narrow));
  expect(container.querySelectorAll('[data-state="nodata"]').length).toBe(0);
  rerender(el({ ...narrow, cells: CODEX }));
  expect(legend()).toEqual(["openai.gpt-6-astra", "기타 3개 모델"]);
});

test("a known $0 timeline beside an unpriced model renders a partial $0 bucket, not a gap", async () => {
  const at = "2026-09-01T00:00:00Z";
  const cells = fromByModelTime({ bucket_hours: 1, effective_range: { from: at, to: "2026-09-01T01:00:00Z" },
    timeseries: [{ client: "claude", t: at, cost_usd: 0, cost_partial: true, unpriced: 1 }],
    by_model_time: [{ client: "claude", t: at, model: "claude-opus-5", backend: "bedrock", cost_usd: null,
      unpriced: 1, unpriced_reasons: { report_zero_with_tokens: 1 } }] }, "claude");
  const { container } = mount({ cells, bucketHours: 1 });
  await chartReady(container);
  expect(container.querySelectorAll('[data-state="partial"]').length).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "표 보기" }));
  const row = container.querySelector("tr[data-bucket]");
  expect(texts(row, "td").slice(1)).toEqual(["— ⚠", "$0", "$0", "부분합"]);
});

test("a pinned model joins the series through the component", async () => {
  const { container } = mount({ ...MAIN, top: 1, pinned: ["zai.glm-5"] });
  await chartReady(container);
  expect(texts(screen.getByRole("list", { name: "범례" }), "li")).toEqual(["claude-sonnet-5", "zai.glm-5", "기타 2개 모델"]);
});

test("without bucketHours, ticks and grid use the global interval (1h here) like zoom", async () => {
  const H = ["2026-09-01 00:00:00", "2026-09-01 01:00:00", "2026-09-01 02:00:00"];
  const { container } = mount({ cells: H.map((t, i) => c(t, "a", "e", i + 1)), bucketHours: undefined,
    bounds: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-01T04:00:00.000Z" } });
  await chartReady(container);
  fireEvent.click(screen.getByRole("button", { name: "표 보기" }));
  const ticks = texts(container, "tr[data-bucket] td:first-child");
  expect([ticks.length, new Set(ticks).size]).toEqual([4, 4]);
});
