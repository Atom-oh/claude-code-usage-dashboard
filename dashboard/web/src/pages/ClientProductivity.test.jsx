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
    permission_allow_rate: 0.75, tool_calls_per_prompt: 2.5, ttft_samples: 2, ttft_p50_ms: 210,
    active_user_seconds: 7200, active_cli_seconds: 0, commits: 0, prs: 1, loc_added: 270, loc_removed: 5, unavailable: {} },
  codex: { client: "codex", prompts: 0, tool_calls: 3, tool_successes: 2, tool_failures: 1, tool_unknown: 0,
    tool_success_rate: 2 / 3, decisions_total: 0, decisions_allowed: 0, decisions_denied: 0, decisions_unknown: 0,
    permission_allow_rate: null, tool_calls_per_prompt: null, ttft_samples: 1, ttft_p50_ms: 30,
    active_user_seconds: null, active_cli_seconds: null, commits: null, prs: null, loc_added: null, loc_removed: null,
    unavailable: UNAVAILABLE },
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
