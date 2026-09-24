import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import App from "../App.jsx";
import { ConfigProvider } from "../ConfigContext.jsx";
import { setPiiMask } from "../fmt.js";
import { claudeDetail } from "../test/claudeDetail.js";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
let location;
function LocationSpy() { location = useLocation(); return null; }
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300, x: 0, y: 0 });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setPiiMask(true); });

const DAYS = ["2026-09-01", "2026-09-02", "2026-09-03"];
const HOURS = ["2026-09-01 00:00:00", "2026-09-01 01:00:00", "2026-09-01 02:00:00"];
const adoption = DAYS.map((t, i) => ({ t, dau: 1 + i, wau: 2 + i, mau: 3 + i, stickiness: 30 }));
const engagement = HOURS.map((t, i) => ({ t, users: 1 + i, sessions: 2 + i, prs_per_user: 1 }));
const loc = HOURS.map((t, i) => ({ t, group: "bedrock", loc_added: 10 + i, loc_removed: 1 + i }));
// 각 차트를 두 변형으로 본다.
// - idle: 데이터가 도착한 평상시 — 드래그하면 확대되어 URL에 from/to가 실린다.
// - pending: 기간을 바꿨지만 새 응답이 아직 오지 않아 이전 기간의 행을 그대로 보여 주는 상태.
//   이때 유지된 행은 이전 기간의 버킷 크기로 그려졌는데 드래그는 새 기간의 버킷 크기로 계산하므로
//   확대하면 범위가 어긋난다. 따라서 pending에서는 드래그가 무시되어야 한다(오버레이도 없고 URL도 그대로).
// [page, card title, endpoint that feeds it, rows, bar chart?, expected zoom end]
const CHARTS = [
  ["/", "토큰 사용량 추이", "/api/overview/tokens-timeseries", HOURS.map((t, i) => ({ t, group: "bedrock", tokens: 10 + i, input_tokens: 5, output_tokens: 5 })), false, "2026-09-01T03:00:00.000Z"],
  ["/", "활성 사용자 추이", "/api/adoption/timeseries", adoption, false, "2026-09-04T00:00:00.000Z"],
  ["/productivity", "사용자와 세션 추이", "/api/productivity/engagement", engagement, false, "2026-09-01T03:00:00.000Z"],
  ["/productivity", "사용자당 PR", "/api/productivity/engagement", engagement, false, "2026-09-01T03:00:00.000Z"],
  ["/productivity", "추가된 코드 라인 추이", "/api/productivity/loc-timeseries", loc, false, "2026-09-01T03:00:00.000Z"],
  ["/productivity", "제거된 코드 라인 추이", "/api/productivity/loc-timeseries", loc, false, "2026-09-01T03:00:00.000Z"],
  ["/productivity", "활성 사용 시간", "/api/productivity/active-time", HOURS.map((t, i) => ({ t, group: "bedrock", active_seconds: 3600 * (1 + i) })), false, "2026-09-01T03:00:00.000Z"],
  ["/productivity", "프롬프트당 도구 호출 수", "/api/productivity/agenticness", HOURS.map((t, i) => ({ t, group: "bedrock", tool_calls_per_prompt: 1 + i })), false, "2026-09-01T03:00:00.000Z"],
  ["/exec", "일간 활성 사용자", "/api/adoption/timeseries", adoption, false, "2026-09-04T00:00:00.000Z"],
  // Executive's model cost trend defaults to 24h buckets, so its fixture rows are days.
  ["/exec?days=30", "모델별 비용 추이", "/api/cost/by-model-daily", DAYS.map((day) => ({ day, group: "bedrock", model: "m1", cost: 1, reported_cost: 1 })), true, "2026-09-04T00:00:00.000Z"],
  ["/trends", "활성 사용자 (DAU · WAU · MAU)", "/api/adoption/timeseries", adoption, false, "2026-09-04T00:00:00.000Z"],
  ["/trends", "DAU/MAU 고착도", "/api/adoption/timeseries", adoption, false, "2026-09-04T00:00:00.000Z"],
];

