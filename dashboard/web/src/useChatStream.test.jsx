import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { streamChat, useChatStream } from "./useChatStream.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const chart = { type: "bar", title: "비용", x: "model", unit: "usd",
  series: [{ key: "cost", label: "비용" }], data: [{ model: "synthetic", cost: null }], source: "sql", truncated: false };
const event = (name, value) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
function stubStream(text) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200,
    body: new ReadableStream({ start(controller) {
      const bytes = new TextEncoder().encode(text);
      // Exercise split UTF-8 characters and SSE boundaries.
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    } }),
  })));
}

test("SSE charts survive fragmented UTF-8 transport without becoming answer text", async () => {
  stubStream(event("chart", chart) + event("text", { text: "부분 비용" }) + event("done", {}));
  const onChart = vi.fn(), onText = vi.fn();
  await streamChat([], { onChart, onText, onStatus: vi.fn() });
  expect(onChart).toHaveBeenCalledWith(chart);
  expect(onText).toHaveBeenCalledWith("부분 비용");
});

test("charts stay with their answer and are excluded from later model history", async () => {
  stubStream(event("chart", chart) + event("text", { text: "답변" }) + event("done", {}));
  const { result } = renderHook(() => useChatStream());
  await act(() => result.current.ask("첫 질문"));
  expect(result.current.msgs.at(-1).charts).toEqual([chart]);
  await act(() => result.current.ask("다음 질문"));
  expect(result.current.msgs[1].charts).toEqual([chart]);
  const sent = JSON.parse(fetch.mock.calls.at(-1)[1].body);
  expect(sent.messages.every(m => !("charts" in m))).toBe(true);
  expect(JSON.stringify(sent)).not.toContain('"data"');
});

test("observed charts remain visible when the final writer fails", async () => {
  stubStream(event("chart", chart) + event("error", { message: "synthetic writer failure" }));
  const { result } = renderHook(() => useChatStream());
  await act(() => result.current.ask("첫 질문"));
  expect(result.current.msgs.at(-1).error).toBe(true);
  expect(result.current.msgs.at(-1).charts).toEqual([chart]);
  stubStream(event("text", { text: "다시 답변" }) + event("done", {}));
  await act(() => result.current.ask("다음 질문"));
  expect(result.current.msgs[1].charts).toEqual([chart]);
  const sent = JSON.parse(fetch.mock.calls.at(-1)[1].body);
  expect(JSON.stringify(sent)).not.toContain('"data"');
  expect(JSON.stringify(sent)).not.toContain("synthetic writer failure");
  expect(sent.messages).toEqual([{ role: "user", content: "첫 질문\n다음 질문" }]);
});

test("chart-only turns remain visible without entering model history", async () => {
  stubStream(event("chart", chart) + event("done", {}));
  const { result } = renderHook(() => useChatStream());
  await act(() => result.current.ask("첫 질문"));
  await act(() => result.current.ask("다음 질문"));
  expect(result.current.msgs[1].charts).toEqual([chart]);
  const sent = JSON.parse(fetch.mock.calls.at(-1)[1].body);
  expect(sent.messages).toEqual([{ role: "user", content: "첫 질문\n다음 질문" }]);
});
