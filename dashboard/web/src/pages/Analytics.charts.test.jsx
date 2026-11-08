import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Analytics from "./Analytics.jsx";
import { ConfigProvider } from "../ConfigContext.jsx";

vi.mock("../RangeContext.jsx", () => ({
  useRange: () => ({ from: new Date("2026-10-06T00:00:00Z"), to: new Date("2026-10-13T00:00:00Z") }),
}));
// Recharts needs a measured browser box; this test checks the data contract and placement.
vi.mock("recharts", () => {
  const Wrapper = ({ children }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Wrapper, BarChart: Wrapper, LineChart: Wrapper,
    CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null,
    Legend: () => null, Bar: () => null, Line: () => null,
  };
});

const PLACEHOLDER = "예) 최근 3시간 동안 가장 많이 사용한 도구는 무엇인가요?";
const CHART = { type: "line", title: "일별 비용", x: "t", x_type: "time", unit: "usd",
  series: [{ key: "cost_usd", label: "비용" }],
  data: [{ t: "2026-10-06 00:00:00", cost_usd: 1.5 }, { t: "2026-10-07 00:00:00", cost_usd: null }],
  source: "dashboard", coverage: "canonical", cost_bases: ["client_reported"], truncated: false, partial: true };
const sse = events => new Response(
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { status: 200 });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("Analytics renders chart events with the answer, keeps them, and resends text only", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(sse([["chart", CHART], ["text", { text: "답변" }], ["done", {}]]))
    .mockResolvedValueOnce(sse([["text", { text: "두 번째 답변" }], ["done", {}]]));
  vi.stubGlobal("fetch", fetchMock);
  render(<ConfigProvider><Analytics /></ConfigProvider>);
  const input = screen.getByPlaceholderText(PLACEHOLDER);
  fireEvent.change(input, { target: { value: "첫 질문" } });
  fireEvent.click(screen.getByRole("button", { name: "질문 보내기" }));
  await waitFor(() => expect(screen.getByText("답변")).toBeTruthy());
  expect(screen.getByRole("figure")).toBeTruthy();
  expect(screen.getByText("일별 비용")).toBeTruthy();
  expect(screen.getByText(/클라이언트 보고/)).toBeTruthy();
  expect(screen.getByText(/부분 집계/)).toBeTruthy();

  fireEvent.change(input, { target: { value: "다음 질문" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "질문 보내기" }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "질문 보내기" }));
  await waitFor(() => expect(screen.getByText("두 번째 답변")).toBeTruthy());
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ messages: [
    { role: "user", content: "첫 질문" }, { role: "assistant", content: "답변" }, { role: "user", content: "다음 질문" },
  ] });
  expect(screen.getAllByRole("figure")).toHaveLength(1);
});
