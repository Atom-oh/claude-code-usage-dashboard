import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import ProductivitySignals from "./ProductivitySignals.jsx";
import { useApi } from "../useApi.js";

vi.mock("../useApi.js", () => ({ useApi: vi.fn() }));

const response = (data) => ({ data, loading: false, error: null, stale: false });
function mount(overrides = {}) {
  const endpoints = {
    "/api/productivity/activity-density": response([{ group: "bedrock", matched_commits: 4, user_hours: 2,
      commits_per_user_hour: 2, observed_scopes: 3, matched_scopes: 1, coverage: 1 / 3 }]),
    "/api/productivity/tool-outcomes": response([{ group: "bedrock", total: 5, succeeded: 1, failed: 2,
      unknown: 2, success_rate: 1 / 3, unknown_rate: 0.4 }]),
    "/api/productivity/permission-occupancy": response({ unsupported: false, rows: [{ group: "bedrock",
      interactions: 2, matched_interactions: 1, ambiguous_interactions: 0,
      blocked_ms: 60, interaction_ms: 100, blocked_share: 0.6, coverage: 0.5 }] }),
    ...overrides,
  };
  useApi.mockImplementation((path) => endpoints[path]);
  return render(<ProductivitySignals />);
}
const table = (title) => screen.getByText(title, { exact: true }).closest(".bg-card");

afterEach(() => { cleanup(); vi.clearAllMocks(); });

test("signals show coverage and the known-outcome denominator beside independent measurements", () => {
  mount();
  expect(within(table("관측 활동 밀도")).getByText("33.3%")).toBeTruthy();
  expect(within(table("관측 도구 실행 성공률")).getByText("33.3%")).toBeTruthy();
  expect(within(table("관측 도구 실행 성공률")).getByText("40.0%")).toBeTruthy();
  expect(within(table("관측 권한 대기 점유율")).getByText("60.0%")).toBeTruthy();
  expect(screen.getByText(/작업 ID와 시작·완료 시각/)).toBeTruthy();
});

test("unknown outcomes and unobserved wait time remain unavailable instead of zero", () => {
  mount({
    "/api/productivity/tool-outcomes": response([{ group: "bedrock", total: 3, succeeded: 0,
      failed: 0, unknown: 3, success_rate: null, unknown_rate: 1 }]),
    "/api/productivity/permission-occupancy": response({ unsupported: false, rows: [{ group: "bedrock",
      interactions: 3, matched_interactions: 0, ambiguous_interactions: 0,
      blocked_ms: null, interaction_ms: null, blocked_share: null, coverage: 0 }] }),
  });
  expect(within(table("관측 도구 실행 성공률")).getByText("—")).toBeTruthy();
  expect(within(table("관측 도구 실행 성공률")).getByText("100.0%")).toBeTruthy();
  expect(within(table("관측 권한 대기 점유율")).getAllByText("—")).toHaveLength(3);
});

test("an observed zero success rate stays zero", () => {
  mount({ "/api/productivity/tool-outcomes": response([{ group: "bedrock", total: 2, succeeded: 0,
    failed: 2, unknown: 0, success_rate: 0, unknown_rate: 0 }]) });
  expect(within(table("관측 도구 실행 성공률")).getAllByText("0.0%")).toHaveLength(2);
});

test("query limits withhold permission ratios while other panels remain usable", () => {
  mount({ "/api/productivity/permission-occupancy": response({ unsupported: false, limited: true, rows: [] }) });
  expect(screen.getByRole("status").textContent).toContain("계산하지 않았습니다");
  expect(within(table("관측 도구 실행 성공률")).getByText("33.3%")).toBeTruthy();
});

test("unsupported trace data and query errors remain distinct", () => {
  mount({
    "/api/productivity/permission-occupancy": response({ unsupported: true, rows: [] }),
    "/api/productivity/activity-density": { ...response(null), error: new Error("unavailable") },
  });
  expect(screen.getByText("이 기간에는 계산 가능한 인터랙션 스팬이 없습니다")).toBeTruthy();
  expect(screen.getByText("데이터를 불러오지 못했습니다.")).toBeTruthy();
  expect(within(table("관측 도구 실행 성공률")).getByText("33.3%")).toBeTruthy();
});
