import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App.jsx";
import { ConfigProvider } from "../ConfigContext.jsx";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const user = {
  user: "reader@example.com", group: "bedrock", loc: 100, commits: 2, prs: 1,
  sessions: 2, active_days: 1, decisions: 10, accepted: 8, productivity_score: 40,
};
const spend = {
  user: user.user, group: "bedrock", model: "claude-sonnet-5",
  cost: 7817.28, reported_cost: 6647.79, display_cost: 6647.79,
  reported_cost_status: "reported", tokens: 1000, unpriced: false,
};

function mount(path, rows = [spend], costError = false) {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("fetch", vi.fn((url) => {
    const key = String(url).split("?")[0];
    if (costError && key === "/api/cost/by-user-model") return Promise.reject(new Error("cost unavailable"));
    const data = {
      "/api/health/data": { status: "ok" },
      "/api/overview/active-users": { users: 1, bedrock_users: 1, enterprise_users: 0 },
      "/api/overview/kpi": [{ ...user, lines_of_code: 100 }],
      "/api/users/leaderboard": [user],
      "/api/cost/by-user-model": rows,
      "/api/cost/summary": rows.map((r) => ({ ...r, computed_cost: r.cost })),
      "/api/adoption/levels": { mau: 1 },
    }[key] ?? [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  }));
  return render(
    <ConfigProvider config={{ piiMask: false, groupMode: "single", schema: {} }}>
      <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>
    </ConfigProvider>
  );
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("Executive uses reported spend for its totals and narrative", async () => {
  const { container } = mount("/exec");
  await waitFor(() => expect(container.textContent).toContain("기간 비용은 $6,648"));
  expect(container.textContent).not.toContain("$7,817");
});

test("Executive does not turn an unavailable report into a zero forecast", async () => {
  const { container } = mount("/exec", [{ ...spend, display_cost: null, reported_cost_status: "partial" }]);
  await waitFor(() => expect(container.textContent).toContain("기간 비용은"));
  expect(container.textContent).toContain("기간 비용은 확인 필요");
  expect(container.textContent).not.toContain("30일 기준 $0");
});

test("Productivity costs include a reported model with no computed price", async () => {
  mount("/productivity", [{ ...spend, cost: null, unpriced: true, display_cost: 23, reported_cost: 23 }]);
  const row = await screen.findByRole("row", { name: /example\.com/ });
  expect(within(row).getByText("$23")).toBeTruthy();
  expect(row.textContent).not.toContain("$0");
});

test("Productivity missing cost rows stay unavailable without changing scores", async () => {
  mount("/productivity", []);
  const row = await screen.findByRole("row", { name: /example\.com/ });
  expect(row.textContent).toContain("확인 필요");
  expect(row.textContent).not.toContain("$0");
});

test("Productivity cost fetch failure does not render a zero-cost leaderboard", async () => {
  mount("/productivity", [spend], true);
  await screen.findByText("데이터를 불러오지 못했습니다.");
  expect(within(screen.getByRole("main")).queryByText("사용자별 생산성")).toBeNull();
  expect(screen.getByText("생산성 점수 상위 10위")).toBeTruthy();
});

test("Users family averages include reported spend independently of pricing coverage", async () => {
  const { container } = mount("/users", [{ ...spend, cost: null, unpriced: true, display_cost: 23, reported_cost: 23 }]);
  await waitFor(() => expect(container.textContent).toContain("사용자 1명 · 총 비용 $23"));
});

test("Users family average is unavailable when one member has missing reported spend", async () => {
  const { container } = mount("/users", [spend, { ...spend, user: "missing@example.com", display_cost: null }]);
  await waitFor(() => expect(container.textContent).toContain("보고 비용 확인 필요"));
  expect(container.textContent).not.toContain("총 비용 $7,817");
});
