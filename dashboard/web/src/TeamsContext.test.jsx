import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider } from "./ConfigContext.jsx";
import { RefreshProvider } from "./RefreshContext.jsx";
import { RangeProvider } from "./RangeContext.jsx";
import { FilterProvider } from "./FilterContext.jsx";
import { useApi } from "./useApi.js";
import { toCsv } from "./csv.js";
import { ClientProvider } from "./ClientContext.jsx";
import { FilterBar } from "./components/FilterBar.jsx";
import { DEVICE_TEAM_MARKER, TeamsContext, TeamsProvider, teamDisplay, teamName, teamSuffix, teamText, teamsValue, useTeams, withTeamColumn, withTeams } from "./TeamsContext.jsx";
import { maskTeam, setTeamMask } from "./fmt.js";

// Team logic under raw names; display masking has its own tests (TeamsContext.test.jsx).
beforeEach(() => setTeamMask(false));
afterEach(() => setTeamMask(true));

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

test("a stale or loading roster is unavailable, never a confirmed absence", () => {
  const list = { data: { teams: ["fsi"] } };
  const roster = { data: { users: [{ user: "a@example.invalid", teams: ["fsi"] }] }, loading: false, stale: false };
  expect(teamText(teamsValue(list, roster), "z@example.invalid")).toBe("—");
  for (const pending of [{ stale: true }, { loading: true }]) {
    const teams = teamsValue(list, { ...roster, ...pending });
    expect(teams.byUser).toBeNull();
    expect(teams.options).toEqual(["fsi"]);
    expect(teamText(teams, "a@example.invalid")).toBe("\u2026");
    expect(teamText(teams, "z@example.invalid", { csv: true })).toBe("확인 불가");
    expect(teamSuffix(teams, "a@example.invalid")).toBe("");
  }
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

test("teamText shows labels and marks device teams", () => {
  const list = { data: { teams: ["field-ags-korea-all-cs", "dev"], labels: { "field-ags-korea-all-cs": "Korea CS" },
    sources: { "field-ags-korea-all-cs": "directory", dev: "device" }, historyStart: 1000, directory: true } };
  const users = { data: { users: [{ user: "a@example.invalid", team: "field-ags-korea-all-cs",
    teams: ["field-ags-korea-all-cs", "dev"], sources: ["directory", "device"] },
    { user: "b@example.invalid", team: "x", teams: ["x"], sources: ["both"] }] } };
  const teams = teamsValue(list, users);
  expect(teamText(teams, "a@example.invalid")).toBe(`Korea CS, dev ${DEVICE_TEAM_MARKER}`);
  expect(teamText(teams, "a@example.invalid", { csv: true })).toBe("Korea CS, dev");
  expect(teamText(teams, "b@example.invalid")).toBe("x");
  expect(teamSuffix(teams, "a@example.invalid")).toBe(` · Korea CS, dev ${DEVICE_TEAM_MARKER}`);
  expect(teamName(teams, "field-ags-korea-all-cs")).toBe("Korea CS");
  expect(teams.historyStart).toBe(1000);
  expect(teams.directory).toBe(true);
});

test("without a directory, device teams are not marked and labels still apply", () => {
  const list = { data: { teams: ["dev", "x"], labels: { x: "X팀" }, sources: { dev: "device", x: "device" }, historyStart: null, directory: false } };
  const users = { data: { users: [{ user: "a@example.invalid", team: "dev", teams: ["dev", "x"], sources: ["device", "device"] }] } };
  const teams = teamsValue(list, users);
  expect(teams.directory).toBe(false);
  expect(teamText(teams, "a@example.invalid")).toBe("dev, X팀");
  expect(teamSuffix(teams, "a@example.invalid")).toBe(" · dev, X팀");
  const [, column] = withTeamColumn([{ key: "user" }], teams);
  expect(column.render(null, { user: "a@example.invalid" })).toBe("dev, X팀");
});

test("the team column explains sources where a device marker appears", () => {
  const list = { data: { teams: ["dev"], sources: { dev: "device" }, directory: true } };
  const users = { data: { users: [{ user: "a@example.invalid", team: "dev", teams: ["dev"], sources: ["device"] }] } };
  const teams = teamsValue(list, users);
  const [, column] = withTeamColumn([{ key: "user" }], teams);
  const { container } = render(<>{column.render(null, { user: "a@example.invalid" })}</>);
  const cell = container.querySelector("span");
  expect(cell.textContent).toBe(`dev ${DEVICE_TEAM_MARKER}`);
  expect(cell.title).toBe("표시 없음: 조직 디렉터리(Cognito) 기준 · (기기 제공 값): 기기가 보낸 team 값");
  expect(column.toText(null, { user: "a@example.invalid" })).toBe("dev");
});

test("team values naming inherited properties render as raw strings", () => {
  const raws = ["__proto__", "constructor", "toString"];
  const users = { data: { users: [{ user: "a@example.invalid", teams: raws, sources: ["device", "device", "device"] }] } };
  for (const list of [{ data: { teams: raws } }, { data: { teams: raws, labels: {}, sources: {}, directory: true } },
    { data: JSON.parse('{"teams":["__proto__"],"labels":{"__proto__":{"x":1},"constructor":7},"directory":false}') }]) {
    const teams = teamsValue(list, users);
    for (const raw of raws) {
      expect(teamName(teams, raw)).toBe(raw);
      expect(teamDisplay(teams, raw)).toBe(raw);
    }
    expect(teamText(teams, "a@example.invalid", { csv: true })).toBe("__proto__, constructor, toString");
  }
  for (const raw of raws) expect(teamName({ labels: {} }, raw)).toBe(raw);
  expect(teamText({ ...TEAMS, labels: {}, byUser: new Map([["a@example.invalid", raws]]) }, "a@example.invalid"))
    .toBe("__proto__, constructor, toString");
});

test("the filter control renders a __proto__ team without throwing", () => {
  render(
    <MemoryRouter initialEntries={["/cost"]}>
      <ClientProvider><FilterProvider>
        <TeamsContext.Provider value={{ options: ["__proto__", "constructor"], byUser: new Map(), loading: false,
          labels: {}, sources: {}, directory: true }}>
          <FilterBar />
        </TeamsContext.Provider>
      </FilterProvider></ClientProvider>
    </MemoryRouter>
  );
  const select = screen.getByRole("combobox", { name: "팀" });
  expect([...select.options].map((o) => [o.value, o.textContent]))
    .toEqual([["", "모든 팀"], ["__proto__", "__proto__"], ["constructor", "constructor"]]);
});

test("an older server without the new fields keeps raw values", () => {
  const teams = teamsValue({ data: { teams: ["fsi"] } }, { data: { users: [{ user: "a@example.invalid", teams: ["fsi"] }] } });
  expect(teams.labels).toEqual({});
  expect(teams.sources).toEqual({});
  expect(teams.historyStart).toBeNull();
  expect(teams.directory).toBe(false);
  expect(teamText(teams, "a@example.invalid")).toBe("fsi");
});

// Display masking (PII_MASK_ENABLED): directory values can be personal aliases.
test("masked team names keep two characters and a stable digest, so distinct teams stay distinct", () => {
  setTeamMask(true);
  const names = ["alpha", "alpine", "bravo", "bravado", "cobalt", "cobra"].map((raw) => maskTeam(raw));
  expect(names[0]).toMatch(/^al\*\*·[0-9a-f]{4}$/);
  expect(new Set(names).size).toBe(names.length);
  expect(maskTeam("alpha")).toBe(names[0]);
  expect(maskTeam("")).toBe("");
  setTeamMask(false);
  expect(maskTeam("alpha")).toBe("alpha");
});

test("an administrator label is shown as is while unlabelled teams are masked everywhere they render", () => {
  setTeamMask(true);
  const teams = { ...TEAMS, labels: { fsi: "결제플랫폼팀" } };
  expect(teamName(teams, "fsi")).toBe("결제플랫폼팀");
  expect(teamName(teams, "ops")).toBe(maskTeam("ops"));
  expect(teamText(teams, "a@example.invalid")).toBe(`결제플랫폼팀, ${maskTeam("ops")}`);
  expect(teamText(teams, "a@example.invalid", { csv: true })).toBe(`결제플랫폼팀, ${maskTeam("ops")}`);
  expect(teamSuffix(teams, "b@example.invalid")).toBe(" · 결제플랫폼팀");
  expect(teamText(teams, "a@example.invalid")).not.toContain("ops,");
});
