import { afterEach, expect, test, vi } from "vitest";
import { streamChat } from "./useChatStream.js";

const sse = events => new Response(
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { status: 200 });
const chart = { type: "bar", title: "모델별 비용", x: "model", x_type: "category", unit: "usd",
  series: [{ key: "cost_usd", label: "비용" }], data: [{ model: "synthetic", cost_usd: null }],
  source: "dashboard", coverage: "canonical", cost_bases: ["client_reported"], truncated: false, partial: true };

afterEach(() => vi.unstubAllGlobals());

test("the stream reader delivers validated chart events and drops malformed ones", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => sse([
    ["status", { message: "분석을 시작하는 중..." }],
    ["chart", chart],
    ["chart", { ...chart, type: "javascript", code: "alert(1)" }],
    ["chart", { ...chart, data: [{ model: "synthetic", cost_usd: "unknown" }] }],
    ["text", { text: "답변" }],
    ["done", {}],
  ])));
  const charts = [], texts = [], statuses = [];
  await streamChat([{ role: "user", content: "질문" }], {
    onText: t => texts.push(t), onStatus: m => statuses.push(m), onChart: c => charts.push(c),
  });
  expect(charts).toEqual([chart]);
  expect(texts).toEqual(["답변"]);
  expect(statuses).toEqual(["분석을 시작하는 중..."]);
});
