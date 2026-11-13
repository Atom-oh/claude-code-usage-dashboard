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
  context: { points: [{ span: "llm-1", lane: "main", start_ms: 0, tokens: 3300 },
    { span: "llm-2", lane: "agent-a", start_ms: 6000, tokens: 5400 },
    { span: "llm-3", lane: "agent-b", start_ms: 70000, tokens: 1200 }], missing: 0, partial: false,
  compactions: [{ start_ms: 50000, pre_tokens: 320000, post_tokens: 41000, trigger: "auto", success: true }], limits: null },
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
  context: { points: [{ span: "s1", lane: "main", start_ms: 0, tokens: 1000 }], missing: 0, partial: false,
    compactions: null, limits: { context_window: 1000000, auto_compact_token_limit: 2000 } },
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

test("a folded tool bar shows the whole call and its execution time", async () => {
  body.spans = body.spans.map((s) => (s.id === "tool-1" ? { ...s, execution_ms: 59000 } : s));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Agent/ }));
  const row = (label) => within(panel()).getByText(label).nextElementSibling.textContent;
  expect(row("소요")).toBe("1분 0초");
  expect(row("실행 시간")).toBe("59.0초");
});

test("truncated detail shows banner and hides totals", async () => {
  body = { ...claudeDetail(), truncated: true, span_total: 9000, why: [],
    task: { ...claudeDetail().task, models: null, llm_calls: null, subagents: null, tokens: null, cost_usd: null,
      cost_partial: true, cost_basis: null },
    lanes: claudeDetail().lanes.map((l) => ({ ...l, llm_calls: null, cost_usd: null, cost_partial: true })) };
  mount();
  expect(await screen.findByText("일부 span만 표시 — 전체 합계 미표시")).toBeTruthy();
  expect(screen.queryByText("총 토큰")).toBeNull();
  expect(screen.queryByText(/누적 비용/)).toBeNull();
  expect(screen.queryByText(/\$0(\.00)?$/)).toBeNull();
  expect(screen.queryByText(/호출 · \$/)).toBeNull();
  // The newest spans' models are not the task's models: the header omits them.
  expect(screen.getByRole("dialog").textContent).not.toContain("claude-opus-5-5 ·");
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
  // Lane rows are keyed by index in the DOM, never by the raw agent id.
  expect([...rows].map((r) => r.getAttribute("data-band-lane"))).toEqual([...rows].map((_, i) => String(i)));
  expect(band.innerHTML).not.toContain("agent-x");
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

test("model breakdown card lists calls by model and source and highlights one model's bars", async () => {
  body.spans = body.spans.map((s) => (s.id === "llm-3"
    ? { ...s, attrs: { model: "claude-sonnet-5", query_source_safe: "sdk" }, cost_usd: null }
    : s.id === "llm-2" ? { ...s, attrs: { ...s.attrs, query_source_safe: "repl_main_thread" } } : s));
  mount();
  const card = await screen.findByRole("region", { name: "모델별 호출" });
  for (const h of ["모델", "호출 출처", "레인", "호출", "비용"]) expect(within(card).getByRole("columnheader", { name: h })).toBeTruthy();
  const rows = within(card).getAllByRole("row").slice(1);
  expect(rows).toHaveLength(2);
  expect(within(rows[0]).getByText("claude-opus-5-5")).toBeTruthy();
  expect(rows[0].textContent).toContain("메인 세션, Explore");
  expect(rows[0].textContent).toContain("$2.25");
  expect(within(rows[1]).getByText("sdk")).toBeTruthy();
  expect(within(rows[1]).getByText("미수집")).toBeTruthy(); // unknown cost, not $0
  expect(card.innerHTML).not.toContain("agent-b");

  const bars = () => screen.getAllByRole("button", { name: /^LLM 호출 #/ });
  expect(bars().some((b) => b.hasAttribute("data-dimmed"))).toBe(false);
  const sonnet = within(rows[1]).getByRole("button", { name: "claude-sonnet-5" });
  fireEvent.click(sonnet);
  expect(sonnet.getAttribute("aria-pressed")).toBe("true");
  const dimmed = bars().filter((b) => b.hasAttribute("data-dimmed")).map((b) => b.getAttribute("aria-label"));
  expect(dimmed).toEqual(["LLM 호출 #1 · 메인 세션", "LLM 호출 #2 · Explore"]);
  expect(screen.getByRole("button", { name: "LLM 호출 #3 · 서브에이전트" }).hasAttribute("data-dimmed")).toBe(false);
  // Tool and wait marks are never dimmed.
  expect(screen.getByRole("button", { name: /Agent 도구/ }).hasAttribute("data-dimmed")).toBe(false);
  // Clicking the same row again clears the highlight.
  fireEvent.click(sonnet);
  expect(sonnet.getAttribute("aria-pressed")).toBe("false");
  expect(bars().some((b) => b.hasAttribute("data-dimmed"))).toBe(false);
  // Clicking elsewhere in the row toggles too.
  fireEvent.click(within(rows[0]).getByText("$2.25"));
  expect(bars().filter((b) => b.hasAttribute("data-dimmed")).map((b) => b.getAttribute("aria-label")))
    .toEqual(["LLM 호출 #3 · 서브에이전트"]);
});

test("the why panel summarizes calls and cost per model before the individual bars", async () => {
  body.spans = body.spans.map((s) => (s.id === "llm-3"
    ? { ...s, attrs: { model: "claude-haiku-5-5", query_source_safe: "agent:builtin" } } : s));
  mount();
  const why = await screen.findByRole("region", { name: "왜 많이 썼나" });
  const list = within(why).getByRole("list", { name: "모델별 사용" });
  expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "claude-opus-5-5 2회 · $2.25 · 90%", "claude-haiku-5-5 1회 · $0.25 · 10%"]);
});

test("the why panel model summary keeps unknown cost unknown", async () => {
  body.spans = body.spans.map((s) => (s.id === "llm-3" ? { ...s, attrs: { model: "claude-haiku-5-5" }, cost_usd: null } : s));
  mount();
  const list = within(await screen.findByRole("region", { name: "왜 많이 썼나" })).getByRole("list", { name: "모델별 사용" });
  expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "claude-opus-5-5 2회 · $2.25 · 100%", "claude-haiku-5-5 1회 · 비용 미수집"]);
  expect(within(screen.getByRole("region", { name: "왜 많이 썼나" })).getByText("비중은 비용이 확인된 호출 기준입니다.")).toBeTruthy();
});

