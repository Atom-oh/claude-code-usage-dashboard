import { expect, test } from "vitest";
import { UNAVAILABLE_LABELS } from "./clientProductivity.js";
import { BUNDLE_LABELS, BUNDLE_OF, NOT_OBSERVED_LABEL, REASON_LABELS, TERM_LABELS, TERMS, changePct, exemplarBars,
  expectedWindow, responseWindowMatches, waterfallSteps } from "./tokenEconomics.js";

const contributions = { users: 595.8845, sessions_per_user: 79.4409, turns_per_session: -181.9964,
  requests_per_turn: 182.0223, tokens_per_request: 231.9086, cost_per_token: -282.2599 };

test("waterfall steps run from the previous cost through six signed contributions to the current cost", () => {
  const steps = waterfallSteps(2519, { contributions });
  expect(steps).toHaveLength(8);
  expect(steps.map((s) => s.key)).toEqual(["previous", ...TERMS, "current"]);
  expect(steps[0]).toMatchObject({ base: 0, value: 2519, kind: "total" });
  const users = steps.find((s) => s.key === "users");
  expect(users).toMatchObject({ base: 2519, value: 595.8845, kind: "growth", label: TERM_LABELS.users });
  // A negative step's base is the running total after it.
  const turns = steps.find((s) => s.key === "turns_per_session");
  expect(turns.base).toBeCloseTo(2519 + 595.8845 + 79.4409 - 181.9964, 9);
  expect(turns).toMatchObject({ value: -181.9964, kind: "waste" });
  expect(steps.find((s) => s.key === "cost_per_token").kind).toBe("price");
  const last = steps.at(-1);
  expect(last.kind).toBe("total");
  expect(last.base).toBe(0);
  expect(Math.abs(last.value - 3144)).toBeLessThan(1e-3);
});

test("waterfall steps are empty without contributions", () => {
  expect(waterfallSteps(2519, { contributions: null, unavailable: "no_previous" })).toEqual([]);
  expect(waterfallSteps(null, { contributions })).toEqual([]);
});

test("changePct has no percentage for a zero or unknown baseline", () => {
  expect(changePct(0, 5)).toBeNull();
  expect(changePct(null, 5)).toBeNull();
  expect(changePct(5, null)).toBeNull();
  expect(changePct(34, 42)).toBeCloseTo(23.53, 2);
  expect(changePct(10, 5)).toBe(-50);
});

test("labels cover every term, bundle and server reason", () => {
  expect(REASON_LABELS).toEqual({ not_backfilled: "백필 전", retention: "보존 기간 초과", window_too_short: "기간 짧음",
    no_matched_sessions: "대상 세션 없음", no_users: "식별 사용자 없음", no_previous: "직전 기간 없음",
    zero_factor: "미산출", not_collected: "미수집" });
  // Shared vocabulary with the rest of shared Productivity: 미수집 / 미집계 / 미산출.
  expect(REASON_LABELS.not_collected).toBe(UNAVAILABLE_LABELS.not_collected);
  expect(REASON_LABELS.zero_factor).toBe(UNAVAILABLE_LABELS.not_derived);
  expect(NOT_OBSERVED_LABEL).toBe(UNAVAILABLE_LABELS.not_aggregated);
  expect(TERM_LABELS).toEqual({ users: "활성 사용자", sessions_per_user: "세션 / 사용자", turns_per_session: "턴 / 세션",
    requests_per_turn: "요청 / 턴", tokens_per_request: "토큰 / 요청", cost_per_token: "$ / 100만 토큰" });
  expect(BUNDLE_LABELS).toEqual({ growth: "성장", waste: "낭비", price: "단가" });
  expect(BUNDLE_OF).toEqual({ users: "growth", sessions_per_user: "growth", turns_per_session: "waste",
    requests_per_turn: "waste", tokens_per_request: "waste", cost_per_token: "price" });
});

test("the response window is the overview window floored to the hour", () => {
  const overview = { from: "2026-09-01T10:34:00.000Z", to: "2026-09-02T09:59:00.000Z" };
  expect(expectedWindow(overview)).toEqual({ from: "2026-09-01T10:00:00.000Z", to: "2026-09-02T09:00:00.000Z" });
  expect(responseWindowMatches(overview, { from: "2026-09-01T10:00:00.000Z", to: "2026-09-02T09:00:00.000Z" })).toBe(true);
  expect(responseWindowMatches(overview, { from: "2026-09-01T09:00:00.000Z", to: "2026-09-02T09:00:00.000Z" })).toBe(false);
  expect(responseWindowMatches(overview, undefined)).toBe(false);
  expect(responseWindowMatches(undefined, { from: "2026-09-01T10:00:00.000Z", to: "2026-09-02T09:00:00.000Z" })).toBe(false);
});

test("exemplar bars point the better side right for a lower-is-better lever", () => {
  const { unit, median, bars } = exemplarBars({ lever: "tokens_per_request", direction: "lower", median: 200,
    top: [{ user: "a", value: 100 }, { user: "b", value: 150 }, { user: "c", value: 250 }] });
  expect(unit).toBe("pct");
  expect(median).toBe(200);
  expect(bars.map((b) => b.delta)).toEqual([-50, -25, 25]);
  expect(bars.map((b) => b.better)).toEqual([true, true, false]);
  // The largest difference spans half the track (from the median line to an edge).
  expect(bars.map((b) => b.width)).toEqual([50, 25, 25]);
});

test("exemplar bars use percentage points for rate levers", () => {
  const { unit, bars } = exemplarBars({ lever: "cache_hit_rate", direction: "higher", median: 0.9,
    top: [{ user: "a", value: 0.95 }, { user: "b", value: 0.88 }] });
  expect(unit).toBe("pt");
  expect(bars[0].delta).toBeCloseTo(5, 9);
  expect(bars[1].delta).toBeCloseTo(-2, 9);
  expect(bars.map((b) => b.better)).toEqual([true, false]);
  expect(bars[0].width).toBe(50);
  expect(bars[1].width).toBeCloseTo(20, 9);
});

test("exemplar bars without a usable median have no difference and no bar", () => {
  for (const median of [null, 0]) {
    const { bars } = exemplarBars({ lever: "requests_per_turn", direction: "lower", median,
      top: [{ user: "a", value: 3 }] });
    expect(bars[0]).toMatchObject({ user: "a", value: 3, delta: null, better: null, width: 0 });
  }
  expect(exemplarBars({ lever: "requests_per_turn", direction: "lower", median: 2, top: null }).bars).toEqual([]);
});

test("an exemplar at the median is neither better nor worse", () => {
  const { bars } = exemplarBars({ lever: "requests_per_turn", direction: "lower", median: 10,
    top: [{ user: "a", value: 5 }, { user: "b", value: 10 }] });
  expect(bars[1]).toMatchObject({ delta: 0, better: null, width: 0 });
});
