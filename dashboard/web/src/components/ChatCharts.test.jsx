import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatCharts } from "./ChatCharts.jsx";

// Inspect the real component's data contract without browser layout dependence.
vi.mock("recharts", () => {
  const Wrapper = ({ children }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Wrapper, BarChart: Wrapper, LineChart: Wrapper,
    CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null,
    Legend: () => null, Bar: () => null, Line: () => null,
  };
});
afterEach(cleanup);
const chart = { type: "stacked_bar", title: "모델별 비용", x: "model", unit: "usd",
  series: [{ key: "cost", label: "비용" }], data: [{ model: "synthetic", cost: null }, { model: "other", cost: 0 }],
  source: "sql", truncated: true, partial: true, coverage: "unverified" };

test("charts provide an accessible numeric table distinguishing unknown from zero", () => {
  render(<ChatCharts charts={[chart]} />);
  expect(screen.getByText("모델별 비용")).toBeTruthy();
  expect(screen.getByText(/표시 행 제한/)).toBeTruthy();
  expect(screen.getByText(/부분 집계/)).toBeTruthy();
  expect(screen.getByText(/커버리지 미확인/)).toBeTruthy();
  expect(screen.getByText(/알 수 없음/)).toBeTruthy();
  expect(screen.getByText("$0.00")).toBeTruthy();
  // The table sits inside a collapsed <details>; query regardless of jsdom's visibility model.
  expect(screen.getByRole("table", { hidden: true })).toBeTruthy();
});

test("cost chart labels include the actual contributing bases", () => {
  render(<ChatCharts charts={[{ ...chart, source: "dashboard", coverage: "canonical",
    cost_bases: ["client_reported", "aws_list_estimate"] }]} />);
  expect(screen.getByText(/클라이언트 보고/)).toBeTruthy();
  expect(screen.getByText(/AWS 정가 추정/)).toBeTruthy();
});

test("model supplied code, malformed data and unbounded charts are rejected", () => {
  const { container } = render(<ChatCharts charts={[
    { ...chart, type: "javascript", code: "alert(1)" },
    { ...chart, data: [{ model: "synthetic", cost: "unknown" }] },
  ]} />);
  expect(container.textContent).toBe("");
});
