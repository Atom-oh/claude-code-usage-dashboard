// dataviz 스킬: 카테고리 색상은 고정 순서로 배정, 랭크에 따라 재배정하지 않음.
// bedrock = slot1(blue), enterprise = slot2(aqua) — 항상 이 순서.
// unknown은 서버(queries.js filterCond)가 모든 group 쿼리에서 무조건 걸러내므로 데이터에 나올 일이
// 없다 — GROUP_ORDER에는 안 넣지만, colorFor 폴백용으로 GROUP_COLOR 항목은 남겨둔다.
export const GROUP_COLOR = {
  bedrock: "var(--series-bedrock)",
  enterprise: "var(--series-enterprise)",
  unknown: "var(--series-unknown)",
};

export const GROUP_ORDER = ["bedrock", "enterprise"];

export function colorFor(group) {
  return GROUP_COLOR[group] || GROUP_COLOR.unknown;
}
