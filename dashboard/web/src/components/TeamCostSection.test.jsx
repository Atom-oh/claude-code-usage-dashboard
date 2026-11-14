import { afterEach, beforeEach, expect, test } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RangeProvider } from "../RangeContext.jsx";
import { toCsv } from "../csv.js";
import { DEVICE_TEAM_MARKER, TeamsContext } from "../TeamsContext.jsx";
import { TeamCostView, TEAM_COLUMNS, teamBarRows, teamTableRows } from "./TeamCostSection.jsx";
import { setTeamMask } from "../fmt.js";

// Team logic under raw names; display masking has its own tests (TeamsContext.test.jsx).
beforeEach(() => setTeamMask(false));
afterEach(() => setTeamMask(true));
afterEach(cleanup);

const row = (team, cost, patch = {}) => ({ team, known_reported_cost: cost, reported_partial: false, reported_cost: cost,
  computed_cost: 0, input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, tokens: 10,
  unpriced_tokens: 0, users: 1, sessions: 2, requests: 3, ...patch });
const TABLE = [row("A", 3, { users: 2 }), row("B", null), row(null, 1)];
const ok = (data, patch = {}) => ({ data, loading: false, error: null, stale: false, ...patch });
function Providers({ children }) { return <MemoryRouter><RangeProvider>{children}</RangeProvider></MemoryRouter>; }
const view = (table = ok(TABLE), trend = ok([])) => render(
  <TeamCostView table={table} trend={trend} intervalHours={24} onIntervalHours={() => {}} />, { wrapper: Providers });

test("TeamCostSection shows cards, table and 팀 없음 last", () => {
  view();
  expect(screen.getByText("팀별 비용")).toBeTruthy();
  const tile = (label) => screen.getByText(label).closest("div.relative");
  expect(within(tile("활성 팀")).getByText("2")).toBeTruthy();
  expect(within(tile("팀이 확인된 비용 비중")).getByText("75.0%")).toBeTruthy();
  const table = screen.getByRole("table");
  const cells = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);
  expect(cells).toEqual(["A", "B", "팀 없음"]);
  expect(within(within(table).getAllByRole("row")[2]).getAllByRole("cell")[1].textContent).toBe("확인 필요");
});

test("team CSV follows the displayed columns", () => {
  expect(toCsv(TEAM_COLUMNS, teamTableRows(TABLE), { piiMask: true }).split("\r\n")[0])
    .toBe("﻿팀,비용,전체 대비,토큰,요청,활성 사용자,세션,비용 상태");
  const lines = toCsv(TEAM_COLUMNS, teamTableRows([row("A", 3, { reported_partial: true }), row("B", null), row(null, 1)]),
    { piiMask: true }).split("\r\n");
  expect(lines[1].endsWith(",부분합")).toBe(true);
  expect(lines[2].endsWith(",확인 필요")).toBe(true);
  expect(lines[3]).toBe("팀 없음,1,25.0%,10,3,1,2,확인됨");
});

test("CSV export is disabled while a response is stale", () => {
  view(ok(TABLE, { stale: true }));
  expect(screen.getByRole("button", { name: /CSV/ }).disabled).toBe(true);
});

test("the team trend draws the top 8 teams and 팀 없음", () => {
  const day = "2026-11-01T00:00:00Z";
  const cell = (team, cost) => ({ day, group: "enterprise", team, reported_cost: cost, reported_unavailable: 0,
    reported_reasons: {}, reported_partial: false, observed_tokens: 1 });
  view(ok(TABLE), ok([...Array.from({ length: 8 }, (_, i) => cell(`team-${i}`, 10 + i)), cell("", 1)]));
  for (let i = 0; i < 8; i++) expect(screen.getAllByText(`team-${i}`).length).toBeGreaterThan(0);
  expect(screen.getAllByText("팀 없음").length).toBeGreaterThan(1);
});

test("팀 없음 stays last when the table is sorted", async () => {
  const { fireEvent } = await import("@testing-library/react");
  view(ok([row("A", 3), row(null, 9), row("B", 1)]));
  const order = () => within(screen.getByRole("table")).getAllByRole("row").slice(1)
    .map((r) => within(r).getAllByRole("cell")[0].textContent);
  for (const header of ["비용", "비용", "팀"]) {
    fireEvent.click(within(screen.getByRole("table")).getByText(header));
    expect(order().at(-1)).toBe("팀 없음");
  }
});

test("a range-total bar compares known team spend", () => {
  view();
  expect(screen.getByText("팀별 비용 분포")).toBeTruthy();
});

