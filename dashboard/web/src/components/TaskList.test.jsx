import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider } from "../ConfigContext.jsx";
import { RefreshProvider } from "../RefreshContext.jsx";
import { RangeProvider } from "../RangeContext.jsx";
import { FilterProvider } from "../FilterContext.jsx";
import { setPiiMask } from "../fmt.js";
import { clientOverview, codexUsage } from "../test/clientOverview.js";
import { TaskList } from "./TaskList.jsx";
import { UserDetail } from "./UserDetail.jsx";

const USER = "alice@example.test";
const NOW = new Date("2026-09-04T12:00:00.000Z").getTime();
const BUCKET = { from: "2026-09-02T00:00:00.000Z", to: "2026-09-03T00:00:00.000Z" };

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const claudeTask = {
  id: "claude:0123456789abcdef0123456789abcdef", client: "claude", started_at: "2026-09-02T03:00:00.000Z",
  duration_ms: 95000, duration_basis: "interaction_span", models: ["claude-opus-5-5"], llm_calls: 7, subagents: 2,
  tokens: { input: 100, cache_read: 4000, cache_write: 300, output: 600, observed_tokens: 5000, tokens_partial: false },
  cost_usd: 1.5, cost_partial: false, cost_basis: "client_reported",
};
const codexTask = {
  id: "codex:conv-1:turn-1", client: "codex", started_at: "2026-09-02T04:00:00.000Z",
  duration_ms: 12000, duration_basis: "observed_span_window", models: ["gpt-6.1"], llm_calls: 3, subagents: null,
  tokens: { input: 200, cache_read: 800, cache_write: 0, output: 100, observed_tokens: 1100, tokens_partial: false },
  cost_usd: 0.25, cost_partial: false, cost_basis: "linked_estimate",
};
const unknownTask = {
  id: "codex:conv-2:turn-9", client: "codex", started_at: "2026-09-02T05:00:00.000Z",
  duration_ms: 4000, duration_basis: "observed_span_window", models: [], llm_calls: 0, subagents: null,
  tokens: { input: null, cache_read: null, cache_write: null, output: null, observed_tokens: null, tokens_partial: false },
  cost_usd: null, cost_partial: false, cost_basis: "linked_estimate",
};
const response = (over = {}) => ({ tasks: [claudeTask, codexTask], unattached_codex: null,
  coverage: { claude: "observed", codex: "observed" }, partial: true, ...over });

function overview(u) {
  const clients = u.searchParams.get("client") === "all" ? ["claude", "codex"] : [u.searchParams.get("client")];
  const rows = clients.map((client) => ({ ...codexUsage, client,
    cost_basis: client === "claude" ? "client_reported" : "aws_list_estimate" }));
  return clientOverview({
    clients, by_client: rows, by_model: rows, by_user: rows.map((r) => ({ ...r, user: USER })),
    totals: { ...rows[0], sessions: 3, cost_usd: 1.25, observed_tokens: 540, users: null },
    timeseries: rows.flatMap((r) => [{ ...r, t: "2026-09-01T00:00:00.000Z" }, { ...r, t: "2026-09-02T00:00:00.000Z" }]),
    effective_range: { from: u.searchParams.get("from"), to: u.searchParams.get("to") },
    bucket_hours: Number(u.searchParams.get("intervalHours")) || 1,
    applied_filters: { userExact: u.searchParams.get("userExact") || "", modelExact: "", backend: "" },
  });
}

let fetchMock, tasksBody;
const detailBody = { task: claudeTask, truncated: false, span_total: 0, spans: [], why: [],
  lanes: [{ id: "main", label: "main", kind: "main", spawned_by: null, llm_calls: 7, cost_usd: 1.5, cost_partial: false }] };
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  tasksBody = response();
  fetchMock = vi.fn((url) => {
    const u = new URL(String(url), "http://localhost");
    const body = u.pathname === "/api/users/tasks" ? tasksBody
      : u.pathname === "/api/users/tasks/detail" ? detailBody
      : u.pathname === "/api/clients/overview" ? overview(u)
      : u.pathname === "/api/codex/insights" ? { coverage: {}, summary: {}, approvals: [] } : [];
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setPiiMask(true);
});

