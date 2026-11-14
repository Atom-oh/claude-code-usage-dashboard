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

// Hue identifies the model family; lightness identifies the version. Each family has five
// steps: its newest model takes the first (darkest on light cards, brightest on dark ones),
// the next three versions follow, and every older version shares the fifth ("older").
// Orange/brown hues stay free for the Claude client and its channels (index.css --client-*,
// --channel-*); Codex is ink. Every step keeps >=3:1 against its card surface, and adjacent
// steps differ by >=7 CIE L*. Backend and emitting client remain separate.
const OTHER_LIGHT = ["#606B7B", "#707989", "#7F8896", "#556171", "#657383", "#77818F"];
const OTHER_DARK = ["#9AA5B5", "#A8B1BF", "#8C99AC", "#B3BCC9", "#9AAABE", "#A6B4C4"];

export const MODEL_FAMILY_COLORS = {
  light: {
    fable: ["#8C064B", "#A3275E", "#BB3F72", "#D25586", "#E76898"],
    opus: ["#244193", "#3E53A8", "#5666BE", "#6D7AD5", "#808CE9"],
    sonnet: ["#034B6E", "#0C5F88", "#0974A5", "#0289C4", "#039DDE"],
    haiku: ["#015226", "#016831", "#007E3D", "#25934F", "#3DA660"],
    astra: ["#6C3065", "#814479", "#96578D", "#AC6CA2", "#BF7EB5"],
    sol: ["#584400", "#6F5600", "#856A13", "#9B7E29", "#AF8F3B"],
    terra: ["#2E4F00", "#3B6400", "#4B790C", "#608E25", "#73A138"],
    luna: ["#064F56", "#03636C", "#0D7883", "#088F9B", "#0EA2B0"],
    other: OTHER_LIGHT,
  },
  dark: {
    fable: ["#FFB0CA", "#FE92B8", "#F676A6", "#E16393", "#CC5081"],
    opus: ["#BFC1FF", "#A7ADFE", "#8E99F7", "#7B87E3", "#6775CF"],
    sonnet: ["#8FCDFE", "#51BDFF", "#17AAF0", "#1497D5", "#1284BB"],
    haiku: ["#74DC91", "#60C87E", "#4CB46C", "#36A15B", "#1D8E4A"],
    astra: ["#F5B0EA", "#E19DD6", "#CD8BC3", "#BA78B0", "#A6669D"],
    sol: ["#E7C26C", "#D2AF5A", "#BE9D48", "#AA8A36", "#967824"],
    terra: ["#A7D569", "#93C157", "#80AE45", "#6D9B32", "#5B891F"],
    luna: ["#01DBED", "#19C5D6", "#14B1C0", "#0F9DAA", "#0A8995"],
    other: OTHER_DARK,
  },
};

// Known versions per family, newest first. Add a new version at the front when it ships:
// every older version then moves one step lighter, and the fifth step collects the rest.
const FAMILY_MODELS = {
  fable: ["claude-fable-5-2", "claude-fable-5-1", "claude-fable-5"],
  opus: ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"],
  sonnet: ["claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5"],
  haiku: ["claude-haiku-5-5", "claude-haiku-4-5", "claude-haiku-3-5"],
  astra: ["gpt-6.1-astra", "gpt-6-astra"],
  sol: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"],
  terra: ["gpt-6-terra", "gpt-5.6-terra"],
  luna: ["gpt-6-luna", "gpt-5.6-luna"],
};
const VERSION_STEPS = 5;

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

// Version numbers of a normalized family model: claude-opus-5-5 -> [5, 5], gpt-6.1-sol -> [6, 1].
function versionOf(name, family) {
  const match = name.match(new RegExp(`^claude-${family}-(\\d+(?:-\\d+)*)$`))
    ?? name.match(new RegExp(`^gpt-(\\d+(?:\\.\\d+)?)-${family}$`));
  return match ? match[1].split(/[-.]/).map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

// Position from the newest known version: a registered version uses its registry index; an
// unregistered one newer than every registered version counts as the newest (-1), anything
// else (older or unparsable) as older than the whole registry.
function versionPosition(name, family) {
  const known = FAMILY_MODELS[family] ?? [];
  const index = known.indexOf(name);
  if (index >= 0) return index;
  const version = versionOf(name, family), newest = known[0] && versionOf(known[0], family);
  return version && newest && compareVersions(version, newest) > 0 ? -1 : known.length;
}

function familyShade(model, family, theme) {
  const name = normalizedFamilyModel(model);
  const palette = MODEL_FAMILY_COLORS[theme === "dark" ? "dark" : "light"][family];
  if (family === "other") {
    let hash = 0;
    for (const ch of name) hash = (Math.imul(hash, 31) + ch.codePointAt(0)) >>> 0;
    return palette[hash % palette.length];
  }
  return palette[Math.min(Math.max(versionPosition(name, family), 0), VERSION_STEPS - 1)];
}

export function familyColorFor(family, theme = "light") {
  return MODEL_FAMILY_COLORS[theme === "dark" ? "dark" : "light"][family]?.[0] ?? null;
}

export function modelColorFor(model, theme = "light") {
  const family = modelFamily(model);
  return family ? familyShade(model, family, theme) : null;
}

// Legend/stack order follows the family registry, independent of spend rankings: Claude
// families from the top tier down, then GPT families from astra. Newer versions come first;
// unrecognized families come last.
export const FAMILY_LEGEND_ORDER = ["fable", "opus", "sonnet", "haiku", "astra", "sol", "terra", "luna"];

export function modelLegendRank(model) {
  const m = normalizedFamilyModel(model);
  const fam = modelFamily(m);
  const famIdx = fam ? FAMILY_LEGEND_ORDER.indexOf(fam) : FAMILY_LEGEND_ORDER.length;
  return famIdx * 100 + (fam ? versionPosition(m, fam) + 1 : 99);
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

// Task trace lanes: one fixed hue per agent kind, shared by timeline bars and the cumulative
// cost band. Several lanes of one kind share its hue; labels tell them apart.
export const LANE_COLOR = {
  main: "var(--chart-1)",
  "general-purpose": "var(--chart-3)",
  Explore: "var(--chart-2)",
  fork: "var(--chart-4)",
  custom: "var(--chart-5)",
};

export function laneColorFor(kind) {
  return LANE_COLOR[kind] || LANE_COLOR.custom;
}
