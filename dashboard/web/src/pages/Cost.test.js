import { expect, test } from "vitest";
import { mergeUserModelRows, mergeUserRows, groupTotalsText, groupModelSegments } from "./Cost.jsx";

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
  expect(merged[0].groups).toEqual({ bedrock: { cost: 12.34, tokens: 1000, reported: 10 }, enterprise: { cost: 7.21, tokens: 500, reported: 6 } });
  expect(merged[2].groups).toEqual({ bedrock: { cost: 0, tokens: 700, reported: 0 }, unknown: { cost: 0, tokens: 300, reported: 0 } });
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

test("mergeUserRows: 사용자 단위 병합 + 그룹×모델 중첩 breakdown", () => {
  const merged = mergeUserRows(ROWS);
  expect(merged.length).toBe(2);
  const a = merged.find((r) => r.user === "a@x.com");
  // 합계는 user×model 병합과 동일한 수치로 떨어져야 한다(그레인만 달라졌을 뿐).
  expect(a.cost).toBeCloseTo(22.55); // 12.34 + 7.21 + 3 (sonnet 양그룹 + opus bedrock)
  expect(a.groups.bedrock.models).toEqual({
    "claude-sonnet-5": { cost: 12.34, tokens: 1000 },
    "claude-opus-5": { cost: 3, tokens: 300 },
  });
  expect(a.groups.enterprise.models).toEqual({ "claude-sonnet-5": { cost: 7.21, tokens: 500 } });
  const b = merged.find((r) => r.user === "b@x.com");
  // 미산정 모델은 이 표에서 $0으로 계산한다(사용자 지시) — null/배지 없음.
  expect(b.cost).toBe(0);
  expect(b.groups.bedrock.models).toEqual({ "titan-text-lite": { cost: 0, tokens: 700 } });
});

test("groupModelSegments: 값 0 모델 제외, 순서는 범례 규칙 고정", () => {
  const merged = mergeUserRows(ROWS);
  const a = merged.find((r) => r.user === "a@x.com");
  const line = groupModelSegments(a.groups, "bedrock", "cost");
  // opus가 sonnet보다 범례 순서상 먼저다(fable → opus → sonnet → haiku).
  expect(line.segs.map((x) => x.model)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  expect(line.total).toBeCloseTo(15.34);
  // 미산정 모델은 cost 축에서 줄 자체가 없다(토큰 축에는 있다).
  const b = merged.find((r) => r.user === "b@x.com");
  expect(groupModelSegments(b.groups, "bedrock", "cost")).toBeNull();
  expect(groupModelSegments(b.groups, "bedrock", "tokens").total).toBe(700);
});

test("groupTotalsText: 그룹 합계만 — CSV/툴팁용", () => {
  const merged = mergeUserRows(ROWS);
  const a = merged.find((r) => r.user === "a@x.com");
  expect(groupTotalsText(a.groups, "cost")).toBe("bedrock $15.34 · enterprise $7.21");
  const b = merged.find((r) => r.user === "b@x.com");
  expect(groupTotalsText(b.groups, "cost")).toBe("");
  expect(groupTotalsText(b.groups, "tokens")).toBe("bedrock 700토큰 · 미분류 300토큰");
});