test("a Codex model summary names the completions it leaves out of the shares", async () => {
  body = { ...codexDetail(), task: { ...codexDetail().task, completions_without_span: 2 } };
  mount({ taskId: CODEX_ID });
  const why = await screen.findByRole("region", { name: "왜 많이 썼나" });
  expect(within(within(why).getByRole("list", { name: "모델별 사용" })).getAllByRole("listitem").map((li) => li.textContent))
    .toEqual(["gpt-6.1 1회 · $0.25 · 100%"]);
  expect(within(why).getByText("span과 연결되지 않은 Codex completion 2건은 모델별 사용과 비중에서 제외됩니다.")).toBeTruthy();
});

test("a fully known, fully linked model summary adds no basis note", async () => {
  mount();
  const why = await screen.findByRole("region", { name: "왜 많이 썼나" });
  expect(within(why).getByRole("list", { name: "모델별 사용" })).toBeTruthy();
  expect(within(why).queryByText(/비중은|제외됩니다/)).toBeNull();
});

test("truncated detail model breakdown shows counts without cost sums", async () => {
  body = { ...claudeDetail(), truncated: true, span_total: 9000, why: [] };
  mount();
  const card = await screen.findByRole("region", { name: "모델별 호출" });
  expect(within(card).getAllByText("합계 미표시")).toHaveLength(within(card).getAllByRole("row").length - 1);
  expect(card.textContent).not.toContain("$");
});

