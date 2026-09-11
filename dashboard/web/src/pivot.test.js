import { expect, test } from "vitest";
import { groupsShown, pivotByGroup, pivotByKey } from "./pivot.js";

test("a chart preserves missing spend rather than drawing a zero", () => {
  expect(pivotByGroup([{ day: "2026-09-07", group: "bedrock", cost: null }], "day", "cost"))
    .toEqual([{ day: "2026-09-07", bedrock: null }]);
  const rows = [
    { day: "2026-09-07", model: "sonnet", cost: 5 },
    { day: "2026-09-07", model: "sonnet", cost: null },
    { day: "2026-09-07", model: "sonnet", cost: 7 },
    { day: "2026-09-08", model: "sonnet", cost: 0 },
  ];
  expect(pivotByKey(rows, "day", "model", "cost").data)
    .toEqual([{ day: "2026-09-07", sonnet: null }, { day: "2026-09-08", sonnet: 0 }]);
});

test("ab 모드 + 필터 없음/무효 필터: 항상 두 그룹 — 빈 카드도 정보라는 기존 의도 유지", () => {
  expect(groupsShown("ab", [])).toEqual(["bedrock", "enterprise"]);
  // "unknown"은 GROUP_ORDER에 없다 — 필터로 취급하지 않고 기존 동작 그대로.
  expect(groupsShown("ab", [], "unknown")).toEqual(["bedrock", "enterprise"]);
  expect(groupsShown("ab", [], "")).toEqual(["bedrock", "enterprise"]);
});

test("ab 모드 + 채널 필터: 필터가 이겨 그 채널 하나만", () => {
  expect(groupsShown("ab", [], "bedrock")).toEqual(["bedrock"]);
  expect(groupsShown("ab", [], "enterprise")).toEqual(["enterprise"]);
});

test("채널 필터는 rows에 그 그룹이 없어도 이긴다 — 서버가 이미 필터했으니 rows는 판단 근거가 아니다", () => {
  // 이 변경의 핵심 계약: rows에 상대 채널만 있어도 필터가 지정한 채널 하나만 반환한다.
  expect(groupsShown("ab", [{ group: "enterprise" }], "bedrock")).toEqual(["bedrock"]);
  // single 모드에서도 같다 — 필터 가드가 groupMode 분기보다 먼저다.
  expect(groupsShown("single", [{ group: "bedrock" }], "enterprise")).toEqual(["enterprise"]);
});

test("single 모드 무필터: 등장한 그룹만, 응답이 비면 첫 그룹으로 접어 카드는 남긴다", () => {
  expect(groupsShown("single", [{ group: "enterprise" }])).toEqual(["enterprise"]);
  expect(groupsShown("single", [])).toEqual(["bedrock"]);
});
