import { GROUP_ORDER } from "./colors.js";

// [{t, group, value}] → [{t, bedrock: v, enterprise: v}] — Recharts wants one row per x-tick.
export function pivotByGroup(rows, xKey, valueKey) {
  const byX = new Map();
  for (const r of rows || []) {
    if (!byX.has(r[xKey])) byX.set(r[xKey], { [xKey]: r[xKey] });
    byX.get(r[xKey])[r.group] = Number(r[valueKey]);
  }
  return [...byX.values()].sort((a, b) => new Date(a[xKey]) - new Date(b[xKey]));
}

export function groupsPresent(rows) {
  const seen = new Set((rows || []).map((r) => r.group));
  return GROUP_ORDER.filter((g) => seen.has(g));
}

// pivotByGroup의 일반화 버전 — 그룹이 아니라 임의의 카테고리 컬럼(예: model)으로 피벗.
// 함께 등장하는 카테고리 값들도 반환(차트에서 어떤 시리즈를 그릴지 결정하는 데 씀).
// xKey가 날짜가 아닌 카테고리 값(예: tool 이름)이면 new Date(...)가 Invalid Date가 되어 정렬
// comparator가 NaN을 반환한다 — 안정 정렬이라 우연히 SQL의 ORDER BY(첫 등장 순)를 유지하지만
// 암묵적 의존은 fragile하므로, Invalid Date일 땐 명시적으로 원래 순서를 유지한다.
export function pivotByKey(rows, xKey, seriesKey, valueKey) {
  const byX = new Map();
  const series = [];
  for (const r of rows || []) {
    if (!byX.has(r[xKey])) byX.set(r[xKey], { [xKey]: r[xKey] });
    const s = r[seriesKey];
    if (!series.includes(s)) series.push(s);
    byX.get(r[xKey])[s] = (byX.get(r[xKey])[s] || 0) + Number(r[valueKey]);
  }
  const data = [...byX.values()].sort((a, b) => {
    const da = new Date(a[xKey]).getTime(), db = new Date(b[xKey]).getTime();
    return Number.isNaN(da) || Number.isNaN(db) ? 0 : da - db;
  });
  return { data, series };
}

// [{user, key, count}] → {user: {key, count}} — 유저별 1위 항목만 뽑는다 (leaderboard용 "주요 도구/스킬" 컬럼).
export function topPerUser(rows, keyField, countField) {
  const top = new Map();
  for (const r of rows || []) {
    const prev = top.get(r.user);
    if (!prev || Number(r[countField]) > prev.count) {
      top.set(r.user, { key: r[keyField], count: Number(r[countField]) });
    }
  }
  return top;
}

