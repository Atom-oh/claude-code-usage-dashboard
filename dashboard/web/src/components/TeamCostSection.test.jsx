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
    .toBe("﻿팀,비용,전체 대비,토큰,요청,활성 사용자,세션");
  expect(toCsv(TEAM_COLUMNS, teamTableRows(TABLE), { piiMask: true }).split("\r\n")[3]).toBe("팀 없음,1,25.0%,10,3,1,2");
});

test("CSV export is disabled while a response is stale", () => {
  view(ok(TABLE, { stale: true }));
  expect(screen.getByRole("button", { name: /CSV/ }).disabled).toBe(true);
});
