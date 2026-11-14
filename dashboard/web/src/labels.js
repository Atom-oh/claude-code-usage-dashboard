import { translate } from "./i18n/index.js";
// 원시 enum 값이 화면이나 CSV에 그대로 나가지 않게 하는 공용 라벨 매퍼.
// 매핑되지 않은 값은 그대로 통과시킨다 — 새 enum 값이 생겨도 빈 셀이 되지 않는다.
export const effortLabel = (v) => (v === "unknown" || v === "" || v == null ? translate("m050d981c6c43") : v);
export const unclassifiedLabel = (v) => (v === "unknown" || v === "" || v == null ? translate("m6ef390cf7926") : v);
export const decisionLabel = (v) => (v === "accept" ? translate("m688200c48345") : v === "reject" ? translate("me3ecc00b93af") : v);
