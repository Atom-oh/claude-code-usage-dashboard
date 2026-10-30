import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { setPiiMask } from "../fmt.js";
import { toCsv } from "../csv.js";
import { SessionTurnsView, USER_COLUMNS, SESSION_COLUMNS, withCostStatus, fmtCost, fmtUnit, fmtRatio, fmtTurns, shortSession, startedText } from "./SessionTurns.jsx";
afterEach(() => { cleanup(); setPiiMask(true); });

const DATA = {
  summary: { sessions: 8, sessions_with_turns: 7, turns: 13, median_turns_per_session: 2, p90_turns_per_session: 3,
    known_cost: 1.625, cost_partial: true, cost_per_turn: 0.875 / 9, model_calls_per_turn: 14 / 13,
    sessions_without_turns: 1, sessions_cost_unavailable: 3 },
  users: [
    { user: "a@example.invalid", sessions: 2, turns: 4, known_cost: 0.75, cost_partial: false, cost_per_turn: 0.1875, cost_per_session: 0.375 },
    { user: "b@example.invalid", sessions: 2, turns: 2, known_cost: 0.75, cost_partial: true, cost_per_turn: null, cost_per_session: 0.75 },
    { user: "", sessions: 1, turns: 1, known_cost: null, cost_partial: false, cost_per_turn: null, cost_per_session: null },
  ],
  sessions: [
    { session: "0123456789abcdef", user: "a@example.invalid", group: "enterprise", started: "2026-10-20T10:01:00Z", turns: 3, model_calls: 5, known_cost: 0.5, cost_partial: false, cost_per_turn: 0.5 / 3 },
    { session: "s4", user: "b@example.invalid", group: "bedrock", started: null, turns: 2, model_calls: 0, known_cost: null, cost_partial: false, cost_per_turn: null },
  ],
};
const view = (props) => render(<SessionTurnsView loading={false} error={null} {...props} />);

test("tiles show distribution, eligible cost per turn and coverage", () => {
  view({ data: DATA });
  expect(screen.getByText("세션·턴 비용")).toBeTruthy();
  expect(screen.getByText("2 / 3")).toBeTruthy();
  expect(screen.getByText("$0.0972")).toBeTruthy();
  expect(screen.getByText("1.08")).toBeTruthy();
  expect(screen.getByText("중앙값 / p90 · 턴 관측 세션 7개")).toBeTruthy();
  expect(screen.getByText("부분합 · 제외: 턴 미관측 1 · 비용 확인 필요 3")).toBeTruthy();
  expect(screen.getByText(/작업 품질이나 생산성/)).toBeTruthy();
});

test("tables mask users and label partial and unavailable costs", () => {
  setPiiMask(true);
  view({ data: DATA });
  expect(screen.getAllByText("a******@example.invalid").length).toBe(2);
  expect(screen.queryByText("a@example.invalid")).toBeNull();
  expect(screen.getByText("(미식별)")).toBeTruthy();
  expect(screen.getByText("01234567…")).toBeTruthy();
  expect(screen.getAllByText("부분합").length >= 1).toBe(true);
  expect(screen.getAllByText("확인 필요").length >= 2).toBe(true);
});

test("user CSV follows displayed columns with raw numbers and masking", () => {
  setPiiMask(true);
  expect(toCsv(USER_COLUMNS, withCostStatus(DATA.users), { piiMask: true })).toBe(
    "\uFEFF사용자,세션,턴,보고 비용,턴당 비용,세션당 비용,비용 상태\r\na******@example.invalid,2,4,0.75,0.1875,0.375,확인됨\r\nb******@example.invalid,2,2,0.75,,0.75,부분합\r\n,1,1,,,,확인 필요"
  );
});

test("session CSV keeps raw ids and local start time", () => {
  setPiiMask(true);
  const cell = (s) => /[",\r\n]/.test(s) ? `"${s}"` : s;
  expect(toCsv(SESSION_COLUMNS, withCostStatus(DATA.sessions), { piiMask: true })).toBe(
    "\uFEFF세션,사용자,채널,첫 이벤트,턴,모델 호출,보고 비용,턴당 비용,비용 상태\r\n"
      + `0123456789abcdef,a******@example.invalid,enterprise,${cell(startedText("2026-10-20T10:01:00Z"))},3,5,0.5,${0.5 / 3},확인됨\r\n`
      + "s4,b******@example.invalid,bedrock,,2,0,,,확인 필요"
  );
});

test("non-object payloads and zero sessions render the empty state", () => {
  for (const data of [[], null, { summary: { ...DATA.summary, sessions: 0 }, users: [], sessions: [] }]) {
    view({ data });
    expect(screen.getByText("선택한 기간에 데이터가 없습니다.")).toBeTruthy();
    cleanup();
  }
});

test("loading, error and model-filter subtitle", () => {
  view({ loading: true });
  expect(screen.getByText("불러오는 중...")).toBeTruthy();
  cleanup();
  view({ error: new Error("x") });
  expect(screen.getByText("데이터를 불러오지 못했습니다.")).toBeTruthy();
  cleanup();
  view({ data: DATA, modelFiltered: true });
  expect(screen.getByText(/모델 필터는 해당 모델을 쓴 세션 전체 기준/)).toBeTruthy();
});

test("formatters keep unavailable values distinct from zero", () => {
  expect(fmtCost(null)).toBe("확인 필요");
  expect(fmtCost(0)).toBe("$0.00");
  expect(fmtCost(0.004)).toBe("<$0.01");
  expect(fmtCost(12.345)).toBe("$12.35");
  expect(fmtUnit(null)).toBe("—");
  expect(fmtUnit(0)).toBe("$0.00");
  expect(fmtUnit(0.875 / 9)).toBe("$0.0972");
  expect(fmtUnit(1234.5)).toBe("$1,234.50");
  expect(fmtRatio(null)).toBe("—");
  expect(fmtRatio(14 / 13)).toBe("1.08");
  expect(fmtTurns(null)).toBe("—");
  expect(fmtTurns(2.5)).toBe("2.5");
  expect(shortSession("0123456789")).toBe("01234567…");
  expect(shortSession("abc")).toBe("abc");
  expect(startedText(null)).toBe("");
});