const wrap = (el) => render(
  <MemoryRouter>
    <ConfigProvider config={{ piiMask: true }}>
      <RefreshProvider><RangeProvider><FilterProvider>{el}</FilterProvider></RangeProvider></RefreshProvider>
    </ConfigProvider>
  </MemoryRouter>,
);
const mount = (props = {}) => wrap(<TaskList user={USER} clients={["claude", "codex"]} group={null}
  from={BUCKET.from} to={BUCKET.to} onOpen={() => {}} {...props} />);
const taskRequests = () => fetchMock.mock.calls.map(([url]) => new URL(String(url), "http://localhost"))
  .filter((u) => u.pathname === "/api/users/tasks");
const rowOf = (text) => screen.getByText(text).closest("tr");

test("clicking a trend bucket loads tasks for that bucket", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300, x: 0, y: 0,
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  const parent = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-04T00:00:00.000Z" };
  const onBucket = vi.fn();
  const { container } = wrap(<UserDetail user={USER} clients={["claude", "codex"]} hours={24} parentRange={parent}
    stale={false} onClose={() => {}} onBucket={onBucket} />);
  await waitFor(() => expect(container.querySelector(".recharts-wrapper")).not.toBeNull());
  expect(taskRequests()).toHaveLength(0);
  const chart = container.querySelector(".recharts-wrapper");
  const grid = chart.querySelector(".recharts-cartesian-grid-horizontal line");
  const left = Number(grid.getAttribute("x1")), right = Number(grid.getAttribute("x2"));
  const x = left + (right - left) * (1 / 3); // 2026-09-02 00:00 within [09-01, 09-04)
  fireEvent.mouseDown(chart, { clientX: x, clientY: 60 });
  fireEvent.mouseUp(chart, { clientX: x, clientY: 60 });
  expect(await screen.findByText("claude-opus-5-5")).toBeTruthy();
  expect(onBucket).toHaveBeenCalledWith(BUCKET);
  const [req] = taskRequests();
  expect(req.searchParams.get("from")).toBe(BUCKET.from);
  expect(req.searchParams.get("to")).toBe(BUCKET.to);
  expect(req.searchParams.get("userExact")).toBe(USER);
  expect(req.searchParams.get("client")).toBe("all");
  expect(req.searchParams.get("sort")).toBe("tokens");
  expect(req.searchParams.has("group")).toBe(false);
  expect(req.searchParams.has("team")).toBe(false);
  // No custom range was set: a click selects a bucket, it does not zoom.
  expect(screen.getAllByText("부분 수집").length).toBeGreaterThan(0);
});

test("opening a task shows its trace overlay for the bucket and Escape closes it", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300, x: 0, y: 0,
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  const parent = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-04T00:00:00.000Z" };
  const { container } = wrap(<UserDetail user={USER} clients={["claude", "codex"]} hours={24} parentRange={parent}
    stale={false} onClose={() => {}} />);
  await waitFor(() => expect(container.querySelector(".recharts-wrapper")).not.toBeNull());
  const chart = container.querySelector(".recharts-wrapper");
  const grid = chart.querySelector(".recharts-cartesian-grid-horizontal line");
  const x = Number(grid.getAttribute("x1")) + (Number(grid.getAttribute("x2")) - Number(grid.getAttribute("x1"))) / 3;
  fireEvent.mouseDown(chart, { clientX: x, clientY: 60 });
  fireEvent.mouseUp(chart, { clientX: x, clientY: 60 });
  fireEvent.click((await screen.findByText("claude-opus-5-5")).closest("tr"));
  expect(await screen.findByRole("dialog", { name: "작업 상세" })).toBeTruthy();
  await screen.findByRole("group", { name: "메인 세션 레인" });
  const req = fetchMock.mock.calls.map(([url]) => new URL(String(url), "http://localhost"))
    .find((u) => u.pathname === "/api/users/tasks/detail");
  expect(req.searchParams.get("id")).toBe(claudeTask.id);
  expect(req.searchParams.get("from")).toBe(BUCKET.from);
  expect(req.searchParams.get("to")).toBe(BUCKET.to);
  expect(req.searchParams.get("userExact")).toBe(USER);
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText("claude-opus-5-5")).toBeTruthy();
});

