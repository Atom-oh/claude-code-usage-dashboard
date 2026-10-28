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

// 한 행 안에서 그룹 세그먼트를 나란히 그리는 자리(스택 바와 그 범례)의 고정 순서.
// GROUP_ORDER는 "어떤 그룹에 카드를 줄지"를 답하는 상수라 unknown이 없어 여기엔 못 쓴다 —
// unknown 행이 실제로 오는 뷰(Cost 페이지의 'unknown 그룹 포함' 체크)에서는 세 번째 세그먼트가
// 필요하다. 색상은 GROUP_COLOR가, 순서는 이 상수가 소유한다.
export const GROUP_SEGMENT_ORDER = [...GROUP_ORDER, "unknown"];

export function colorFor(group) {
  return GROUP_COLOR[group] || GROUP_COLOR.unknown;
}

// Hue identifies the model family; bounded shades distinguish versions without fading
// old/unregistered models into the card surface. Backend and emitting client remain separate.
export const MODEL_FAMILY_COLORS = {
  light: {
    opus: ["#B4532E", "#C66136", "#D37145", "#A84B27", "#BC603C", "#CC6B41"],
    sonnet: ["#355FC7", "#426CCE", "#2D56BA", "#547ADB", "#335EAD", "#496CBC"],
    haiku: ["#167A63", "#20856D", "#2B9077", "#116F59", "#23816B", "#318A75"],
    fable: ["#AF3C70", "#BC4A7C", "#C65889", "#9F3463", "#AF527B", "#BA6087"],
    sol: ["#A76B0F", "#B67A1C", "#C18728", "#94600E", "#AA7729", "#B88536"],
    terra: ["#856044", "#936C4D", "#9F7656", "#78543B", "#89674E", "#97755A"],
    luna: ["#137A9B", "#2287A6", "#3291AF", "#0E6E8F", "#29809C", "#388BA5"],
    astra: ["#7545B8", "#8353C5", "#9062CF", "#6939AA", "#8056B6", "#8D66C0"],
    other: ["#606B7B", "#707989", "#7F8896", "#556171", "#657383", "#77818F"],
  },
  dark: {
    opus: ["#D9855F", "#E5936B", "#CE7851", "#E29A7A", "#D18161", "#DB8E70"],
    sonnet: ["#7898E8", "#89A6EF", "#6F8BDA", "#96B0F1", "#7E9DDF", "#8BA7E5"],
    haiku: ["#52B99A", "#65C5A7", "#43AC8D", "#76CDB3", "#5FB699", "#70C0A5"],
    fable: ["#D97BA6", "#E48DB5", "#CA6B97", "#EA9EC0", "#D886AA", "#E098B8"],
    sol: ["#D5A046", "#E1AF58", "#C59236", "#E8BB70", "#CCA15A", "#D8AF6A"],
    terra: ["#B88B69", "#C69A78", "#AA7D5D", "#CDA588", "#B89073", "#C29D81"],
    luna: ["#51AECA", "#64BCD4", "#409FBF", "#77C6DC", "#58ACC5", "#6AB8CE"],
    astra: ["#AB87E3", "#B99AEF", "#9B76D3", "#C4A9F2", "#AB8BCF", "#B79CDD"],
    other: ["#9AA5B5", "#A8B1BF", "#8C99AC", "#B3BCC9", "#9AAABE", "#A6B4C4"],
  },
};

const FAMILY_MODELS = {
  opus: ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"],
  sonnet: ["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5"],
  haiku: ["claude-haiku-4-5", "claude-haiku-3-5"],
  fable: ["claude-fable-5-1", "claude-fable-5"],
  sol: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"],
  terra: ["gpt-6-terra", "gpt-5.6-terra"],
  luna: ["gpt-6-luna", "gpt-5.6-luna"],
  astra: ["gpt-6-astra", "gpt-6.1-astra"],
};

function normalizedFamilyModel(model) {
  return String(model ?? "").trim().toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^(?:(?:us|us-gov|eu|apac|jp|au|in|global)|[a-z]{2}(?:-gov)?-[a-z]+-\d+)\./, "")
    .replace(/^(?:anthropic|openai)\./, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/^claude-(\d+(?:-\d+)*)-(opus|sonnet|haiku|fable)$/, "claude-$2-$1");
}

export function modelFamily(model) {
  const name = normalizedFamilyModel(model);
  return name.match(/^claude-(opus|sonnet|haiku|fable)(?:-|$)/)?.[1]
    ?? name.match(/^gpt-\d+(?:\.\d+)?-(sol|terra|luna|astra)(?:-|$)/)?.[1]
    ?? null;
}