test("tiles and the bar disclose partial and unavailable team spend", () => {
  view(ok([row("A", 3, { reported_partial: true }), row("B", null), row(null, 1)]));
  expect(screen.getAllByText(/부분합 포함/).length).toBeGreaterThan(1);
  expect(screen.getAllByText(/확인 필요 팀 1개 제외/).length).toBeGreaterThan(1);
});

const NOTE = /이전 사용량은 처음 동기화한 부서 기준입니다\./;

test("the history note names the first-sync date and shows only when the range starts before it", () => {
  const withTeams = (historyStart) => render(
    <TeamsContext.Provider value={{ options: [], byUser: null, loading: false, labels: { A: "Alpha" }, sources: {}, historyStart }}>
      <TeamCostView table={ok(TABLE)} trend={ok([])} intervalHours={24} onIntervalHours={() => {}} />
    </TeamsContext.Provider>, { wrapper: Providers });
  const start = Date.now() + 86400000;
  const early = withTeams(start);
  const date = new Date(start).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
  expect(screen.getByText(NOTE).textContent).toBe(`${date} 이전 사용량은 처음 동기화한 부서 기준입니다.`);
  expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
  early.unmount();
  withTeams(Date.now() - 365 * 86400000);
  expect(screen.queryByText(NOTE)).toBeNull();
  cleanup();
  withTeams(null);
  expect(screen.queryByText(NOTE)).toBeNull();
});

const directoryTeams = (directory) => ({ options: [], byUser: null, loading: false, labels: { A: "Alpha", B: "Beta" },
  sources: { A: "directory", B: "device" }, historyStart: null, directory });
const day = "2026-11-01T00:00:00Z";
const trendCell = (team, cost) => ({ day, group: "enterprise", team, reported_cost: cost, reported_unavailable: 0,
  reported_reasons: {}, reported_partial: false, observed_tokens: 1 });
const withDirectory = (directory, trend = ok([])) => render(
  <TeamsContext.Provider value={directoryTeams(directory)}>
    <TeamCostView table={ok(TABLE)} trend={trend} intervalHours={24} onIntervalHours={() => {}} />
  </TeamsContext.Provider>, { wrapper: Providers });
const firstColumn = () => within(screen.getByRole("table")).getAllByRole("row").slice(1)
  .map((r) => within(r).getAllByRole("cell")[0]);

test("the team table marks device teams with a source tooltip while a directory applies; CSV keeps names", () => {
  withDirectory(true);
  const cells = firstColumn();
  expect(cells.map((c) => c.textContent)).toEqual(["Alpha", `Beta ${DEVICE_TEAM_MARKER}`, "팀 없음"]);
  expect(cells[1].querySelector("[title]").title).toContain("조직 디렉터리(Cognito)");
  expect(cells[0].querySelector("[title]")).toBeNull();
  const rows = teamTableRows(TABLE, directoryTeams(true));
  expect(toCsv(TEAM_COLUMNS, rows, { piiMask: true }).split("\r\n").slice(1, 4).map((l) => l.split(",")[0]))
    .toEqual(["Alpha", "Beta", "팀 없음"]);
});

test("without a directory the team table shows labels and no marker", () => {
  withDirectory(false);
  expect(firstColumn().map((c) => c.textContent)).toEqual(["Alpha", "Beta", "팀 없음"]);
});

test("the team trend uses the same team names as the table", () => {
  withDirectory(true, ok([trendCell("A", 5), trendCell("B", 3)]));
  expect(screen.getAllByText("Alpha").length).toBeGreaterThan(1);
  expect(screen.getAllByText(`Beta ${DEVICE_TEAM_MARKER}`).length).toBeGreaterThan(1);
  expect(screen.queryByText("A")).toBeNull();
});

test("the help explains directory teams at session start, else the device value", () => {
  view();
  const help = screen.getAllByLabelText(/세션 시작 시점의 팀/)[0].getAttribute("aria-label");
  expect(help).toContain("조직 디렉터리(Cognito)");
  expect(help).toContain("기기가 보낸 team 값");
  expect(help).not.toContain("OTel team 값에 붙습니다");
});

test("range-total bars group by the raw team even when two teams share a displayed name", () => {
  const rows = teamTableRows([row("alpha", 3), row("alpine", 2), row("bravo", null), row(null, 1)])
    .map((r) => (r.team ? { ...r, label: "al**" } : r));
  const bars = teamBarRows(rows);
  expect(bars.rows.map((r) => r.team)).toEqual(["team:alpha", "team:alpine", "none"]);
  expect(new Set(bars.rows.map((r) => r.team)).size).toBe(3);
  expect(bars.rows.map((r) => bars.label(r.team))).toEqual(["al**", "al**", "팀 없음"]);
});
