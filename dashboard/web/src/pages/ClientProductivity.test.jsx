import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RangeProvider } from "../RangeContext.jsx";
import { ConfigProvider } from "../ConfigContext.jsx";
import { clientOverview, codexUsage } from "../test/clientOverview.js";
import * as csv from "../csv.js";
import ClientPanels from "./ClientPanels.jsx";

class ResizeObserverStub {
  constructor(callback) { this.callback = callback; }
  observe(target) { this.callback([{ contentRect: target.getBoundingClientRect() }]); }
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300, x: 0, y: 0,
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const range = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z" };
const UNAVAILABLE = { active_user_seconds: "not_derived", active_cli_seconds: "not_derived",
  prs: "not_collected", commits: "not_collected", loc_added: "not_collected", loc_removed: "not_collected" };
const productivityRow = {
  claude: { client: "claude", prompts: 4, tool_calls: 10, tool_successes: 9, tool_failures: 0, tool_unknown: 1,
    tool_success_rate: 1, decisions_total: 4, decisions_allowed: 3, decisions_denied: 1, decisions_unknown: 0,
    permission_allow_rate: 0.75, tool_calls_per_prompt: 2.5, ttft_samples: 2, ttft_p50_ms: 210, ttft_p90_ms: 480,
    permission_wait_samples: 3, permission_wait_p50_ms: 900,
    by_tool_decisions: [
      { tool: "Bash", other: false, tools: 1, decisions: 3, allowed: 2, denied: 1, unknown: 0, allow_rate: 2 / 3, source: "config", source_decisions: 2 },
      { tool: null, other: true, tools: 4, decisions: 1, allowed: 1, denied: 0, unknown: 0, allow_rate: 1, source: "", source_decisions: 1 }],
    by_tool_results: [
      { tool: "Bash", other: false, tools: 1, calls: 8, successes: 7, failures: 0, unknown: 1, success_rate: 1, duration_samples: 8, duration_p50_ms: 120 },
      { tool: "", other: false, tools: 1, calls: 2, successes: 2, failures: 0, unknown: 0, success_rate: 1, duration_samples: 0, duration_p50_ms: null }],
    top_users: [{ user: "alice@example.test", productivity_score: 66.3, accept_rate: 0.75, loc_added: 100, commits: 3,
      sessions: 1, active_days: 1, decisions: 4 }], activity_index_users: 1, activity_index_scored: 1,
    active_user_seconds: 7200, active_cli_seconds: 0, commits: 0, prs: 1, loc_added: 270, loc_removed: 5, unavailable: {} },
  codex: { client: "codex", prompts: 0, tool_calls: 3, tool_successes: 2, tool_failures: 1, tool_unknown: 0,
    tool_success_rate: 2 / 3, decisions_total: 0, decisions_allowed: 0, decisions_denied: 0, decisions_unknown: 0,
    permission_allow_rate: null, tool_calls_per_prompt: null, ttft_samples: 1, ttft_p50_ms: 30, ttft_p90_ms: 30,
    permission_wait_samples: null, permission_wait_p50_ms: null, by_tool_decisions: [],
    by_tool_results: [{ tool: "shell", other: false, tools: 1, calls: 3, successes: 2, failures: 1, unknown: 0,
      success_rate: 2 / 3, duration_samples: 2, duration_p50_ms: 20 }],
    top_users: null, activity_index_users: null, activity_index_scored: null,
    active_user_seconds: null, active_cli_seconds: null, commits: null, prs: null, loc_added: null, loc_removed: null,
    unavailable: { ...UNAVAILABLE, permission_wait_p50_ms: "not_aggregated", top_users: "not_derived" } },
};
function mount(clients, productivityState) {
  const rows = clients.map((client) => ({ ...codexUsage, client, sessions: 2,
    cost_basis: client === "claude" ? "client_reported" : "aws_list_estimate" }));
  const data = clientOverview({ clients, by_client: rows, by_model: rows, effective_range: range });
  const productivity = productivityState ?? { loading: false, error: null, stale: false,
    data: { clients, by_client: clients.map((client) => productivityRow[client]), effective_range: range } };
  return render(<MemoryRouter><ConfigProvider config={{ piiMask: true }}>
    <RangeProvider><ClientPanels page="productivity" data={data} clients={clients} productivity={productivity} /></RangeProvider>
  </ConfigProvider></MemoryRouter>);
}
const table = (title) => screen.getByText(title, { exact: true }).closest(".shadow-card");
const cells = (card, client) => [...within(card).getByText(client, { exact: true }).closest("tr").querySelectorAll("td")]
  .map((td) => td.textContent);

test("all clients share one row per client in identical sections and columns", () => {
  const { container } = mount(["claude", "codex"]);
  const summary = table("클라이언트별 요약");
  expect([...summary.querySelectorAll("th")].map((th) => th.textContent.replace(/[↕▲▼]/g, ""))).toEqual([
    "클라이언트", "관측 사용자 ID", "세션", "프롬프트·턴", "세션당 토큰", "세션당 비용 (USD)", "비용 기준",
    "도구 호출", "도구 성공률 (%)", "권한 허용률 (%)", "TTFT p50 (ms)"]);
  expect(cells(summary, "Claude Code")).toEqual(["Claude Code", "1", "2", "4", "135", "$0.00212025", "클라이언트 보고",
    "10", "100%", "75%", "210"]);
  // Measured zero prompts stay 0; an empty denominator is —, not 0.
  expect(cells(summary, "Codex")).toEqual(["Codex", "1", "2", "0", "135", "$0.00212025", "AWS 정가 추정",
    "3", "66.67%", "—", "30"]);
  expect(cells(table("활동"), "Claude Code")).toEqual(["Claude Code", "2.5", "2", "2", "0"]);
  expect(cells(table("활동"), "Codex")).toEqual(["Codex", "—", "0", "미산출", "미산출"]);
  expect(cells(table("코드 결과"), "Claude Code")).toEqual(["Claude Code", "1", "0", "270", "5", "1,000,000"]);
  expect(cells(table("코드 결과"), "Codex")).toEqual(["Codex", "미수집", "미수집", "미수집", "미수집", "미수집"]);
  expect(table("코드 결과").textContent).toContain("기본 OTel에 PR·커밋·라인 지표가 없습니다. Git/CI 연동이 필요합니다.");
  expect(table("모델별 관측 효율")).toBeTruthy();
  const legend = screen.getByRole("region", { name: "값 상태 안내" });
  for (const label of ["미수집", "미집계", "미산출"]) expect(within(legend).getByText(label)).toBeTruthy();
  expect(container.textContent).not.toMatch(/직원 ROI|절약 시간|LOC/);
});

const rowsOf = (card) => [...card.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
test("per-tool, latency and top-user sections share columns and label unavailable values", () => {
  const { container } = mount(["claude", "codex"]);
  const headers = (title) => [...table(title).querySelectorAll("th")].map((th) => th.textContent.replace(/[↕▲▼]/g, ""));
  expect(headers("도구별 권한 결정")).toEqual(["클라이언트", "도구", "허용", "거부", "허용률 (%)", "주된 결정 출처"]);
  expect(rowsOf(table("도구별 권한 결정"))).toEqual([
    ["Claude Code", "Bash", "2", "1", "66.67%", "config (66.67%)"],
    ["Claude Code", "기타 (4개 도구)", "1", "0", "100%", "(출처 없음) (100%)"],
    // An empty list is a measured absence: zeros, no rate.
    ["Codex", "관측된 도구 없음", "0", "0", "—", "—"]]);
  expect(screen.getByText("권한 결정은 자동 승인을 포함하며 코드 채택이 아닙니다.")).toBeTruthy();
  expect(headers("도구별 실행 결과")).toEqual(["클라이언트", "도구", "호출", "성공", "실패", "성공률 (%)", "실행 시간 p50 (ms)"]);
  expect(rowsOf(table("도구별 실행 결과"))).toEqual([
    ["Claude Code", "Bash", "8", "7", "0", "100%", "120"],
    ["Claude Code", "(도구 이름 없음)", "2", "2", "0", "100%", "—"],
    ["Codex", "shell", "3", "2", "1", "66.67%", "20"]]);
  expect(headers("응답·대기")).toEqual(["클라이언트", "TTFT p50 (ms)", "TTFT p90 (ms)", "표본", "권한 대기 p50 (ms)"]);
  expect(cells(table("응답·대기"), "Claude Code")).toEqual(["Claude Code", "210", "480", "2", "900"]);
  expect(cells(table("응답·대기"), "Codex")).toEqual(["Codex", "30", "30", "1", "미집계"]);
  const users = table("활동 지수 상위 사용자");
  expect(cells(users, "Claude Code")).toEqual(["Claude Code", "al******@example.test", "66.3", "75%", "100", "3", "1", "1"]);
  expect(cells(users, "Codex")).toEqual(["Codex", "—", ...Array(6).fill("미산출")]);
  expect(users.textContent).toContain("산식에 필요한 추가 라인·커밋이 Codex에 없어 계산하지 않습니다.");
  // Masked identities never appear raw on screen.
  expect(container.textContent).not.toContain("alice@example.test");
});

test("top-user CSV masks identities and exports unavailable labels", () => {
  const spy = vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
  mount(["claude", "codex"]);
  fireEvent.click(within(table("활동 지수 상위 사용자")).getByRole("button", { name: /CSV/ }));
  const text = spy.mock.calls[0][1];
  expect(text).not.toContain("alice@example.test");
  expect(text).toContain("Claude Code,al******@example.test,66.3,75,100,3,1,1");
  expect(text).toContain("Codex,,미산출,미산출,미산출,미산출,미산출,미산출");
});

test("a single client keeps the same layout with only its row", () => {
  const headers = (clients) => {
    const { container, unmount } = mount(clients);
    const out = [...container.querySelectorAll("th")].map((th) => th.textContent);
    unmount();
    return out;
  };
  const both = headers(["claude", "codex"]);
  expect(headers(["codex"])).toEqual(both);
  expect(headers(["claude"])).toEqual(both);
  const { container } = mount(["codex"]);
  expect(within(table("클라이언트별 요약")).queryByText("Claude Code")).toBeNull();
  expect(cells(table("코드 결과"), "Codex").slice(1)).toEqual(Array(5).fill("미수집"));
  expect(container.textContent).not.toContain("Claude Code");
});

test("unavailable labels export as labels while measured values stay numeric", () => {
  const spy = vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
  mount(["claude", "codex"]);
  fireEvent.click(within(table("코드 결과")).getByRole("button", { name: /CSV/ }));
  const text = spy.mock.calls[0][1];
  expect(text).toContain("Codex,미수집,미수집,미수집,미수집,미수집");
  expect(text).toContain("Claude Code,1,0,270,5,1000000");
});

test("missing, failed and other-window productivity responses never show zeros", () => {
  mount(["claude", "codex"], { loading: false, error: null, stale: false,
    data: { by_client: [], effective_range: range } });
  expect(cells(table("클라이언트별 요약"), "Codex").slice(3)).toEqual(["—", "135", "$0.00212025", "AWS 정가 추정", "—", "—", "—", "—"]);
  for (const title of ["도구별 권한 결정", "도구별 실행 결과", "응답·대기", "활동 지수 상위 사용자"])
    expect(cells(table(title), "Claude Code").slice(1).every((cell) => cell === "—"), title).toBe(true);
  cleanup();
  mount(["codex"], { loading: false, error: new Error("fixture failure"), stale: false, data: null });
  expect(screen.queryByText("클라이언트별 요약")).toBeNull();
  cleanup();
  mount(["codex"], { loading: false, error: null, stale: false, data: { by_client: [productivityRow.codex],
    effective_range: { ...range, to: "2026-09-01T12:00:00.000Z" } } });
  expect(within(table("클라이언트별 요약")).getByRole("button", { name: /CSV/ }).disabled).toBe(true);
  expect(cells(table("클라이언트별 요약"), "Codex").at(-1)).toBe("—");
  expect(cells(table("코드 결과"), "Codex").slice(1)).toEqual(Array(5).fill("—"));
});
