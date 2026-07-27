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

// 모델 색상은 계열(패밀리)별 고정 색상군 — 파스텔/소프트 재설계(미리보기 A안, 사용자 선택):
// sonnet=소프트 페리윙클 블루, opus=소프트 코럴/피치, haiku=세이지 민트그린, fable=더스티
// 로즈. 같은 계열의 버전은 같은 색상군 안에서 신버전일수록 살짝 더 진하게(과격한 대비 아님).
// 인덱스 순환 배정과 달리 기간/필터로 모델 순위가 변해도 색이 흔들리지 않는다(dataviz: 색은
// 엔티티를 따라감). 이전 "팝" 조합은 dataviz validate_palette 전 항목을 강제로 통과시키려고
// 채도를 끌어올렸는데 결과가 안 예뻤다는 피드백으로, 이번엔 검증기를 강제 기준으로 두지 않고
// 미학을 우선했다(사용자 명시 지시) — 계열 구분은 유지되지만 색각이상 분리는 이전보다 약할
// 수 있음, 범례·툴팁이 여전히 보조 인코딩이라 식별엔 문제없음. 키는 normModel() 정규화 후 이름.
const MODEL_COLOR = {
  "claude-sonnet-5": "#6C7CE0",
  "claude-sonnet-4-6": "#93A0EC",
  "claude-sonnet-4-5": "#B7C0F5",
  "claude-opus-5": "#E8845F",
  "claude-opus-4-8": "#F0A47C",
  "claude-opus-4-7": "#F5C09B",
  "claude-opus-4-6": "#FAD8BE",
  "claude-opus-4-5": "#FDEADB",
  "claude-haiku-4-5": "#7FC9A0",
  "claude-haiku-3-5": "#A8DCC0",
  "claude-3-5-haiku": "#A8DCC0",
  "claude-fable-5": "#E091B0",
};
// 미등록 신버전도 계열 기본색으로 — 아예 모르는 모델(null)은 호출부가 기존 팔레트로 폴백.
// 등록색과 겹치지 않는 중간 톤(같은 차트에서 등록 모델과 동일색으로 합쳐 보이는 것 방지) —
// 새 버전이 데이터에 보이면 MODEL_COLOR에 정식 등록하는 게 정도.
const FAMILY_FALLBACK = { sonnet: "#8290E8", opus: "#EDB48E", haiku: "#93D2B0", fable: "#D67CA0" };

export function modelColorFor(model) {
  const m = String(model || "");
  if (MODEL_COLOR[m]) return MODEL_COLOR[m];
  const fam = m.match(/sonnet|opus|haiku|fable/)?.[0];
  return fam ? FAMILY_FALLBACK[fam] : null;
}

// 범례/스택 순서 — 계열은 항상 fable → opus → sonnet → haiku 순으로 고정하고, 계열 내부는
// 최신 모델이 먼저 오게(버전 랭크 0이 최신). 지출 순위 등 데이터 값에 따라 흔들리지 않는
// 고정 순서라는 점이 색상 배정 규칙(엔티티를 따라감)과 동일한 이유다. 미등록 모델/계열
// 밖 값은 각각 그 계열의 마지막, 아예 모르는 값은 전체 마지막으로 보낸다.
const FAMILY_LEGEND_ORDER = ["fable", "opus", "sonnet", "haiku"];
const VERSION_RANK = {
  "claude-fable-5": 0,
  "claude-opus-5": 0,
  "claude-opus-4-8": 1,
  "claude-opus-4-7": 2,
  "claude-opus-4-6": 3,
  "claude-opus-4-5": 4,
  "claude-sonnet-5": 0,
  "claude-sonnet-4-6": 1,
  "claude-sonnet-4-5": 2,
  "claude-haiku-4-5": 0,
  "claude-haiku-3-5": 1,
  "claude-3-5-haiku": 1,
};

export function modelLegendRank(model) {
  const m = String(model || "");
  const fam = m.match(/sonnet|opus|haiku|fable/)?.[0];
  const famIdx = fam ? FAMILY_LEGEND_ORDER.indexOf(fam) : FAMILY_LEGEND_ORDER.length;
  return famIdx * 100 + (VERSION_RANK[m] ?? 99);
}

export function byModelLegendOrder(a, b) {
  return modelLegendRank(a) - modelLegendRank(b);
}
