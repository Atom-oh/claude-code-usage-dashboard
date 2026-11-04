import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider } from "./ConfigContext.jsx";
import { RefreshProvider } from "./RefreshContext.jsx";
import { RangeProvider } from "./RangeContext.jsx";
import { FilterProvider } from "./FilterContext.jsx";
import { useApi } from "./useApi.js";
import { toCsv } from "./csv.js";
import { TeamsProvider, teamSuffix, teamText, useTeams, withTeamColumn, withTeams } from "./TeamsContext.jsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const TEAMS = { options: ["fsi", "ops"], loading: false,
  byUser: new Map([["a@example.invalid", ["fsi", "ops"]], ["b@example.invalid", ["fsi"]]]) };
const UNAVAILABLE = { options: [], byUser: null, loading: false };
const LOADING = { ...UNAVAILABLE, loading: true };

function stubFetch(responses = {}) {
  const fetchMock = vi.fn((url) => {
    const key = String(url).split("?")[0];
    if (responses[key] === "fail") return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    const body = key === "/api/config" ? {} : responses[key] ?? {};
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const requested = (fetchMock, path) => fetchMock.mock.calls.map(([url]) => new URL(String(url), "http://localhost"))
  .filter((url) => url.pathname === path);
function TeamsProbe() {
  const teams = useTeams();
  return <p data-testid="teams">{`${teams.options.join(",")}|${teamText(teams, "a@example.invalid")}|${teamText(teams, "z@example.invalid")}`}</p>;
}
function Request({ path, options }) { useApi(path, {}, true, options); return null; }
function mount(entry, children) {
  return render(
    <MemoryRouter initialEntries={[entry]}><ConfigProvider><RefreshProvider><RangeProvider><FilterProvider>
      <TeamsProvider>{children}</TeamsProvider>
    </FilterProvider></RangeProvider></RefreshProvider></ConfigProvider></MemoryRouter>);
}
const LOOKUPS = { "/api/teams": { teams: ["fsi", "ops"] },
  "/api/users/teams": { users: [{ user: "a@example.invalid", team: "fsi", teams: ["fsi", "ops"] }] } };

test("teamText distinguishes several teams, none and an unavailable lookup", () => {
  expect(teamText(TEAMS, "a@example.invalid")).toBe("fsi, ops");
  expect(teamText(TEAMS, "b@example.invalid")).toBe("fsi");
  expect(teamText(TEAMS, "z@example.invalid")).toBe("—");
  expect(teamText(TEAMS, "z@example.invalid", { csv: true })).toBe("");
  expect(teamText(UNAVAILABLE, "a@example.invalid")).toBe("확인 불가");
  expect(teamText(UNAVAILABLE, "a@example.invalid", { csv: true })).toBe("확인 불가");
  expect(teamText(LOADING, "a@example.invalid")).toBe("\u2026");
  expect(teamText(LOADING, "a@example.invalid", { csv: true })).toBe("확인 불가");
});

test("teamSuffix labels only known teams", () => {
  expect(teamSuffix(TEAMS, "a@example.invalid")).toBe(" · fsi, ops");
  expect(teamSuffix(TEAMS, "z@example.invalid")).toBe("");
  expect(teamSuffix(UNAVAILABLE, "a@example.invalid")).toBe("");
});

test("withTeamColumn inserts the team column right after the user column", () => {
  const columns = [{ key: "client", label: "클라이언트" }, { key: "user", label: "사용자" }, { key: "cost", label: "비용" }];
  const out = withTeamColumn(columns, TEAMS);
  expect(out.map((c) => c.key)).toEqual(["client", "user", "team", "cost"]);
  expect(out[2].label).toBe("팀");
  expect(out[2].render(undefined, { user: "a@example.invalid" })).toBe("fsi, ops");
  expect(out[2].toText(undefined, { user: "z@example.invalid" })).toBe("");
  const plain = [{ key: "model", label: "모델" }];
  expect(withTeamColumn(plain, TEAMS)).toBe(plain);
});

test("withTeams adds the primary team for sorting and null for none or unavailable", () => {
  expect(withTeams([{ user: "a@example.invalid", n: 1 }, { user: "z@example.invalid" }], TEAMS))
    .toEqual([{ user: "a@example.invalid", n: 1, team: "fsi" }, { user: "z@example.invalid", team: null }]);
  expect(withTeams([{ user: "a@example.invalid" }], UNAVAILABLE)).toEqual([{ user: "a@example.invalid", team: null }]);
  expect(withTeams(undefined, TEAMS)).toEqual([]);
});

test("CSV exports the team after the user, empty for none and 확인 불가 when unavailable", () => {
  const cols = [{ key: "user", label: "사용자" }, { key: "n", label: "N" }];
  const csv = toCsv(withTeamColumn(cols, TEAMS),
    withTeams([{ user: "a@example.invalid", n: 1 }, { user: "z@example.invalid", n: 2 }], TEAMS), { piiMask: false });
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv.slice(1)).toBe('사용자,팀,N\r\na@example.invalid,"fsi, ops",1\r\nz@example.invalid,,2');
  expect(toCsv(withTeamColumn(cols, UNAVAILABLE), [{ user: "a@example.invalid", n: 1 }], { piiMask: false }).slice(1))
    .toBe("사용자,팀,N\r\na@example.invalid,확인 불가,1");
});

test("the shared team lookups are requested without any filter", async () => {
  const fetchMock = stubFetch(LOOKUPS);
  mount("/cost?team=fsi&model=sonnet", <TeamsProbe />);
  await waitFor(() => expect(screen.getByTestId("teams").textContent).toBe("fsi,ops|fsi, ops|—"));
  for (const path of ["/api/teams", "/api/users/teams"]) {
    const urls = requested(fetchMock, path);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      for (const key of ["team", "model", "user", "group", "project", "backend"]) {
        expect(url.searchParams.has(key)).toBe(false);
      }
      expect(url.searchParams.has("from") && url.searchParams.has("to")).toBe(true);
    }
  }
});

test("a failed user lookup is unavailable, not no team", async () => {
  stubFetch({ ...LOOKUPS, "/api/users/teams": "fail" });
  mount("/cost", <TeamsProbe />);
  await waitFor(() => expect(screen.getByTestId("teams").textContent).toBe("fsi,ops|확인 불가|확인 불가"));
});

test("useApi forwards team only to endpoints that apply it", async () => {
  const fetchMock = stubFetch(LOOKUPS);
  mount("/cost?team=fsi&model=sonnet", <>
    <Request path="/api/overview/kpi" /><Request path="/api/clients/overview" /><Request path="/api/adoption/levels" />
    <Request path="/api/codex/insights" /><Request path="/api/cost/summary" options={{ unfiltered: true }} />
  </>);
  const paths = ["/api/overview/kpi", "/api/clients/overview", "/api/adoption/levels", "/api/codex/insights", "/api/cost/summary"];
  await waitFor(() => { for (const p of paths) expect(requested(fetchMock, p).length).toBeGreaterThan(0); });
  const first = (p) => requested(fetchMock, p)[0].searchParams;
  expect(first("/api/overview/kpi").get("team")).toBe("fsi");
  expect(first("/api/overview/kpi").get("model")).toBe("sonnet");
  expect(first("/api/clients/overview").get("team")).toBe("fsi");
  expect(first("/api/adoption/levels").has("team")).toBe(false);
  expect(first("/api/adoption/levels").get("model")).toBe("sonnet");
  expect(first("/api/codex/insights").has("team")).toBe(false);
  expect(first("/api/cost/summary").has("team")).toBe(false);
  expect(first("/api/cost/summary").has("model")).toBe(false);
});
