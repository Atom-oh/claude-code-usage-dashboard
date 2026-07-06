// dataviz 스킬: 카테고리 색상은 고정 순서로 배정, 랭크에 따라 재배정하지 않음.
// bedrock = slot1(blue), enterprise = slot2(aqua) — 항상 이 순서.
export const GROUP_COLOR = {
  bedrock: "var(--series-bedrock)",
  enterprise: "var(--series-enterprise)",
  unknown: "var(--series-unknown)",
};

export const GROUP_ORDER = ["bedrock", "enterprise", "unknown"];

export function colorFor(group) {
  return GROUP_COLOR[group] || GROUP_COLOR.unknown;
}
