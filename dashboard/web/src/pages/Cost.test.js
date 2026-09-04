import { expect, test } from "vitest";
import { mergeUserModelRows, groupShareText } from "./Cost.jsx";

// /api/cost/by-user-model의 실제 행 모양(user × group × model). a@x.com은 양 그룹을 오간
// straddler, b@x.com은 단가표에 없는 모델(cost null)이라 토큰 기준으로 떨어진다.
const ROWS = [
  { user: "a@x.com", group: "bedrock", model: "claude-sonnet-5", cost: 12.34, reported_cost: 10, tokens: 1000, unpriced: false },
  { user: "a@x.com", group: "enterprise", model: "claude-sonnet-5", cost: 7.21, reported_cost: 6, tokens: 500, unpriced: false },
  { user: "a@x.com", group: "bedrock", model: "claude-opus-5", cost: 3, reported_cost: 2, tokens: 300, unpriced: false },
  { user: "b@x.com", group: "bedrock", model: "titan-text-lite", cost: null, reported_cost: 0, tokens: 700, unpriced: true },
  { user: "b@x.com", group: "unknown", model: "titan-text-lite", cost: null, reported_cost: 0, tokens: 300, unpriced: true },
];

test("mergeUserModelRows: user×model 병합 + 그룹별 breakdown 누적", () => {
  const merged = mergeUserModelRows(ROWS);
  expect(merged.length).toBe(3);
  expect(merged[0].groups).toEqual({ bedrock: { cost: 12.34, tokens: 1000 }, enterprise: { cost: 7.21, tokens: 500 } });
  expect(merged[2].groups).toEqual({ bedrock: { cost: 0, tokens: 700 }, unknown: { cost: 0, tokens: 300 } });
  // 응답에 없는 그룹 키는 만들지 않는다 — 이 행은 bedrock만 봤다.
  expect(Object.keys(merged[1].groups)).toEqual(["bedrock"]);
});

test("mergeUserModelRows: 합계 컬럼은 groups 추가 전과 동일", () => {
  const merged = mergeUserModelRows(ROWS);
  // rest 객체로 비교해야 total 컬럼이 이름이 바뀌거나 새 키가 몰래 추가되는 회귀도 잡힌다
  // (개별 expect는 놓친 키를 조용히 통과시킨다).
  const { groups: g0, ...totals0 } = merged[0];
  expect(totals0).toEqual({ user: "a@x.com", model: "claude-sonnet-5", unpriced: false, cost: 19.55, reported_cost: 16, tokens: 1500 });
  const { groups: g1, ...totals1 } = merged[1];
  expect(totals1).toEqual({ user: "a@x.com", model: "claude-opus-5", unpriced: false, cost: 3, reported_cost: 2, tokens: 300 });
  const { groups: g2, ...totals2 } = merged[2];
  // 미산정 행은 cost가 null로 남아야 한다 — 0이 되면 "미산정" 배지가 사라진다.
  expect(totals2).toEqual({ user: "b@x.com", model: "titan-text-lite", unpriced: true, cost: null, reported_cost: 0, tokens: 1000 });
});

test("groupShareText: 계산 비용 기준 비중 + 툴팁 문자열", () => {
  const merged = mergeUserModelRows(ROWS);
  // 이 문자열은 막대의 title 툴팁과 CSV 셀 둘 다에 그대로 쓰인다.
  expect(groupShareText(merged[0].groups)).toBe("bedrock $12.34 (63%) · enterprise $7.21 (37%)");
});

test("groupShareText: 미산정 행은 토큰 기준으로 폴백", () => {
  const merged = mergeUserModelRows(ROWS);
  expect(groupShareText(merged[2].groups)).toBe("bedrock 700토큰 (70%) · unknown 300토큰 (30%)");
  // 두 기준이 섞이면 안 된다 — cost 기준 문자열엔 "토큰"이 나오지 않아야 한다.
  expect(groupShareText(merged[0].groups)).not.toContain("토큰");
});

test("groupShareText: 세그먼트 순서는 행 등장 순서와 무관", () => {
  const REVERSED_ROWS = [
    { user: "c@x.com", group: "enterprise", model: "claude-sonnet-5", cost: 7.21, reported_cost: 6, tokens: 500, unpriced: false },
    { user: "c@x.com", group: "bedrock", model: "claude-sonnet-5", cost: 12.34, reported_cost: 10, tokens: 1000, unpriced: false },
  ];
  const merged = mergeUserModelRows(REVERSED_ROWS);
  // 데이터가 실제로 enterprise를 먼저 봤다는 증거(insertion order) — 아니면 아래 단언이 무의미하다.
  expect(Object.keys(merged[0].groups)).toEqual(["enterprise", "bedrock"]);
  // 하지만 렌더 순서는 GROUP_SEGMENT_ORDER로 고정 — bedrock이 항상 먼저 나온다.
  expect(groupShareText(merged[0].groups)).toBe("bedrock $12.34 (63%) · enterprise $7.21 (37%)");
});

test("groupShareText: 기준값이 없으면 빈 문자열(CSV 빈 칸)", () => {
  expect(groupShareText({})).toBe("");
  expect(groupShareText(undefined)).toBe("");
  expect(groupShareText({ bedrock: { cost: 0, tokens: 0 } })).toBe("");
});
