import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as csv from "../csv.js";
import CodexInsights from "./CodexInsights.jsx";

const state = vi.hoisted(() => ({ result: {}, calls: [] }));
vi.mock("../useApi.js", () => ({ useApi: (...args) => { state.calls.push(args); return state.result; } }));
afterEach(() => { cleanup(); state.calls = []; vi.restoreAllMocks(); });
const fixture = () => ({
  coverage: { logs: { status: "observed", records: 8 }, metrics: { status: "empty", records: 0 },
    traces: { status: "unavailable", records: 0 } },
  summary: { cache_hit_rate: 0.25, cache_write_share: 0.1, reasoning_share: 0.5,
    cost_per_request: null, cost_per_session: 0.0001, tokens_per_request: 200 },
  effort: [{ effort: "high", requests: 2, tokens: 400, cost_usd: null, unpriced: 1 }],
  latency: [], tools: [], approvals: [], runtime: [], events: [], metrics: [], spans: [], traces: [],
  limitations: ["Diagnostic signals are not billing inputs."],
});
function show(data = fixture()) {
  state.result = { data, loading: false, error: null };
  return render(<CodexInsights />);
}
test("efficiency distinguishes unpriced cost from measured ratios and tiny prices", () => {
  show();
  expect(screen.getByText("25%")).toBeTruthy();
  expect(screen.getByText("50%")).toBeTruthy();
  expect(screen.getByText("$0.0001")).toBeTruthy();
  expect(screen.getByText("요청당 추정 비용").closest(".shadow-card").textContent).toContain("—");
  expect(screen.getByText("high")).toBeTruthy();
  expect(screen.getByText("Metrics · 관측 없음")).toBeTruthy();
  expect(screen.getByText("Traces · 수집 미확인")).toBeTruthy();
});
test.each([0.012, 0])("partial Codex unit costs and effort CSV preserve known cost %s", (cost_usd) => {
  const data = fixture();
  data.summary = { ...data.summary, cost_partial: true, unpriced: 2,
    cost_per_request: cost_usd / 3, cost_per_session: null, tokens_per_request: null };
  data.effort = [
    { effort: "high", requests: 3, tokens: null, cost_usd, cost_partial: true, unpriced: 2 },
    { effort: "unknown", requests: 1, tokens: null, cost_usd: null, cost_partial: true, unpriced: 1 },
  ];
  const download = vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
  show(data);
  const request = screen.getByText("요청당 추정 비용").closest(".shadow-card");
  expect(request.textContent).toContain(`$${cost_usd / 3}`);
  expect(request.textContent).toContain("AWS 정가 추정 · 부분합 · 미산정 2건 제외");
  expect(screen.getByText("세션당 추정 비용").closest(".shadow-card").textContent).toContain("—");
  expect(screen.getByText("요청당 토큰").closest(".shadow-card").textContent).toContain("—");
  const table = screen.getByText("Effort별 사용량·비용").closest(".shadow-card");
  expect(table.textContent).toContain("부분합");
  expect(table.textContent).toContain("알려진 비용");
  fireEvent.click(within(table).getByRole("button", { name: "CSV" }));
  const exported = download.mock.calls[0][1];
  expect(exported).toContain("AWS 정가 추정 · 부분합 · 미산정 2건 제외");
  expect(exported).toContain("AWS 정가 추정 · 미산정");
  expect(exported.split("\r\n")[1]).toContain(`high,3,,${cost_usd},`);
  expect(exported.split("\r\n")[2]).toContain("unknown,1,,,");
});
test("effort retains a separate numeric unpriced column in the table and CSV", () => {
  const data = fixture();
  data.effort = [
    { effort: "high", cost_usd: 0.012, cost_partial: true, unpriced: 2 },
    { effort: "free", cost_usd: 0, cost_partial: false, unpriced: 0 },
    { effort: "unknown", cost_usd: null, cost_partial: true, unpriced: null },
  ];
  const download = vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
  show(data);
  const table = screen.getByText("Effort별 사용량·비용").closest(".shadow-card");
  const headers = within(table).getAllByRole("columnheader").map((node) => node.textContent.replace("↕", ""));
  const unpricedIndex = headers.indexOf("미산정");
  expect(unpricedIndex).toBeGreaterThanOrEqual(0);
  expect(headers).toContain("비용 기준·미산정");
  expect(within(table).getAllByRole("row").slice(1).map((row) =>
    within(row).getAllByRole("cell")[unpricedIndex].textContent)).toEqual(["2", "0", "—"]);
  fireEvent.click(within(table).getByRole("button", { name: "CSV" }));
  const exported = download.mock.calls[0][1];
  expect(exported.split("\r\n").slice(1).map((row) => row.split(",")[unpricedIndex])).toEqual(["2", "0", ""]);
  expect(exported).toContain("AWS 정가 추정 · 부분합 · 미산정 2건 제외");
});
test("metric catalog supports search and marks incomplete intervals without invented totals", () => {
  const data = fixture();
  data.metrics = [
    { name: "codex.turn.e2e_duration_ms", type: "histogram", unit: "ms", dimensions: { model: "model-a" },
      points: 2, count: 3, mean: 10, sum: 30, partial: false },
    { name: "codex.tool.call", type: "sum", dimensions: { tool: "shell" }, points: 1, value: null, partial: true },
  ];
  show(data);
  fireEvent.click(screen.getByRole("button", { name: "런타임·메트릭" }));
  expect(screen.getByText("codex.tool.call")).toBeTruthy();
  expect(screen.getByText("불완전")).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("메트릭 이름 검색"), { target: { value: "e2e" } });
  expect(screen.queryByText("codex.tool.call")).toBeNull();
  expect(screen.getByText("codex.turn.e2e_duration_ms")).toBeTruthy();
});
test("trace detail exposes parent relationships and labels an observed window", () => {
  const data = fixture();
  data.traces = [{ trace_id: "trace-one", start_time: "2026-09-15T00:00:00Z", span_count: 1, wall_ms: 4, errors: 0,
    spans: [{ span_id: "child", parent_span_id: "parent", name: "exec_command",
      start_time: "2026-09-15T00:00:00Z", duration_ms: 4, status: "Unset" }] }];
  show(data);
  fireEvent.click(screen.getByRole("button", { name: "Trace" }));
  expect(screen.getByText(/최근 50개 Trace의 각 최근 200개 span/)).toBeTruthy();
  fireEvent.click(screen.getByText(/trace-one/, { selector: "summary" }));
  expect(screen.getByText("parent")).toBeTruthy();
  expect(screen.getByText("exec_command")).toBeTruthy();
});
test("insight errors and loading are visible independently of overview data", () => {
  state.result = { loading: true };
  const { rerender } = render(<CodexInsights />);
  expect(screen.getByText("불러오는 중...")).toBeTruthy();
  state.result = { error: new Error("Unavailable") };
  rerender(<CodexInsights />);
  expect(screen.getByText("데이터를 불러오지 못했습니다.")).toBeTruthy();
});
test("bounded trace previews disclose omitted spans and unavailable whole-trace totals", () => {
  const data = fixture();
  data.coverage.traces = { status: "observed", records: 200, truncated_traces: 1 };
  data.traces = [{ trace_id: "long-trace", span_count: 200, wall_ms: null, errors: null,
    truncated: true, spans: [] }];
  show(data);
  fireEvent.click(screen.getByRole("button", { name: "Trace" }));
  expect(screen.getByText(/긴 Trace는 일부 span만 표시/)).toBeTruthy();
  expect(screen.getByText(/long-trace/, { selector: "summary" }).textContent)
    .toContain("200 spans · — ms · 오류 — · 최근 span만 표시");
});
test("query-limited signals are distinguished from absent telemetry", () => {
  const data = fixture();
  data.coverage.logs = { status: "limited", records: null };
  data.summary = {};
  show(data);
  expect(screen.getByText("Logs · 조회 한도 초과")).toBeTruthy();
  expect(screen.getByText(/일부 상세 신호가 조회 한도를 넘었습니다/)).toBeTruthy();
  expect(screen.getByText("요청당 추정 비용").closest(".shadow-card").textContent).toContain("—");
});