function familyShade(model, family, theme) {
  const name = normalizedFamilyModel(model);
  const palette = MODEL_FAMILY_COLORS[theme === "dark" ? "dark" : "light"][family];
  const registered = FAMILY_MODELS[family]?.indexOf(name) ?? -1;
  let hash = 0;
  for (const ch of name) hash = (Math.imul(hash, 31) + ch.codePointAt(0)) >>> 0;
  return palette[(registered >= 0 ? registered : hash) % palette.length];
}

export function familyColorFor(family, theme = "light") {
  return MODEL_FAMILY_COLORS[theme === "dark" ? "dark" : "light"][family]?.[0] ?? null;
}

export function modelColorFor(model, theme = "light") {
  const family = modelFamily(model);
  return family ? familyShade(model, family, theme) : null;
}

// Legend/stack order follows the family registry, independent of spend rankings.
// Unregistered versions follow registered versions; unrecognized families come last.
export const FAMILY_LEGEND_ORDER = ["fable", "opus", "sonnet", "haiku", "sol", "terra", "luna", "astra"];

export function modelLegendRank(model) {
  const m = normalizedFamilyModel(model);
  const fam = modelFamily(m);
  const famIdx = fam ? FAMILY_LEGEND_ORDER.indexOf(fam) : FAMILY_LEGEND_ORDER.length;
  const versionIdx = FAMILY_MODELS[fam]?.indexOf(m) ?? -1;
  return famIdx * 100 + (versionIdx >= 0 ? versionIdx : 99);
}

export function byModelLegendOrder(a, b) {
  return modelLegendRank(a) - modelLegendRank(b);
}

// Non-model breakdowns still use backend ramps; model donuts use family hues.
const BLUE_RAMP = ["#1F54C2", "#2E6BE6", "#528DF8", "#7FA9F9", "#A9C7FB", "#D2E2FD"];
const TEAL_RAMP = ["#0F6B57", "#128577", "#01A88D", "#39C2B0", "#8FDFD1", "#D2F3EC"];

function rampFor(group) {
  return group === "bedrock" ? BLUE_RAMP : group === "enterprise" ? TEAL_RAMP : null;
}

export function groupModelColorFor(_group, model, theme = "light") {
  return modelColorFor(model, theme) ?? familyShade(model, "other", theme);
}

// 캐시 티어(4종)·토큰 타입(4종) 도넛용 — 라벨 순서만 다르고 로직은 동일해서 라벨 배열을
// 받는 팩토리 하나로 처리한다. 6단 램프에서 4개를 고르게 뽑아 인접 조각끼리 너무 붙지 않게.
const BREAKDOWN_PICKS = [0, 2, 4, 5];

export function makeGroupBreakdownColorer(group, labelOrder) {
  const ramp = rampFor(group);
  return (label) => {
    if (!ramp) return null;
    const idx = labelOrder.indexOf(label);
    const pick = BREAKDOWN_PICKS[(idx === -1 ? labelOrder.length : idx) % BREAKDOWN_PICKS.length];
    return ramp[pick];
  };
}

// Preserve registered keys and user-series ordering, with the same family shades as donuts.
const TREND_MODELS = [
  "claude-fable-5", "claude-fable-5-1", "claude-sonnet-5", "claude-opus-5", "claude-opus-5-5",
  "claude-opus-4-8", "claude-haiku-4-5", "openai.gpt-5.6-sol", "openai.gpt-6-astra",
  "openai.gpt-5.6-luna", "openai.gpt-6.1-sol", "openai.gpt-6-sol", "openai.gpt-6-luna",
];
export const MODEL_TREND_COLORS = Object.fromEntries(["light", "dark"].map((theme) => [
  theme, Object.fromEntries(TREND_MODELS.map((model) => [model, modelColorFor(model, theme)])),
]));
export const MODEL_TREND_OTHERS = { light: "#A3A9B6", dark: "#5E6678" };
export const MODEL_TREND_VENDOR_RAMPS = {
  anthropic: { light: MODEL_FAMILY_COLORS.light.other.slice(0, 3), dark: MODEL_FAMILY_COLORS.dark.other.slice(0, 3) },
  openai: { light: MODEL_FAMILY_COLORS.light.other, dark: MODEL_FAMILY_COLORS.dark.other },
  other: { light: MODEL_FAMILY_COLORS.light.other, dark: MODEL_FAMILY_COLORS.dark.other },
};
