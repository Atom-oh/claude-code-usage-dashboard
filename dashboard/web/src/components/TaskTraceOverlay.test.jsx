import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider } from "../ConfigContext.jsx";
import { RefreshProvider } from "../RefreshContext.jsx";
import { RangeProvider } from "../RangeContext.jsx";
import { FilterProvider } from "../FilterContext.jsx";
import { setPiiMask } from "../fmt.js";
import { TaskTraceOverlay } from "./TaskTraceOverlay.jsx";

const USER = "alice@example.test";
const BUCKET = { from: "2026-09-02T00:00:00.000Z", to: "2026-09-03T00:00:00.000Z" };
const CLAUDE_ID = "claude:0123456789abcdef0123456789abcdef";
const CODEX_ID = "codex:conv-1:turn-1";

const tokens = (input, cache_read, cache_write, output) => ({ input, cache_read, cache_write, output });
const claudeDetail = () => ({
  task: { id: CLAUDE_ID, client: "claude", started_at: "2026-09-02T03:00:00.000Z", duration_ms: 120000,
    duration_basis: "interaction_span", models: ["claude-opus-5-5"], llm_calls: 3, subagents: 2,
    tokens: { ...tokens(300, 9000, 600, 900), observed_tokens: 10800, tokens_partial: false },
    cost_usd: 2.5, cost_partial: false, cost_basis: "client_reported" },
  lanes: [
    { id: "main", label: "main", kind: "main", spawned_by: null, llm_calls: 1, cost_usd: 1, cost_partial: false },
    { id: "agent-a", label: "Explore", kind: "Explore", spawned_by: "tool-1", llm_calls: 1, cost_usd: 1.25, cost_partial: false },
    { id: "agent-b", label: null, kind: "custom", spawned_by: null, llm_calls: 1, cost_usd: 0.25, cost_partial: false },
  ],
  spans: [
    { id: "llm-1", parent: null, lane: "main", kind: "llm", name: "claude_code.llm_request", start_ms: 0, duration_ms: 4000,
      attrs: { model: "claude-opus-5-5", ttft_ms: 900, stop_reason: "tool_use", query_source_safe: "repl_main_thread", attempt: 1 },
      tokens: tokens(100, 3000, 200, 300), cost_usd: 1, cost_basis: "client_reported" },
    { id: "tool-1", parent: "llm-1", lane: "main", kind: "tool", name: "claude_code.tool", start_ms: 5000, duration_ms: 60000,
      attrs: { tool_name: "Agent", subagent_type: "Explore", success: true, full_command: "rm -rf /secret/path" } },
    { id: "wait-1", parent: null, lane: "main", kind: "wait", name: "claude_code.tool.blocked_on_user", start_ms: 4500,
      duration_ms: 400, attrs: { decision: "accept", source: "user_temporary" } },
    { id: "llm-2", parent: "tool-1", lane: "agent-a", kind: "llm", name: "claude_code.llm_request", start_ms: 6000,
      duration_ms: 3000, attrs: { model: "claude-opus-5-5" }, tokens: tokens(100, 5000, 300, 400), cost_usd: 1.25,
      cost_basis: "computed" },
    { id: "llm-3", parent: null, lane: "agent-b", kind: "llm", name: "claude_code.llm_request", start_ms: 70000,
      duration_ms: 2000, attrs: { model: "claude-opus-5-5" }, tokens: tokens(100, 1000, 100, 200), cost_usd: 0.25,
      cost_basis: "client_reported" },
  ],
  truncated: false, span_total: 5,
  why: [{ rule: "cache_read_share", value: 0.83 }, { rule: "top_lane_share", value: { lane: "agent-a", share: 0.5 } },
    { rule: "most_expensive_call", value: { span: "llm-2", cost_usd: 1.25 } }, { rule: "retries", value: 0 }],
});
const codexDetail = () => ({
  task: { id: CODEX_ID, client: "codex", started_at: "2026-09-02T04:00:00.000Z", duration_ms: 10000,
    duration_basis: "observed_span_window", models: ["gpt-6.1"], llm_calls: 1, subagents: null,
    tokens: { ...tokens(200, 800, 0, 100), observed_tokens: 1100, tokens_partial: false },
    cost_usd: 0.25, cost_partial: false, cost_basis: "linked_estimate", completions_without_span: 0 },
  lanes: [{ id: "main", label: "main", kind: "main", spawned_by: null, llm_calls: 1, cost_usd: 0.25, cost_partial: false }],
  spans: [{ id: "s1", parent: null, lane: "main", kind: "llm", name: "codex.sampling", start_ms: 0, duration_ms: 5000,
    attrs: { model: "gpt-6.1" }, tokens: tokens(200, 800, 0, 100), cost_usd: 0.25, cost_basis: "linked_estimate",
    completion: { model: "gpt-6.1", effort: "high", ttft_ms: null, duration_ms: 4800, count: 1 } }],
  truncated: false, span_total: 1,
  why: [{ rule: "most_expensive_call", value: { span: null, cost_usd: 0.25 } }],
});