test("turn summaries weight histogram observations and withhold partial measurements", () => {
  const data = fixture();
  data.metrics = [
    { name: "codex.turn.e2e_duration_ms", count: 2, sum: 100, mean: 50 },
    { name: "codex.turn.e2e_duration_ms", count: 1, sum: 20, mean: 20 },
    { name: "codex.turn.tool.call", count: 1, sum: null, partial: true },
  ];
  show(data);
  fireEvent.click(screen.getByRole("button", { name: "성능" }));
  expect(screen.getByText("평균 턴 처리 시간").closest(".shadow-card").textContent).toContain("40 ms");
  expect(screen.getByText("턴당 평균 도구 호출").closest(".shadow-card").textContent).toContain("—");
});

test("shared effective bounds reach the API and a paused overview preserves detail controls", () => {
  state.result = { data: fixture(), loading: false };
  const range = { from: "2026-09-01T00:00:00Z", to: "2026-09-02T10:00:00Z" };
  const { rerender } = render(<CodexInsights range={range} enabled />);
  expect(state.calls.at(-1)).toEqual(["/api/codex/insights", { client: "codex", ...range }, true, { linkedRange: true }]);
  fireEvent.click(screen.getByRole("button", { name: "런타임·메트릭" }));
  fireEvent.change(screen.getByPlaceholderText("메트릭 이름 검색"), { target: { value: "turn" } });
  rerender(<CodexInsights range={range} enabled={false} />);
  expect(screen.getByText("불러오는 중...")).toBeTruthy();
  rerender(<CodexInsights range={range} enabled />);
  expect(screen.getByPlaceholderText("메트릭 이름 검색").value).toBe("turn");
});

