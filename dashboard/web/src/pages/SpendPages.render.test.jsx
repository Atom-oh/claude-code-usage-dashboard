import { claudeDetail } from "../test/claudeDetail.js";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  cost: 7817.28, reported_cost: 6647.79,
  tokens: 1000, unpriced: false,
};

function mount(path, rows = [spend], costError = false, daily = []) {
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
      "/api/cost/by-model-daily": daily,
      "/api/adoption/levels": { mau: 1 },
    }[key] ?? [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  }));
  return render(
    <ConfigProvider config={{ piiMask: false, groupMode: "single", schema: {} }}>
      <MemoryRouter initialEntries={[claudeDetail(path)]}><App /></MemoryRouter>
    </ConfigProvider>
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("Executive uses reported spend for its totals and narrative", async () => {
  const { container } = mount("/exec");
  await waitFor(() => expect(container.textContent).toContain("기간 비용은 $6,648"));
  expect(container.textContent).not.toContain("$7,817");
});

test("Executive does not turn an unavailable report into a zero forecast", async () => {
  const { container } = mount("/exec", [{ ...spend, reported_cost: 0 }]);
  await waitFor(() => expect(container.textContent).toContain("기간 비용은"));
  expect(container.textContent).toContain("기간 비용은 확인 필요");
  expect(container.textContent).not.toContain("30일 기준 $0");
});

test("Productivity costs include a reported model with no computed price", async () => {
  mount("/productivity", [{ ...spend, cost: null, unpriced: true, reported_cost: 23 }]);
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
  const { container } = mount("/users", [{ ...spend, cost: null, unpriced: true, reported_cost: 23 }]);
  await waitFor(() => expect(container.textContent).toContain("사용자 1명 · 총 비용 $23"));
});

test("Users family average is unavailable when one member has missing reported spend", async () => {
  const { container } = mount("/users", [spend, { ...spend, user: "missing@example.com", reported_cost: 0 }]);
  await waitFor(() => expect(container.textContent).toContain("보고 비용 확인 필요"));
  expect(container.textContent).not.toContain("총 비용 $7,817");
});

// 30 daily rows; one session on 2026-08-05 reported $0 beside tokens (unavailable). The computed
// `cost` (3) must never be drawn: the trend uses reported spend only.
const DAILY30 = Array.from({ length: 30 }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`).flatMap((day, i) => [
  { day, group: "enterprise", model: "claude-sonnet-5", reported_cost: 2, reported_partial: false, reported_unavailable: 0,
    reported_reasons: { report_missing: 0, report_zero_with_tokens: 0 }, reported_all_unavailable: false, cost: 3 },
  ...(i === 4 ? [{ day, group: "bedrock", model: "claude-opus-5", reported_cost: null, reported_partial: true, reported_unavailable: 1,
    reported_reasons: { report_missing: 0, report_zero_with_tokens: 1 }, reported_all_unavailable: true, cost: 5 }] : []),
]);
const trendCard = async () => (await screen.findByText("모델별 비용 추이", { exact: true, selector: "div" })).closest(".rounded-lg");
const dailyRequests = () => fetch.mock.calls.map(([url]) => new URL(String(url), "http://localhost"))
  .filter((u) => u.pathname === "/api/cost/by-model-daily").map((u) => u.searchParams.get("intervalHours"));
// The active SegmentedControl button in the card (the "표 보기" toggle never carries the brand class).
const activeBucket = (card) => [...card.querySelectorAll("button")].find((b) => b.className.includes("bg-brand-500"))?.textContent;
const rowCells = (row) => [...row.querySelectorAll("td")].slice(1).map((td) => td.textContent);

test.each(["/cost?days=30", "/exec?days=30"])("%s draws the reported model cost trend and keeps the unavailable cell out of the bars", async (path) => {
  // Recharts draws only with a layout size in jsdom; this file's other tests never read chart internals.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300, x: 0, y: 0 });
  mount(path, [spend], false, DAILY30);
  const card = await trendCard();
  // The chart is drawn despite the unavailable cell; each bucket renders one state mark.
  await waitFor(() => expect(card.querySelector(".recharts-wrapper")).not.toBeNull());
  await waitFor(() => expect(card.querySelectorAll("[data-state]").length).toBe(30));
  const status = card.querySelector('[role="status"]');
  expect(status.querySelector("[data-status-headline]").textContent).toBe("확인 필요 1개 버킷 · 1개 항목");
  expect(status.querySelector('[data-reason="report_zero_with_tokens"]').textContent).toBe("보고 0·토큰 있음 1건 — claude-opus-5 · bedrock 1건");
  expect(card.textContent).toContain("Claude 보고 비용");
  fireEvent.click(within(card).getByRole("button", { name: "표 보기" }));
  const bucketRows = card.querySelectorAll("tr[data-bucket]");
  expect(rowCells(bucketRows[0])).toEqual(["$2", "—", "$2", "확인됨"]);
  expect(rowCells(bucketRows[4])).toEqual(["$2", "— ⚠", "$2", "부분합"]);
  expect(dailyRequests().every((v) => v === "24")).toBe(true);
});

test.each([
  ["/exec", "24", "일간"],
  ["/exec?from=2026-07-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z", "168", "주간"],
])("Executive %s defaults its model cost bucket to %s hours", async (path, hours, label) => {
  mount(path, [spend], false, DAILY30);
  // Executive: 24h buckets up to 30 days, 168h above; a manual pick still requests the chosen bucket.
  await waitFor(() => expect(dailyRequests().length).toBeGreaterThan(0));
  expect(dailyRequests()[0]).toBe(hours);
  const card = await trendCard();
  expect(activeBucket(card)).toBe(label);
  fireEvent.click(within(card).getByRole("button", { name: "시간별" }));
  await waitFor(() => expect(dailyRequests().at(-1)).toBe("1"));
});

test("a manual Executive bucket pick resets to the default when the range changes", async () => {
  mount("/exec", [spend], false, DAILY30);
  const card = await trendCard();
  fireEvent.click(within(card).getByRole("button", { name: "시간별" }));
  await waitFor(() => expect(dailyRequests().at(-1)).toBe("1"));
  // The pick belongs to the range it was made in: a range change restores the 24h default at once.
  fireEvent.click(screen.getByRole("button", { name: "7일", exact: true }));
  await waitFor(() => expect(dailyRequests().at(-1)).toBe("24"));
  expect(activeBucket(await trendCard())).toBe("일간");
});
