import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import App from "../App.jsx";
import { ConfigProvider } from "../ConfigContext.jsx";
import { claudeDetail } from "../test/claudeDetail.js";
import { clientOverview, codexUsage } from "../test/clientOverview.js";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
const LEADER = { user: "alice@example.test", group: "bedrock", loc: 100, commits: 2, prs: 1, sessions: 2,
  active_days: 1, user_active_days: 1, decisions: 10, accepted: 8, productivity_score: 40, tokens: 10 };
const TEAMS = { teams: ["fsi", "ops"] };
const USER_TEAMS = { users: [{ user: "alice@example.test", team: "fsi", teams: ["fsi", "ops"] }] };
let location;
function LocationSpy() { location = useLocation(); return null; }
function mount(entry, overrides = {}, enabledClients = ["codex"]) {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  const fetchMock = vi.fn((url) => {
    const key = String(url).split("?")[0];
    if (overrides[key] === "fail") return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    const data = {
      "/api/health/data": { status: "ok" },
      "/api/teams": TEAMS,
      "/api/users/teams": USER_TEAMS,
      "/api/users/leaderboard": [LEADER, { ...LEADER, user: "bob@example.test" }],
      "/api/clients/overview": clientOverview({ by_user: [{ ...codexUsage, user: "alice@example.test" },
        { ...codexUsage, user: "bob@example.test" }] }),
      ...overrides,
    }[key] ?? [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <ConfigProvider config={{ piiMask: false, groupMode: "single", schema: {}, enabledClients }}>
      <MemoryRouter initialEntries={[entry]}><App /><LocationSpy /></MemoryRouter>
    </ConfigProvider>
  );
  return fetchMock;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const card = (title) => screen.getByText(title, { exact: true }).closest(".shadow-card");
const cells = (title) => [...card(title).querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
async function exportTable(title) {
  let captured;
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { captured = blob; return "blob:test"; };
  URL.revokeObjectURL = () => {};
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  try {
    fireEvent.click(within(card(title)).getByRole("button", { name: "CSV" }));
    return (await captured.text()).replace(/^\uFEFF/, "");
  } finally { click.mockRestore(); URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
}

test("shared users table, CSV and filter control carry the team", async () => {
  const fetchMock = mount("/users");
  await waitFor(() => expect(card("사용자별 사용량").textContent).toContain("fsi, ops"));
  expect(cells("사용자별 사용량").map((r) => r.slice(0, 3))).toEqual([
    ["al******@example.test", "fsi, ops", "Codex $0.0042405 (AWS 정가 추정)"],
    ["bo******@example.test", "—", "Codex $0.0042405 (AWS 정가 추정)"]]);
  const csv = await exportTable("사용자별 사용량");
  expect(csv.startsWith("사용자,팀,클라이언트별 구성,")).toBe(true);
  expect(csv).toContain('\r\nalice@example.test,"fsi, ops",Codex $0.0042405 (AWS 정가 추정),');
  expect(csv).toContain("\r\nbob@example.test,,Codex $0.0042405 (AWS 정가 추정),");
  const select = await screen.findByRole("combobox", { name: "팀" });
  expect([...select.options].map((o) => o.value)).toEqual(["", "fsi", "ops"]);
  fireEvent.change(select, { target: { value: "ops" } });
  await waitFor(() => expect(location.search).toContain("team=ops"));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/clients/overview?")
    && new URL(String(url), "http://localhost").searchParams.get("team") === "ops")).toBe(true));
  const lookups = fetchMock.mock.calls.map(([url]) => String(url))
    .filter((url) => url.startsWith("/api/teams?") || url.startsWith("/api/users/teams?"));
  for (const url of lookups) {
    expect(new URL(url, "http://localhost").searchParams.has("team")).toBe(false);
  }
});

test("shared user costs and the user cost detail title carry the team", async () => {
  mount("/cost");
  await waitFor(() => expect(card("사용자별 비용").textContent).toContain("fsi, ops"));
  expect(cells("사용자별 비용").map((r) => r.slice(0, 2))).toEqual([
    ["al******@example.test", "fsi, ops"], ["bo******@example.test", "—"]]);
  fireEvent.click(within(card("사용자별 비용")).getByRole("button", { name: "al******@example.test" }));
  const heading = await screen.findByRole("heading", { name: /사용자 비용 상세/ });
  expect(heading.textContent).toBe("al******@example.test · fsi, ops · 사용자 비용 상세");
});

test("an unavailable user lookup shows 확인 불가, never the no-team dash", async () => {
  mount("/users", { "/api/users/teams": "fail" });
  await waitFor(() => expect(card("사용자별 사용량").textContent).toContain("확인 불가"));
  expect(cells("사용자별 사용량").map((r) => r[1])).toEqual(["확인 불가", "확인 불가"]);
});

test("Claude detail users table, top bars and user detail carry the team", async () => {
  mount(claudeDetail("/users"), {}, ["claude"]);
  await waitFor(() => expect(document.body.textContent).toContain("fsi, ops"));
  const rows = [...document.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
  expect(rows.map((r) => r.slice(0, 2))).toEqual([["al******@example.test", "fsi, ops"], ["bo******@example.test", "—"]]);
  const labels = [...document.querySelectorAll("span.truncate")].map((e) => e.textContent);
  expect(labels).toContain("al******@example.test · fsi, ops");
  expect(labels).toContain("bo******@example.test");
  fireEvent.click([...document.querySelectorAll("tbody tr")].find((tr) => tr.textContent.includes("al******")));
  const detail = await screen.findByRole("region", { name: "사용자 상세" });
  expect(detail.querySelector("h2").textContent).toBe("al******@example.test · fsi, ops · 사용자 상세");
});

test("Claude detail per-user cost CSV puts the team after the user", async () => {
  mount(claudeDetail("/cost"), { "/api/cost/by-user-model": [
    { user: "alice@example.test", group: "bedrock", model: "claude-sonnet-5", cost: 2, reported_cost: 1, tokens: 10 },
    { user: "bob@example.test", group: "bedrock", model: "claude-sonnet-5", cost: 2, reported_cost: 1, tokens: 10 }] }, ["claude"]);
  await waitFor(() => expect(card("사용자 · 모델별 비용").textContent).toContain("fsi, ops"));
  expect(await exportTable("사용자 · 모델별 비용")).toBe(
    '사용자,팀,비용,토큰,비용 상태\r\nalice@example.test,"fsi, ops",1,10 — bedrock 10토큰,확인됨\r\nbob@example.test,,1,10 — bedrock 10토큰,확인됨');
});