let fetchMock, body;
beforeEach(() => {
  body = claudeDetail();
  fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setPiiMask(true);
});

const mount = (props = {}) => render(
  <MemoryRouter>
    <ConfigProvider config={{ piiMask: true }}>
      <RefreshProvider><RangeProvider><FilterProvider>
        <TaskTraceOverlay taskId={CLAUDE_ID} user={USER} from={BUCKET.from} to={BUCKET.to} onClose={() => {}} {...props} />
      </FilterProvider></RangeProvider></RefreshProvider>
    </ConfigProvider>
  </MemoryRouter>,
);
const detailRequests = () => fetchMock.mock.calls.map(([url]) => new URL(String(url), "http://localhost"))
  .filter((u) => u.pathname === "/api/users/tasks/detail");
const panel = () => screen.getByRole("region", { name: "선택한 span 상세" });

test("requests the detail with the bucket bounds and exact user, never the raw identity in the DOM", async () => {
  mount();
  await screen.findByRole("group", { name: "메인 세션 레인" });
  const [req] = detailRequests();
  expect(req.searchParams.get("id")).toBe(CLAUDE_ID);
  expect(req.searchParams.get("from")).toBe(BUCKET.from);
  expect(req.searchParams.get("to")).toBe(BUCKET.to);
  expect(req.searchParams.get("userExact")).toBe(USER);
  expect(req.searchParams.has("team")).toBe(false);
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).not.toContain(USER);
  expect(dialog.textContent).not.toContain("0123456789abcdef");
  expect(screen.getByText("부분 수집")).toBeTruthy();
});

test("renders one lane per subagent with labels", async () => {
  mount();
  const lanes = await screen.findAllByRole("group", { name: /레인$/ });
  expect(lanes).toHaveLength(3);
  expect(within(lanes[0]).getByText("메인 세션")).toBeTruthy();
  expect(within(lanes[0]).getByText("1 호출 · $1")).toBeTruthy();
  expect(within(lanes[1]).getByText("Explore")).toBeTruthy();
  expect(within(lanes[1]).getByText("1 호출 · $1.25")).toBeTruthy();
  // A lane whose spawning span is missing gets a neutral label, not a named custom agent.
  expect(within(lanes[2]).getByText("서브에이전트")).toBeTruthy();
  // Spawn connector for the lane whose spawning span is present only.
  expect(document.querySelectorAll("[data-spawn]")).toHaveLength(1);
  expect(screen.getByText("왜 많이 썼나")).toBeTruthy();
  expect(screen.getByText(/cache read 83%/)).toBeTruthy();
  expect(screen.getByText(/Explore.*50%/)).toBeTruthy();
});

test("clicking an llm bar shows tokens and cost basis", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "LLM 호출 #2 · Explore" }));
  const p = panel();
  expect(within(p).getByText("LLM 호출 #2")).toBeTruthy();
  expect(within(p).getByText("5,000")).toBeTruthy(); // cache read
  expect(within(p).getByText("5,400")).toBeTruthy(); // context = input + cache read + cache write
  expect(within(p).getByText("$1.25")).toBeTruthy();
  expect(within(p).getByText("계산 추정")).toBeTruthy();
  // The why rule links to the same call.
  fireEvent.click(screen.getByRole("button", { name: "LLM 호출 #1 · 메인 세션" }));
  expect(within(panel()).getByText("tool_use")).toBeTruthy();
  expect(within(panel()).getByText("클라이언트 보고")).toBeTruthy();
});

test("codex bar shows not collected for TTFT breakdown", async () => {
  body = codexDetail();
  mount({ taskId: CODEX_ID });
  fireEvent.click(await screen.findByRole("button", { name: "LLM 호출 #1 · 메인 세션" }));
  const p = panel();
  const row = (label) => within(p).getByText(label).nextElementSibling.textContent;
  expect(row("TTFT")).toBe("미수집");
  expect(row("호출 출처")).toBe("미수집");
  expect(row("종료 사유")).toBe("미수집");
  expect(row("effort")).toBe("high");
  expect(within(p).getByText("연결 추정")).toBeTruthy();
  // most_expensive_call without a span still renders, without a link.
  expect(screen.getByText(/가장 비싼 호출/).textContent).toContain("$0.25");
});

