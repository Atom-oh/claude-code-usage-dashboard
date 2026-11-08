import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FloatingChat } from "./FloatingChat.jsx";

vi.mock("recharts", () => {
  const Wrapper = ({ children }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Wrapper, BarChart: Wrapper, LineChart: Wrapper,
    CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null,
    Legend: () => null, Bar: () => null, Line: () => null,
  };
});

const CHART = { type: "stacked_bar", title: "모델별 토큰", x: "model", unit: "tokens",
  series: [{ key: "input_tokens", label: "입력" }, { key: "output_tokens", label: "출력" }],
  data: [{ model: "synthetic-a", input_tokens: 10, output_tokens: 2 }, { model: "synthetic-b", input_tokens: null, output_tokens: 1 }],
  source: "sql", coverage: "unverified", cost_bases: [], truncated: true, partial: false };
const sse = events => new Response(
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { status: 200 });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("the floating widget renders chart events and keeps a chart received before a later error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => sse([["chart", CHART], ["error", { message: "모델 접근 권한이 없습니다." }]])));
  render(<FloatingChat />);
  fireEvent.click(screen.getByRole("button", { name: "Ask Claude" }));
  fireEvent.click(screen.getByRole("button", { name: "세션 수가 가장 많은 사용자 5명은?" }));
  await waitFor(() => expect(screen.getByText(/응답을 받지 못했습니다: 모델 접근 권한이 없습니다\./)).toBeTruthy());
  expect(screen.getByRole("figure")).toBeTruthy();
  expect(screen.getByText("모델별 토큰")).toBeTruthy();
  expect(screen.getByText(/커버리지 미확인/)).toBeTruthy();
  expect(screen.getByText(/표시 행 제한/)).toBeTruthy();
});
