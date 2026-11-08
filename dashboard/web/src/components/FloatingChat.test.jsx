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

test("the floating window can be resized from its corner handle, by keyboard and with the expand toggle", () => {
  localStorage.clear();
  vi.stubGlobal("innerWidth", 1600);
  vi.stubGlobal("innerHeight", 1000);
  render(<FloatingChat />);
  fireEvent.click(screen.getByRole("button", { name: "Ask Claude" }));
  const dialog = screen.getByRole("dialog", { name: "Ask Claude" });
  expect([dialog.style.width, dialog.style.height]).toEqual(["400px", "520px"]);

  const handle = screen.getByRole("separator", { name: /채팅 창 크기 조절/ });
  fireEvent.pointerDown(handle, { clientX: 1000, clientY: 400, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 700, clientY: 300, pointerId: 1 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect([dialog.style.width, dialog.style.height]).toEqual(["700px", "620px"]);
  expect(JSON.parse(localStorage.getItem("ccdash.chatWindowSize"))).toEqual({ w: 700, h: 620 });

  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  fireEvent.keyDown(handle, { key: "ArrowDown", shiftKey: true });
  expect([dialog.style.width, dialog.style.height]).toEqual(["720px", "540px"]);

  fireEvent.click(screen.getByRole("button", { name: "창 크게 보기" }));
  expect([dialog.style.width, dialog.style.height]).toEqual(["960px", "888px"]);
  fireEvent.click(screen.getByRole("button", { name: "창 크기 되돌리기" }));
  expect([dialog.style.width, dialog.style.height]).toEqual(["720px", "540px"]);
});

test("a remembered window size is restored when the widget opens again", () => {
  localStorage.setItem("ccdash.chatWindowSize", JSON.stringify({ w: 820, h: 700 }));
  vi.stubGlobal("innerWidth", 1600);
  vi.stubGlobal("innerHeight", 1000);
  render(<FloatingChat />);
  fireEvent.click(screen.getByRole("button", { name: "Ask Claude" }));
  const dialog = screen.getByRole("dialog", { name: "Ask Claude" });
  expect([dialog.style.width, dialog.style.height]).toEqual(["820px", "700px"]);
  localStorage.clear();
});