test("truncated detail shows banner and hides totals", async () => {
  body = { ...claudeDetail(), truncated: true, span_total: 9000, why: [],
    task: { ...claudeDetail().task, llm_calls: null, subagents: null, tokens: null, cost_usd: null, cost_partial: true, cost_basis: null },
    lanes: claudeDetail().lanes.map((l) => ({ ...l, llm_calls: null, cost_usd: null, cost_partial: true })) };
  mount();
  expect(await screen.findByText("일부 span만 표시 — 전체 합계 미표시")).toBeTruthy();
  expect(screen.queryByText("총 토큰")).toBeNull();
  expect(screen.queryByText(/누적 비용/)).toBeNull();
  expect(screen.queryByText(/\$0(\.00)?$/)).toBeNull();
  expect(screen.queryByText(/호출 · \$/)).toBeNull();
});

test("no forbidden fields rendered even if present in payload", async () => {
  body.spans = body.spans.map((s) => ({ ...s, attrs: { ...s.attrs, full_command: "rm -rf /secret/path",
    file_path: "/home/secret/file.txt", user_prompt: "secret prompt" }, user_prompt: "top secret" }));
  mount();
  await screen.findByRole("group", { name: "메인 세션 레인" });
  for (const name of [/LLM 호출 #1/, /Agent/, /권한 대기/]) {
    fireEvent.click(screen.getAllByRole("button", { name })[0]);
    const html = document.body.innerHTML;
    for (const secret of ["rm -rf", "/secret", "secret prompt", "top secret", "full_command", "file_path"])
      expect(html).not.toContain(secret);
  }
});

test("Escape and the close button call onClose", async () => {
  const onClose = vi.fn();
  mount({ onClose });
  await screen.findByRole("group", { name: "메인 세션 레인" });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(onClose).toHaveBeenCalledTimes(2);
});

test("cost band tooltip shows per-lane cumulative cost on hover", async () => {
  mount();
  const band = await screen.findByRole("img", { name: /누적 비용/ });
  vi.spyOn(band, "getBoundingClientRect").mockReturnValue({ left: 0, width: 900, top: 0, height: 150, right: 900, bottom: 150 });
  fireEvent.mouseMove(band.querySelector("[data-band-hit]"), { clientX: 899, clientY: 50 });
  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toContain("$2.5");
  expect(tip.textContent).toContain("Explore $1.25");
});

test("not found renders an error, not totals", async () => {
  fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 404, json: async () => ({ error: "not found" }) }));
  mount();
  await waitFor(() => expect(screen.queryByText("메인 세션")).toBeNull());
  expect(await screen.findByText("데이터를 불러오지 못했습니다.")).toBeTruthy();
  expect(screen.queryByText("총 토큰")).toBeNull();
});

test("cost band legend keeps every lane inside the viewBox with many subagents", async () => {
  const base = claudeDetail();
  const extra = Array.from({ length: 7 }, (_, i) => ({ id: `agent-x${i}`, label: "general-purpose", kind: "general-purpose",
    spawned_by: null, llm_calls: 1, cost_usd: 0.1, cost_partial: false }));
  const extraSpans = extra.map((l, i) => ({ id: `llm-x${i}`, parent: null, lane: l.id, kind: "llm", name: "claude_code.llm_request",
    start_ms: 80000 + i * 1000, duration_ms: 500, attrs: {}, tokens: tokens(1, 1, 1, 1), cost_usd: 0.1, cost_basis: "client_reported" }));
  body = { ...base, lanes: [...base.lanes, ...extra], spans: [...base.spans, ...extraSpans] };
  mount();
  const band = await screen.findByRole("img", { name: /누적 비용/ });
  const [, , , viewH] = band.getAttribute("viewBox").split(" ").map(Number);
  const rows = band.querySelectorAll("[data-band-lane]");
  expect(rows).toHaveLength(10);
  for (const row of rows) {
    const swatch = row.querySelector("[data-band-legend]");
    const bottom = Number(swatch.getAttribute("y")) + Number(swatch.getAttribute("height"));
    expect(bottom).toBeLessThanOrEqual(viewH);
    for (const label of row.querySelectorAll("text")) expect(Number(label.getAttribute("y"))).toBeLessThanOrEqual(viewH);
    expect(row.querySelectorAll("text")[1].textContent).toMatch(/^\$/);
  }
});

test("a keyboard-focused bar draws a visible focus ring", async () => {
  mount();
  const bar = await screen.findByRole("button", { name: "LLM 호출 #2 · Explore" });
  expect(bar.style.stroke).toBe("none");
  fireEvent.focus(bar);
  expect(bar.hasAttribute("data-focused")).toBe(true);
  expect(bar.style.stroke).toBe("var(--brand-600)");
  fireEvent.keyDown(bar, { key: "Enter" });
  expect(within(panel()).getByText("LLM 호출 #2")).toBeTruthy();
  fireEvent.blur(bar);
  expect(bar.hasAttribute("data-focused")).toBe(false);
  expect(bar.style.stroke).toBe("var(--ink-800)"); // selected, no longer focused
});
