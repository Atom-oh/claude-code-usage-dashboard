import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Analytics from "./Analytics.jsx";
import { ConfigProvider } from "../ConfigContext.jsx";

// 7일 구간 — 프리셋 문구의 days가 7로 고정된다.
vi.mock("../RangeContext.jsx", () => ({
  useRange: () => ({ from: new Date("2026-10-06T00:00:00Z"), to: new Date("2026-10-13T00:00:00Z") }),
}));

const PLACEHOLDER = "예) ojs0106의 최근 3시간 사용은 뭐였고 주로 어떤 툴에서 동작했어?";
const TOOL_PRESET = "최근 7일간 사용자별로 가장 많이 쓴 도구(tool_name)와 클라이언트(Claude/Codex)를 알려줘";

function mount({ embedded = false, permissions } = {}) {
  // 스트림은 끝나지 않게 둔다 — 요청 본문과 대기 중 화면만 본다.
  const fetchMock = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetchMock);
  const session = permissions && { mode: "oidc", name: "Fixture", role: "viewer",
    expiresAt: new Date(Date.now() + 900_000).toISOString(), permissions };
  render(<ConfigProvider config={session ? { session } : undefined}><Analytics embedded={embedded} /></ConfigProvider>);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("the question input renders above the presets before any message", () => {
  mount();
  const input = screen.getByPlaceholderText(PLACEHOLDER);
  const preset = screen.getByRole("button", { name: TOOL_PRESET });
  expect(input.compareDocumentPosition(preset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText("사용자 · 도구")).toBeTruthy();
  expect(screen.getByRole("button", { name: "특정 사용자의 최근 3시간 사용 내역과 주로 사용한 도구를 요약해줘 (예: ojs0106)" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "질문 보내기" }).disabled).toBe(true);
});

test("submitting typed text asks the chat API and keeps the input above the transcript", async () => {
  const fetchMock = mount();
  const question = "alice의 최근 3시간 도구 사용을 알려줘";
  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "질문 보내기" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/chat");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ messages: [{ role: "user", content: question }] });
  const input = screen.getByPlaceholderText(PLACEHOLDER);
  expect(input.value).toBe("");
  const bubble = screen.getByText(question);
  expect(input.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a preset sends its text unchanged", async () => {
  const fetchMock = mount();
  fireEvent.click(screen.getByRole("button", { name: TOOL_PRESET }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages).toEqual([{ role: "user", content: TOOL_PRESET }]);
});

test("embedded chat omits the page header and renders nothing without chat:query", () => {
  mount({ embedded: true });
  expect(screen.getByRole("region", { name: "데이터 질문" })).toBeTruthy();
  expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Analytics" })).toBeNull();
  cleanup();
  mount({ embedded: true, permissions: ["telemetry:read"] });
  expect(screen.queryByRole("region", { name: "데이터 질문" })).toBeNull();
  expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
  expect(screen.queryByText(/SQL 채팅은/)).toBeNull();
});
