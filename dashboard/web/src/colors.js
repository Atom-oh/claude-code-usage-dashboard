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

// 모델 색상은 계열(패밀리)별 고정 색상군 — 미리보기 4안(팝)에서 사용자가 고른 배치:
// sonnet=블루, opus=딥 오렌지, haiku=라이트 그린, fable=핑크. 같은 계열의 버전은 같은
// 색상군 안에서 신버전일수록 진한 톤. 인덱스 순환 배정과 달리 기간/필터로 모델 순위가
// 변해도 색이 흔들리지 않는다(dataviz: 색은 엔티티를 따라감). 활성 6종 조합을 dataviz
// validate_palette로 전 항목 PASS 확인 — 웜 계열 3종(오렌지·핑크·라임)은 색각이상에서
// 색상 축이 겹쳐 명도 사다리(진한 오렌지 0.44 / 핑크 0.55 / 오렌지 0.65 / 라임 0.76)로
// 분리했고, 그래서 핑크는 딥 라즈베리(#C2255C) 톤이다. 명도 단계를 바꾸면 분리가
// 깨지므로 조정 시 재검증 필수. 키는 normModel() 정규화 후 이름.
const MODEL_COLOR = {
  "claude-sonnet-5": "#3B5BDB",
  "claude-sonnet-4-6": "#647FE6",
  "claude-sonnet-4-5": "#8DA4F0",
  "claude-opus-5": "#8A360D",
  "claude-opus-4-8": "#E8690C",
  "claude-opus-4-7": "#F2933F",
  "claude-opus-4-6": "#F8B26E",
  "claude-haiku-4-5": "#82C716",
  "claude-haiku-3-5": "#A9E34B",
  "claude-3-5-haiku": "#A9E34B",
  "claude-fable-5": "#C2255C",
};
// 미등록 신버전도 계열 기본색으로 — 아예 모르는 모델(null)은 호출부가 기존 팔레트로 폴백.
const FAMILY_FALLBACK = { sonnet: "#647FE6", opus: "#D2600F", haiku: "#94D82D", fable: "#E64980" };

export function modelColorFor(model) {
  const m = String(model || "");
  if (MODEL_COLOR[m]) return MODEL_COLOR[m];
  const fam = m.match(/sonnet|opus|haiku|fable/)?.[0];
  return fam ? FAMILY_FALLBACK[fam] : null;
}
