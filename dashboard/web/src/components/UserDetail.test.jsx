import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider } from "../ConfigContext.jsx";
import { RefreshProvider } from "../RefreshContext.jsx";
import { RangeProvider } from "../RangeContext.jsx";
import { FilterProvider } from "../FilterContext.jsx";
import { setPiiMask } from "../fmt.js";
import { clientOverview, codexUsage } from "../test/clientOverview.js";
import { UserDetail } from "./UserDetail.jsx";

const USER = "alice@example.test";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function overview(u) {
  const clients = u.searchParams.get("client") === "all" ? ["claude", "codex"] : [u.searchParams.get("client")];
  const rows = clients.map((client) => ({ ...codexUsage, client,
    cost_basis: client === "claude" ? "client_reported" : "aws_list_estimate" }));
  return clientOverview({
    clients, by_client: rows, by_model: rows, by_user: rows.map((r) => ({ ...r, user: USER })),
    totals: { ...rows[0], sessions: clients.length * 3, cost_usd: 1.25, observed_tokens: 540, users: null },
    timeseries: rows.flatMap((r) => [{ ...r, t: "2026-09-01T00:00:00.000Z" }, { ...r, t: "2026-09-02T00:00:00.000Z" }]),
    effective_range: { from: u.searchParams.get("from"), to: u.searchParams.get("to") },
    bucket_hours: Number(u.searchParams.get("intervalHours")) || 1,
    applied_filters: { userExact: u.searchParams.get("userExact") || "", modelExact: "", backend: "" },
  });
}

const BODIES = {
  "/api/users/daily": [{ t: "2026-09-01 00:00:00", sessions: 2, loc: 120, tokens: 900, commits: 3 }],
  "/api/users/decisions-by-tool": [{ group: "bedrock", tool: "Edit", decision: "accept", n: 4 },
    { group: "bedrock", tool: "Edit", decision: "reject", n: 1 }],
  "/api/codex/insights": { coverage: {}, summary: { approval_rate: 0.5 }, tools: [],
    approvals: [{ tool: "shell", decision: "approved", source: "auto", count: 7 }] },
};

