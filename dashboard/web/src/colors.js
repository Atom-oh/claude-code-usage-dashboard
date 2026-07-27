// dataviz 스킬: 카테고리 색상은 고정 순서로 배정, 랭크에 따라 재배정하지 않음.
// bedrock = slot1(blue), enterprise = slot2(aqua) — 항상 이 순서.
// unknown은 A/B 비교 쿼리(GROUP BY group으로 bedrock/enterprise를 나란히 비교하는 대부분의
// 엔드포인트)에서는 서버가 걸러내지만, "총계" 엔드포인트(activeUsers/adoptionLevels/
// adoptionTimeseries/kpiSummary/costSummary — queries.js filterCond 정책표 참고)는
// excludeUnknown:false라 unknown 행이 그대로 온다(예: Overview "그룹별 KPI 요약" 표에 세
// 번째 행으로 보임). GROUP_ORDER에는 안 넣지만(좌우 2카드 분리 UI가 정확한 문자열로만
// 필터링해 unknown 행이 있어도 안전), colorFor 폴백용으로 GROUP_COLOR 항목은 남겨둔다.
export const GROUP_COLOR = {
  bedrock: "var(--series-bedrock)",
  enterprise: "var(--series-enterprise)",
  unknown: "var(--series-unknown)",
};

export const GROUP_ORDER = ["bedrock", "enterprise"];

export function colorFor(group) {
  return GROUP_COLOR[group] || GROUP_COLOR.unknown;
}

// 모델 색상은 계열(패밀리)별 고정 색상군 — sonnet=블루, opus=그린, haiku=앰버, fable=블랙.
// 같은 계열의 버전은 같은 색상군 안에서 신버전일수록 진한 톤. 인덱스 순환 배정과 달리
// 기간/필터가 바뀌어 모델 순위가 변해도 색이 흔들리지 않는다(dataviz: 색은 엔티티를 따라감).
// 팔레트는 dataviz validate_palette로 검증(활성 6종 CVD·일반시각 분리 PASS) — fable의
// 검정(#1F2937)은 lightness/chroma 가드에 걸리지만 "블랙계열" 요구사항에 따른 의도된 예외
// (범례·툴팁·테이블이 보조 인코딩). 키는 normModel() 정규화 후 이름.
const MODEL_COLOR = {
  "claude-sonnet-5": "#1D4ED8",
  "claude-sonnet-4-6": "#3B82F6",
  "claude-sonnet-4-5": "#60A5FA",
  "claude-opus-5": "#047857",
  "claude-opus-4-8": "#10B981",
  "claude-opus-4-7": "#34D399",
  "claude-opus-4-6": "#6EE7B7",
  "claude-haiku-4-5": "#D97706",
  "claude-haiku-3-5": "#F59E0B",
  "claude-3-5-haiku": "#F59E0B",
  "claude-fable-5": "#1F2937",
};
// 미등록 신버전도 계열 기본색으로 — 아예 모르는 모델(null)은 호출부가 기존 팔레트로 폴백.
const FAMILY_FALLBACK = { sonnet: "#3B82F6", opus: "#10B981", haiku: "#F59E0B", fable: "#374151" };

export function modelColorFor(model) {
  const m = String(model || "");
  if (MODEL_COLOR[m]) return MODEL_COLOR[m];
  const fam = m.match(/sonnet|opus|haiku|fable/)?.[0];
  return fam ? FAMILY_FALLBACK[fam] : null;
}