test("bucket older than 90 days shows retention notice without fetching", async () => {
  mount({ from: "2026-06-01T00:00:00.000Z", to: "2026-06-02T00:00:00.000Z" });
  expect(await screen.findByText("trace 보관 기간(90일) 경과 · 미수집")).toBeTruthy();
  expect(screen.getByText("부분 수집")).toBeTruthy();
  expect(taskRequests()).toHaveLength(0);
});

test("sort toggle requests sort=duration", async () => {
  mount();
  await screen.findByText("claude-opus-5-5");
  expect(screen.getByRole("button", { name: "토큰 많은 순" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "느린 순" }));
  await waitFor(() => expect(taskRequests().some((u) => u.searchParams.get("sort") === "duration")).toBe(true));
});

test("each of the four sort options requests its sort", async () => {
  mount();
  await screen.findByText("claude-opus-5-5");
  for (const [label, sort] of [["비용 높은 순", "cost"], ["서브에이전트 많은 순", "subagents"], ["느린 순", "duration"],
    ["토큰 많은 순", "tokens"]]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(taskRequests().at(-1).searchParams.get("sort")).toBe(sort));
    expect(screen.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("true");
  }
});

test("cost sort notes the Claude candidate pool only when it was full", async () => {
  tasksBody = response({ sort_candidates: { claude: 100, claude_limit: 100, limited: true } });
  mount();
  await screen.findByText("claude-opus-5-5");
  // The note belongs to the cost order only.
  expect(screen.queryByText("Claude는 토큰 상위 100개 중 비용 순")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "비용 높은 순" }));
  expect(await screen.findByText("Claude는 토큰 상위 100개 중 비용 순")).toBeTruthy();
  cleanup();
  tasksBody = response({ sort_candidates: { claude: 12, claude_limit: 100, limited: false } });
  mount();
  await screen.findByText("claude-opus-5-5");
  fireEvent.click(screen.getByRole("button", { name: "비용 높은 순" }));
  await waitFor(() => expect(taskRequests().at(-1).searchParams.get("sort")).toBe("cost"));
  await screen.findByText("claude-opus-5-5");
  expect(screen.queryByText(/토큰 상위 100개 중 비용 순/)).toBeNull();
});

test("codex row shows estimated linkage", async () => {
  mount();
  await screen.findByText("gpt-6.1");
  const codex = rowOf("gpt-6.1");
  expect(within(codex).getByText("Codex")).toBeTruthy();
  expect(within(codex).getByText("연결 추정")).toBeTruthy();
  expect(within(codex).getByText("$0.25")).toBeTruthy();
  // Codex has no parent link for subagents: unknown, never 0.
  expect(within(codex).getAllByText("미수집").length).toBeGreaterThan(0);
  const claude = rowOf("claude-opus-5-5");
  expect(within(claude).getByText("클라이언트 보고")).toBeTruthy();
  expect(within(claude).queryByText("연결 추정")).toBeNull();
  expect(within(claude).getByText("1분 35초")).toBeTruthy();
  expect(within(claude).getByText("5,000")).toBeTruthy();
});

test("unknown cost renders not collected not $0", async () => {
  tasksBody = response({ tasks: [unknownTask] });
  mount();
  const cell = await screen.findByText("4.0초");
  const row = cell.closest("tr");
  expect(row.textContent).not.toContain("$0");
  expect(within(row).getAllByText("미수집").length).toBeGreaterThanOrEqual(3); // model, tokens, cost, subagents
  expect(row.textContent).not.toContain("연결 추정");
});

test("empty response shows trace not collected", async () => {
  tasksBody = response({ tasks: [], coverage: { claude: "empty", codex: "empty" },
    unattached_codex: { completions: 0, cost_usd: 0, cost_partial: false, turns_without_conversation: 0 } });
  mount();
  expect(await screen.findByText("trace 미수집")).toBeTruthy();
  expect(screen.getByText("부분 수집")).toBeTruthy();
  expect(screen.queryByText(/trace와 연결되지 않은/)).toBeNull();
});