function mount(path, endpoint, rows) {
  setPiiMask(false);
  const held = [];
  const gate = { hold: false };
  vi.stubGlobal("fetch", vi.fn((url) => {
    const u = new URL(String(url), "http://localhost");
    if (u.pathname === "/api/health/data") return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "ok", latest: null, ageMinutes: 0, staleAfterMinutes: 360 }) });
    if (u.pathname === endpoint) {
      if (gate.hold) return new Promise((resolve) => held.push({ u, resolve }));
      return Promise.resolve({ ok: true, status: 200, json: async () => rows });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => [] });
  }));
  render(
    <ConfigProvider config={{ piiMask: false, groupMode: "single", schema: {}, pricing: { cacheWriteTtl: "5m", overriddenModels: [] } }}>
      <MemoryRouter initialEntries={[claudeDetail(path)]}><LocationSpy /><App /></MemoryRouter>
    </ConfigProvider>
  );
  return { held, gate };
}
function dragAcross(chart, bar) {
  const grid = chart.querySelector(".recharts-cartesian-grid-horizontal line");
  const left = Number(grid.getAttribute("x1")), right = Number(grid.getAttribute("x2"));
  // 막대 차트는 band 축(칸의 가운데), 선·영역 차트는 point 축(점 위치)이다.
  const x = (i) => bar ? left + (right - left) * (i + 0.5) / 3 : left + (right - left) * i / 2;
  fireEvent.mouseDown(chart, { clientX: x(0), clientY: 60 });
  fireEvent.mouseMove(chart, { clientX: x(2), clientY: 60 });
  const overlays = chart.querySelectorAll(".recharts-reference-area").length;
  fireEvent.mouseUp(chart, { clientX: x(2), clientY: 60 });
  return overlays;
}

const CASES = CHARTS.flatMap(([path, title, endpoint, rows, bar, zoomTo]) => ["idle", "pending"].map((variant) =>
  ({ name: `${path} ${title} ${variant}`, path, title, endpoint, rows, bar, zoomTo, variant })));
test.each(CASES)("$name", async ({ path, title, endpoint, rows, bar, zoomTo, variant }) => {
  // ModelCostTrend clamps the zoom to the selected range; put the fixture days inside it.
  if (title === "모델별 비용 추이") { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-05T12:00:00Z")); }
  const { held, gate } = mount(path, endpoint, rows);
  // 제목 중 일부는 선 라벨 등으로도 페이지에 나타나므로 카드 제목 <div>만 집는다.
  const card = (await screen.findByText(title, { exact: true, selector: "div" })).closest(".rounded-lg");
  await waitFor(() => expect(card.querySelector(".recharts-wrapper")).not.toBeNull());
  if (variant === "pending") {
    gate.hold = true;
    fireEvent.click(screen.getByRole("button", { name: "7일", exact: true }));
    await act(async () => {});
    // 새 기간의 요청은 붙잡혀 있고, 차트는 이전 기간의 행을 유지한 채 그대로 남아 있다.
    expect(held.length).toBe(1);
    expect(card.isConnected).toBe(true);
  }
  const overlays = dragAcross(card.querySelector(".recharts-wrapper"), bar);
  await act(async () => {});
  const params = new URLSearchParams(location.search);
  if (variant === "idle") {
    expect(overlays).toBe(1);
    expect(params.get("from")).toBe("2026-09-01T00:00:00.000Z");
    expect(params.get("to")).toBe(zoomTo);
    expect(screen.queryByTitle("확대 해제")).not.toBeNull();
  } else {
    expect(overlays).toBe(0);
    expect(params.get("from")).toBeNull();
    expect(screen.queryByTitle("확대 해제")).toBeNull();
  }
  vi.useRealTimers();
});