test("link copy puts a user-free task link on the clipboard, with a manual fallback", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  mount({ taskId: CODEX_ID });
  fireEvent.click(await screen.findByRole("button", { name: "링크 복사" }));
  await screen.findByText("링크를 복사했습니다");
  const url = new URL(writeText.mock.calls[0][0]);
  expect(url.pathname).toBe(`/tasks/${[CODEX_ID, BUCKET.from, BUCKET.to].map(encodeURIComponent).join("/")}`);
  expect(url.search).toBe("");
  expect(url.href).not.toContain("alice");
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  fireEvent.click(screen.getByRole("button", { name: "링크 복사" }));
  const field = await screen.findByRole("textbox", { name: "작업 링크" });
  expect(field.value).toBe(url.href);
});

test("without a user the request omits userExact and the header masks the returned owner", async () => {
  body = { ...claudeDetail(), owner: USER };
  mount({ user: undefined });
  await screen.findByRole("region", { name: "선택한 span 상세" });
  const [req] = detailRequests();
  expect(req.searchParams.has("userExact")).toBe(false);
  expect(screen.getByRole("dialog").textContent).toContain("al******@example.test");
  expect(screen.getByRole("dialog").textContent).not.toContain(USER);
});

test("context chart: per-lane points, compaction mark and no window share for Claude", async () => {
  mount();
  const section = await screen.findByRole("region", { name: "컨텍스트 크기" });
  const summary = within(section).getByRole("list", { name: "컨텍스트 요약" });
  expect(summary.textContent).toContain("최대 5.4K (호출 #2)");
  expect(summary.textContent).toContain("컴팩션 1회 (auto 320K → 41K)");
  expect(summary.textContent).not.toContain("컨텍스트 창");
  expect(section.querySelectorAll("[data-context-point]").length).toBe(3);
  expect(section.querySelectorAll("[data-compaction]").length).toBe(1);
  expect(section.querySelector("[data-context-limit]")).toBeNull();
  expect(section.textContent).toContain("Claude Code는 컨텍스트 창 크기를 보내지 않아");
  expect(section.textContent).toContain("컴팩션 토큰은 Claude Code가 보고한 값");
  fireEvent.click(within(section).getByRole("button", { name: /^LLM 호출 #2 · Explore · 컨텍스트 5.4K/ }));
  expect(within(panel()).getByText("5,400")).toBeTruthy();
});

test("context chart: Codex limit line and shares, unknown compactions not claimed", async () => {
  body = codexDetail();
  mount({ taskId: CODEX_ID });
  const section = await screen.findByRole("region", { name: "컨텍스트 크기" });
  const summary = within(section).getByRole("list", { name: "컨텍스트 요약" });
  expect(summary.textContent).toContain("자동 컴팩션 한도 2K의 50%");
  expect(summary.textContent).toContain("컨텍스트 창 1M의 <1%");
  expect(summary.textContent).not.toContain("컴팩션 없음");
  expect(section.querySelector("[data-context-limit]")).not.toBeNull();
  expect(section.textContent).not.toContain("Claude Code는");
});

test("context chart: unknown compaction link and missing tokens are disclosed, absent context hides it", async () => {
  body = claudeDetail();
  body.context = { ...body.context, compactions: null, missing: 2,
    points: [...body.context.points, { span: "x", lane: "main", start_ms: 1, tokens: null }] };
  mount();
  const section = await screen.findByRole("region", { name: "컨텍스트 크기" });
  expect(section.textContent).toContain("컴팩션 미수집");
  expect(section.textContent).toContain("토큰 미수집 호출 2개는 그리지 않음");
  expect(section.querySelectorAll("[data-context-point]").length).toBe(3);
  cleanup();
  body = claudeDetail();
  delete body.context;
  mount();
  await screen.findByRole("region", { name: "선택한 span 상세" });
  expect(screen.queryByRole("region", { name: "컨텍스트 크기" })).toBeNull();
});

test("context chart clamps a compaction after the last span to the axis edge", async () => {
  body = claudeDetail();
  body.context = { ...body.context, compactions: [{ start_ms: 999999, pre_tokens: 9000, post_tokens: 100, trigger: "auto", success: true }] };
  mount();
  const section = await screen.findByRole("region", { name: "컨텍스트 크기" });
  const mark = section.querySelector("[data-compaction] line");
  expect(Number(mark.getAttribute("x1"))).toBeCloseTo(880, 0);
});

test("the header names the task's workflow runs", async () => {
  body = { ...claudeDetail(), task: { ...claudeDetail().task, workflows: [{ run_id: "wf_run-1", name: "nightly-translate" },
    { run_id: "wf_run-2", name: null }] } };
  mount();
  expect(await screen.findByText("워크플로 nightly-translate, wf_run-2")).toBeTruthy();
});

test("same-name subagents get separate, distinguishable context lines and legend entries", async () => {
  const lane = (id) => ({ id, label: "general-purpose", kind: "general-purpose", spawned_by: "tool-1", llm_calls: 2,
    cost_usd: 0.5, cost_partial: false });
  const llm = (id, laneId, start, tokens) => ({ id, parent: null, lane: laneId, kind: "llm", name: "claude_code.llm_request",
    start_ms: start, duration_ms: 500, attrs: { model: "claude-haiku-5-5" }, tokens: { input: 1, cache_read: tokens, cache_write: 0, output: 1 },
    cost_usd: 0.25, cost_basis: "client_reported" });
  body = { ...claudeDetail(),
    lanes: [claudeDetail().lanes[0], lane("gp-a"), lane("gp-b")],
    spans: [claudeDetail().spans[0], llm("a1", "gp-a", 1000, 1000), llm("a2", "gp-a", 3000, 2000),
      llm("b1", "gp-b", 1500, 8000), llm("b2", "gp-b", 3500, 9000)],
    context: { points: [{ span: "llm-1", lane: "main", start_ms: 0, tokens: 3300 },
      { span: "a1", lane: "gp-a", start_ms: 1000, tokens: 1000 }, { span: "a2", lane: "gp-a", start_ms: 3000, tokens: 2000 },
      { span: "b1", lane: "gp-b", start_ms: 1500, tokens: 8000 }, { span: "b2", lane: "gp-b", start_ms: 3500, tokens: 9000 }],
    missing: 0, partial: false, compactions: [], limits: null },
    why: [] };
  mount();
  const section = await screen.findByRole("region", { name: "컨텍스트 크기" });
  const a = section.querySelector("[data-context-line='gp-a']"), b = section.querySelector("[data-context-line='gp-b']");
  expect(a && b).toBeTruthy();
  expect(a.style.stroke).not.toBe(b.style.stroke);
  expect(section.textContent).toContain("general-purpose #1");
  expect(section.textContent).toContain("general-purpose #2");
  // The timeline bar and the context point both name the numbered lane.
  expect(screen.getByRole("button", { name: "LLM 호출 #4 · general-purpose #2" })).toBeTruthy();
  expect(within(section).getByRole("button", { name: /^LLM 호출 #4 · general-purpose #2 · 컨텍스트 8K/ })).toBeTruthy();
});

test("a subagent's side call (agent_summary) is drawn as a point, not on the lane's context line", async () => {
  const sub = (id, start, tokens, source, model = "claude-sonnet-5-5") => ({ id, parent: null, lane: "agent-a", kind: "llm",
    name: "claude_code.llm_request", start_ms: start, duration_ms: 300, attrs: { model, query_source_safe: source },
    tokens: { input: 1, cache_read: tokens, cache_write: 0, output: 1 }, cost_usd: 0.1, cost_basis: "client_reported" });
  body = { ...claudeDetail(),
    spans: [claudeDetail().spans[0], claudeDetail().spans[1], sub("g1", 6000, 60000, "agent.builtin.general-purpose"),
      sub("g2", 7000, 70000, "agent.builtin.general-purpose"), sub("sum", 8000, 1000, "agent_summary", "claude-haiku-5-5"),
      sub("g3", 9000, 80000, "agent.builtin.general-purpose")],
    context: { points: [{ span: "llm-1", lane: "main", start_ms: 0, tokens: 3300 },
      ...[["g1", 6000, 60000], ["g2", 7000, 70000], ["sum", 8000, 1000], ["g3", 9000, 80000]]
        .map(([span, start_ms, tokens]) => ({ span, lane: "agent-a", start_ms, tokens }))],
    missing: 0, partial: false, compactions: [], limits: null },
    why: [] };
  mount();
  const section = await screen.findByRole("region", { name: "컨텍스트 크기" });
  const line = section.querySelector("[data-context-line='agent-a']");
  expect(line.getAttribute("points").trim().split(/\s+/)).toHaveLength(3);
  expect(section.querySelectorAll("[data-context-side]")).toHaveLength(1);
  expect(section.textContent).toContain("다른 호출 출처(예: agent_summary)의 호출은 선으로 잇지 않고 점으로만 표시합니다");
});

const environment = () => ({ lookback_days: 14,
  mcp: { connected: 2, failed: 1, other: 0, servers: [{ name: "github", status: "connected" },
    { name: "plugin:slack:slack", status: "failed" }, { name: null, status: "connected" }] },
  plugins: { count: 25, skills: 37, agents: 12, commands: 30, with_mcp: 4, counts_partial: false } });

test("the session environment card lists MCP servers, plugins and the first call's context", async () => {
  body = { ...claudeDetail(), environment: environment() };
  mount();
  const card = await screen.findByRole("region", { name: "세션 환경" });
  expect(card.textContent).toContain("MCP 서버 연결 2 · 실패 1");
  const servers = within(card).getByRole("list", { name: "MCP 서버" });
  expect(within(servers).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["github", "plugin:slack:slack 실패", "이름 비공개 1개"]);
  expect(card.textContent).toContain("plugin 25개 · skill 37 · agent 12 · command 30 · MCP 포함 plugin 4개");
  expect(card.textContent).toContain("첫 호출 컨텍스트 3.3K (메인 세션)");
  expect(card.textContent).toContain("tool 정의 수와 토큰 크기는 Claude Code OTel이 보내지 않아 표시하지 않습니다");
});

test("missing environment evidence is not collected, never an empty environment", async () => {
  body = { ...claudeDetail(), environment: null };
  mount();
  const card = await screen.findByRole("region", { name: "세션 환경" });
  expect(card.textContent).toContain("세션 환경 이벤트 미수집 (작업 시작 14일 전까지 찾음)");
  expect(card.textContent).not.toContain("MCP 서버 연결 0");
  cleanup();
  body = { ...claudeDetail(), environment: { ...environment(), mcp: null,
    plugins: { ...environment().plugins, counts_partial: true } } };
  mount();
  const partial = await screen.findByRole("region", { name: "세션 환경" });
  expect(partial.textContent).toContain("MCP 서버 미수집");
  expect(partial.textContent).toContain("(일부 plugin의 개수 미수집)");
});

test("a Codex task says its session environment is not emitted", async () => {
  body = { ...codexDetail(), environment: null };
  mount({ taskId: CODEX_ID });
  const card = await screen.findByRole("region", { name: "세션 환경" });
  expect(card.textContent).toContain("Codex는 MCP·plugin 세션 이벤트를 보내지 않아 미수집입니다");
});