test("unattached note renders count", async () => {
  tasksBody = response({ coverage: { claude: "observed", codex: "limited" },
    unattached_codex: { completions: 4, cost_usd: 0.5, cost_partial: false, turns_without_conversation: 2 } });
  mount();
  const note = await screen.findByText(/trace와 연결되지 않은 Codex completion 4건 · \$0\.5/);
  expect(note.textContent).toContain("2");
  expect(screen.getByText(/Codex 로그가 조회 한도/)).toBeTruthy();
});

test("unattached note counts turns without a unique turn id", async () => {
  tasksBody = response({ unattached_codex: { completions: 0, cost_usd: 0, cost_partial: false,
    turns_without_conversation: 0, turns_without_unique_id: 3 } });
  mount();
  const note = await screen.findByText(/고유하지 않은 turn id로 제외한 turn 3건/);
  expect(note.textContent).toContain("trace와 연결되지 않은 Codex completion 0건");
  expect(note.textContent).not.toContain("conversation id가 없어");
});

test("row click opens the task and the raw id is not rendered", async () => {
  const onOpen = vi.fn();
  mount({ onOpen, group: "bedrock", clients: ["claude"] });
  fireEvent.click(await screen.findByText("claude-opus-5-5"));
  expect(onOpen).toHaveBeenCalledWith(claudeTask.id);
  expect(document.body.textContent).not.toContain("0123456789abcdef0123456789abcdef");
  expect(document.body.textContent).not.toContain(USER);
  const [req] = taskRequests();
  expect(req.searchParams.get("group")).toBe("bedrock");
  expect(req.searchParams.get("client")).toBe("claude");
});

test("a task's workflow runs show as badges that filter the list to that run", async () => {
  tasksBody = response({ tasks: [{ ...claudeTask, workflows: [{ run_id: "wf_run-1", name: "nightly-translate" }] },
    { ...codexTask, workflows: [] }] });
  mount();
  const badge = await screen.findByRole("button", { name: "워크플로 nightly-translate로 거르기" });
  expect(within(rowOf("claude-opus-5-5")).getByText("nightly-translate")).toBeTruthy();
  fireEvent.click(badge);
  await waitFor(() => expect(taskRequests().at(-1).searchParams.get("workflowRunId")).toBe("wf_run-1"));
  // Workflow runs are Claude Code spans; the server filters them only for client=claude.
  expect(taskRequests().at(-1).searchParams.get("client")).toBe("claude");
  const chip = await screen.findByRole("status", { name: "워크플로 필터" });
  expect(chip.textContent).toContain("nightly-translate");
  fireEvent.click(within(chip).getByRole("button", { name: "워크플로 필터 해제" }));
  await waitFor(() => expect(taskRequests().at(-1).searchParams.get("workflowRunId")).toBeNull());
  expect(taskRequests().at(-1).searchParams.get("client")).toBe("all");
});

test("a workflow run without a name shows its run id", async () => {
  tasksBody = response({ tasks: [{ ...claudeTask, workflows: [{ run_id: "wf_run-2", name: null }] }] });
  mount();
  expect(await screen.findByRole("button", { name: "워크플로 wf_run-2로 거르기" })).toBeTruthy();
});

test("changing the client selection clears the workflow filter", async () => {
  tasksBody = response({ tasks: [{ ...claudeTask, workflows: [{ run_id: "wf_run-1", name: "nightly-translate" }] }] });
  const tree = (clients) => <MemoryRouter><ConfigProvider config={{ piiMask: true }}>
    <RefreshProvider><RangeProvider><FilterProvider><TaskList user={USER} clients={clients} group={null}
      from={BUCKET.from} to={BUCKET.to} onOpen={() => {}} /></FilterProvider></RangeProvider></RefreshProvider>
  </ConfigProvider></MemoryRouter>;
  const { rerender } = render(tree(["claude", "codex"]));
  fireEvent.click(await screen.findByRole("button", { name: "워크플로 nightly-translate로 거르기" }));
  await screen.findByRole("status", { name: "워크플로 필터" });
  rerender(tree(["codex"]));
  await waitFor(() => expect(screen.queryByRole("status", { name: "워크플로 필터" })).toBeNull());
  await waitFor(() => expect(taskRequests().at(-1).searchParams.get("client")).toBe("codex"));
  expect(taskRequests().at(-1).searchParams.get("workflowRunId")).toBeNull();
});
