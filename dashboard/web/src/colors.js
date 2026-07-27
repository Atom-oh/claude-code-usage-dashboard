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

// 모델 색상은 계열(패밀리)별 고정 색상군 — sonnet=코발트 블루, opus=에메랄드 틸,
// haiku=버니시드 앰버, fable=딥 플럼. 같은 계열의 버전은 같은 색상군 안에서 신버전일수록
// 진한 톤. 인덱스 순환 배정과 달리 기간/필터로 모델 순위가 변해도 색이 흔들리지 않는다
// (dataviz: 색은 엔티티를 따라감). 대시보드 브랜드(코발트 #528df8 / 아쿠아 #39C2B0)와
// 동조하는 톤으로 골랐고, 활성 6종 조합을 dataviz validate_palette로 전 항목(명도 밴드·
// 채도·CVD 분리·일반시각 분리) PASS 확인 — 라이트 셰이드 2종의 3:1 대비 WARN은 범례·
// 툴팁·테이블(보조 인코딩)로 해소. 키는 normModel() 정규화 후 이름.
const MODEL_COLOR = {
  "claude-sonnet-5": "#2B4FD8",
  "claude-sonnet-4-6": "#5C7DEB",
  "claude-sonnet-4-5": "#8AA8F7",
  "claude-opus-5": "#0B8563",
  "claude-opus-4-8": "#45CDAA",
  "claude-opus-4-7": "#7FE3C4",
  "claude-opus-4-6": "#A5EBD3",
  "claude-haiku-4-5": "#B45309",
  "claude-haiku-3-5": "#E8940F",
  "claude-3-5-haiku": "#E8940F",
  "claude-fable-5": "#832B60",
};
// 미등록 신버전도 계열 기본색으로 — 아예 모르는 모델(null)은 호출부가 기존 팔레트로 폴백.
const FAMILY_FALLBACK = { sonnet: "#5C7DEB", opus: "#29B08A", haiku: "#DB8B1D", fable: "#A34E86" };

export function modelColorFor(model) {
  const m = String(model || "");
  if (MODEL_COLOR[m]) return MODEL_COLOR[m];
  const fam = m.match(/sonnet|opus|haiku|fable/)?.[0];
  return fam ? FAMILY_FALLBACK[fam] : null;
}
