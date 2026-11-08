import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider } from "../ConfigContext.jsx";
import { RefreshProvider } from "../RefreshContext.jsx";
import { RangeProvider } from "../RangeContext.jsx";
import { FilterProvider } from "../FilterContext.jsx";
import { setPiiMask } from "../fmt.js";
import { clientOverview } from "../test/clientOverview.js";
import Users from "./Users.jsx";

// Synthetic identities only.
const LEADERBOARD = [
  { user: "alice@example.test", group: "bedrock", productivity_score: 3, sessions: 2, tokens: 10, decisions: 0 },
  { user: "alice@example.test", group: "enterprise", productivity_score: 1, sessions: 1, tokens: 5, decisions: 0 },
];

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn((url) => {
    const u = new URL(String(url), "http://localhost");
    const body = u.pathname === "/api/users/leaderboard" ? LEADERBOARD
      : u.pathname === "/api/clients/overview"
        ? clientOverview({ applied_filters: { userExact: u.searchParams.get("userExact") || "" } })
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

const requests = (path) => fetchMock.mock.calls.map(([url]) => new URL(String(url), "http://localhost"))
  .filter((u) => u.pathname === path);

test("leaderboard click opens UserDetail with group", async () => {
  setPiiMask(true);
  render(<MemoryRouter><ConfigProvider config={{ piiMask: true, enabledClients: ["claude", "codex"] }}>
    <RefreshProvider><RangeProvider><FilterProvider><Users /></FilterProvider></RangeProvider></RefreshProvider>
  </ConfigProvider></MemoryRouter>);
  const table = (await screen.findByText("사용자별 관측 활동 — bedrock", { exact: true })).closest(".shadow-card");
  expect(screen.queryByRole("region", { name: "사용자 상세" })).toBeNull();
  fireEvent.click(within(table).getAllByRole("row")[1]);
  const region = await screen.findByRole("region", { name: "사용자 상세" });
  expect(region.textContent).toContain("그룹(bedrock)");
  expect(screen.queryByRole("dialog")).toBeNull();
  const daily = requests("/api/users/daily");
  expect(daily.length).toBeGreaterThan(0);
  expect(daily.every((u) => u.searchParams.get("email") === "alice@example.test"
    && u.searchParams.get("group") === "bedrock")).toBe(true);
  // Enabled clients from config: both, so the common sections query "all".
  expect(requests("/api/clients/overview").every((u) => u.searchParams.get("client") === "all")).toBe(true);
  expect(requests("/api/codex/insights").length).toBeGreaterThan(0);
  fireEvent.click(within(region).getByRole("button", { name: "상세 닫기" }));
  expect(screen.queryByRole("region", { name: "사용자 상세" })).toBeNull();
});
