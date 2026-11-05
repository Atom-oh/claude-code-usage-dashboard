import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RangeProvider } from "../RangeContext.jsx";
import { toCsv } from "../csv.js";
import { TeamCostView, TEAM_COLUMNS, teamTableRows } from "./TeamCostSection.jsx";
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
