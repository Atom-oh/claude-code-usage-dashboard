import { expect, test } from "vitest";
import { foldLeaderboardByUser } from "./score.js";

// userLeaderboard의 실제 행 모양 — a@x.com은 두 그룹을 오간 straddler.
const ROWS = [
  { user: "a@x.com", group: "bedrock", loc: 300, commits: 3, prs: 2, sessions: 4, accepted: 8, decisions: 10, active_days: 1, user_active_days: 1 },
  { user: "a@x.com", group: "enterprise", loc: 300, commits: 3, prs: 1, sessions: 4, accepted: 2, decisions: 10, active_days: 1, user_active_days: 1 },
  { user: "b@x.com", group: "enterprise", loc: 0, commits: 0, prs: 0, sessions: 2, accepted: 0, decisions: 0, active_days: 1, user_active_days: 1 },
];

test("foldLeaderboardByUser: straddler는 raw 합산 후 재계산 — 그룹별 점수 평균이 아니다", () => {
  const folded = foldLeaderboardByUser(ROWS, 1);
  expect(folded.length).toBe(2);
  const a = folded.find((u) => u.user === "a@x.com");
  // raw 합산: loc 600, commits 6, sessions 8, accepted 10/decisions 20 — 전 항이 캡에 걸린다.
  expect(a.loc).toBe(600);
  expect(a.accept_rate).toBeCloseTo(0.5);
  // 캡 적용 점수: 0.3×1 + 0.25×0.5 + 0.2×1 + 0.15×1 + 0.1×1 = 0.875 → 87.5.
  // 그룹별 점수를 따로 내 평균 내면 다른 값이 나온다(비선형 캡) — 그 회귀를 잡는 단언.
  expect(a.productivity_score).toBeCloseTo(87.5);
});

test("foldLeaderboardByUser: active_days는 합산이 아니라 user_active_days를 그대로 쓴다", () => {
  const folded = foldLeaderboardByUser(ROWS, 1);
  const a = folded.find((u) => u.user === "a@x.com");
  // 같은 날 두 그룹 모두 활동 — 그룹별 active_days(1+1)를 합치면 2로 이중 계상된다.
  expect(a.active_days).toBe(1);
});

test("foldLeaderboardByUser: scoreDays가 분모 — 기간이 길수록 per-day 항이 줄어든다", () => {
  const oneDay = foldLeaderboardByUser(ROWS, 1).find((u) => u.user === "a@x.com");
  const tenDays = foldLeaderboardByUser(ROWS, 10).find((u) => u.user === "a@x.com");
  expect(tenDays.productivity_score).toBeLessThan(oneDay.productivity_score);
});