test("partial extrema annotate a valid mean and conflicting traces withhold their detail", () => {
  const data = fixture();
  data.metrics = [{ name: "codex.turn.e2e_duration_ms", count: 2, sum: 100, partial: true, min: null, max: null }];
  data.coverage.traces = { status: "observed", records: 1, partial: true };
  data.traces = [{ trace_id: "conflict", span_count: null, wall_ms: null, errors: null, spans: [], partial: true }];
  show(data);
  fireEvent.click(screen.getByRole("button", { name: "성능" }));
  const tile = screen.getByText("평균 턴 처리 시간").closest(".shadow-card");
  expect(tile.textContent).toContain("50 ms");
  expect(tile.textContent).toContain("일부 원본 통계 미확인");
  fireEvent.click(screen.getByRole("button", { name: "Trace" }));
  expect(screen.getByRole("status").textContent).toContain("충돌");
  expect(screen.getByText(/같은 Span ID/)).toBeTruthy();
});

test("route sections expose only relevant details and choose a valid tab after navigation", () => {
  state.result = { data: fixture(), loading: false };
  const { rerender } = render(<CodexInsights sections={["성능"]} />);
  expect(screen.getByText("요청·도구·시작 단계 지연")).toBeTruthy();
  expect(screen.queryByText("Effort별 사용량·비용")).toBeNull();
  expect(screen.queryByRole("button", { name: "런타임·메트릭" })).toBeNull();
  rerender(<CodexInsights sections={["런타임·메트릭", "Trace"]} />);
  expect(screen.getByPlaceholderText("메트릭 이름 검색")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Trace", exact: true }));
  expect(screen.getByText("작업별 Span 지연")).toBeTruthy();
});
