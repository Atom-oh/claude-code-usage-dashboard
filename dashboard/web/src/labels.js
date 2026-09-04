// 원시 enum 값이 화면이나 CSV에 그대로 나가지 않게 하는 공용 라벨 매퍼.
// 매핑되지 않은 값은 그대로 통과시킨다 — 새 enum 값이 생겨도 빈 셀이 되지 않는다.
export const effortLabel = (v) => (v === "unknown" || v === "" || v == null ? "미지정" : v);
export const unclassifiedLabel = (v) => (v === "unknown" || v === "" || v == null ? "미분류" : v);
export const decisionLabel = (v) => (v === "accept" ? "수락" : v === "reject" ? "거부" : v);