let fetchMock;
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(new Date("2026-09-04T12:00:00.000Z").getTime());
  fetchMock = vi.fn((url) => {
    const u = new URL(String(url), "http://localhost");
    const body = u.pathname === "/api/clients/overview" ? overview(u) : BODIES[u.pathname] ?? [];
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

const PARENT = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-04T00:00:00.000Z" };
function mount(props) {
  return render(
    <MemoryRouter>
      <ConfigProvider config={{ piiMask: true }}>
        <RefreshProvider><RangeProvider><FilterProvider>
          <UserDetail user={USER} hours={24} parentRange={PARENT} stale={false} onClose={() => {}} {...props} />
        </FilterProvider></RangeProvider></RefreshProvider>
      </ConfigProvider>
    </MemoryRouter>,
  );
}
const requests = () => fetchMock.mock.calls.map(([url]) => new URL(String(url), "http://localhost"));
const byPath = (path) => requests().filter((u) => u.pathname === path);

test("renders combined summary for claude and codex", async () => {
  mount({ clients: ["claude", "codex"] });
  const region = screen.getByRole("region", { name: "사용자 상세" });
  expect(await within(region).findByText("$1.25")).toBeTruthy();
  expect(within(region).getByText("세션")).toBeTruthy();
  expect(within(region).getByText("활동 히트맵 · 최근 90일")).toBeTruthy();
  expect(within(region).getByRole("button", { name: "상세 닫기" })).toBeTruthy();
  const overviews = byPath("/api/clients/overview");
  expect(overviews.every((u) => u.searchParams.get("client") === "all" && u.searchParams.get("userExact") === USER)).toBe(true);
  const heat = overviews.find((u) => u.searchParams.get("intervalHours") === "24" && u.searchParams.get("to") === PARENT.to
    && u.searchParams.get("from") === "2026-06-06T00:00:00.000Z");
  expect(heat).toBeTruthy();
  expect(await screen.findByText("Codex 도구 권한 결정")).toBeTruthy();
  expect(screen.getByText("Claude Code에서만 수집")).toBeTruthy();
  expect((await screen.findAllByText("Codex: 미수집")).length).toBeGreaterThan(0);
});

test("heatmap labels the calendar and preserves all 90 UTC days", async () => {
  mount({ clients: ["claude", "codex"] });
  const heatmap = await screen.findByRole("img", { name: "일별 관측 세션 히트맵" });
  expect(within(heatmap).getByText("6월")).toBeTruthy();
  expect(within(heatmap).getByText("9월")).toBeTruthy();
  for (const day of ["일", "월", "화", "수", "목", "금", "토"])
    expect(within(heatmap).getByText(day)).toBeTruthy();
  const dates = [...heatmap.querySelectorAll("[title]")].map((cell) => cell.title);
  expect(dates).toHaveLength(90);
  expect(dates[0]).toContain("2026-06-06 · 일별 관측 세션 0");
  expect(dates.at(-1)).toContain("2026-09-03 · 일별 관측 세션 0");
  expect(dates.find((value) => value.startsWith("2026-09-01")))
    .toContain("일별 관측 세션 2 (Claude Code 1 · Codex 1)");
});

test("codex-only hides Claude fetches and shows 미수집 for LOC", async () => {
  mount({ clients: ["codex"] });
  expect(await screen.findByText("Codex 도구 권한 결정")).toBeTruthy();
  expect(byPath("/api/users/daily")).toHaveLength(0);
  expect(byPath("/api/users/decisions-by-tool")).toHaveLength(0);
  expect(byPath("/api/clients/overview").every((u) => u.searchParams.get("client") === "codex")).toBe(true);
  const loc = screen.getByText("추가 코드 라인", { selector: "span.truncate" }).parentElement.parentElement;
  expect(loc.textContent).toContain("미수집");
  expect(loc.textContent).not.toMatch(/\b0\b/);
});

test("claude-only does not request codex insights", async () => {
  mount({ clients: ["claude"] });
  expect(await screen.findByText("Claude Code에서만 수집")).toBeTruthy();
  expect(await screen.findByText("120")).toBeTruthy();
  expect(byPath("/api/codex/insights")).toHaveLength(0);
  expect(screen.queryByText("Codex 도구 권한 결정")).toBeNull();
  expect(screen.queryByText("Codex: 미수집")).toBeNull();
});

test("group note appears and group is sent only to /api/users/* requests", async () => {
  mount({ clients: ["claude", "codex"], group: "bedrock" });
  expect(screen.getByText("그룹(bedrock) 필터는 Claude 전용 영역에만 적용됩니다")).toBeTruthy();
  await screen.findByText("Codex 도구 권한 결정");
  await screen.findByText("120");
  for (const u of [...byPath("/api/users/daily"), ...byPath("/api/users/decisions-by-tool")]) {
    expect(u.searchParams.get("group")).toBe("bedrock");
    expect(u.searchParams.get("email")).toBe(USER);
  }
  expect(byPath("/api/users/daily").length).toBeGreaterThan(0);
  for (const u of [...byPath("/api/clients/overview"), ...byPath("/api/codex/insights")])
    expect(u.searchParams.has("group")).toBe(false);
  const insights = byPath("/api/codex/insights");
  expect(insights.length).toBeGreaterThan(0);
  expect(insights.every((u) => u.searchParams.get("profile") === "tools" && u.searchParams.get("userExact") === USER)).toBe(true);
});

test("never renders raw email when masking is on", async () => {
  setPiiMask(true);
  const { container } = mount({ clients: ["claude", "codex"] });
  await screen.findByText("Codex 도구 권한 결정");
  await screen.findByText("120");
  expect(container.textContent).not.toContain(USER);
  expect(container.innerHTML).not.toContain(USER);
  expect(screen.getByRole("heading", { level: 2 }).textContent).toContain("al******@example.test");
});
