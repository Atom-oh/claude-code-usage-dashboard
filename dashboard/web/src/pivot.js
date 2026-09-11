import { GROUP_ORDER } from "./colors.js";

// [{t, group, value}] → [{t, bedrock: v, enterprise: v}] — Recharts wants one row per x-tick.
export function pivotByGroup(rows, xKey, valueKey) {
  const byX = new Map();
  for (const r of rows || []) {
    if (!byX.has(r[xKey])) byX.set(r[xKey], { [xKey]: r[xKey] });
    byX.get(r[xKey])[r.group] = r[valueKey] == null ? null : Number(r[valueKey]);
  }
  return [...byX.values()].sort((a, b) => new Date(a[xKey]) - new Date(b[xKey]));
}

export function groupsPresent(rows) {
  const seen = new Set((rows || []).map((r) => r.group));
  return GROUP_ORDER.filter((g) => seen.has(g));
}

// 카드를 그룹별로 나란히 놓는 자리에서 "어떤 그룹을 그릴지"의 단일 규칙.
// ab 모드는 항상 두 그룹 — 한쪽이 비어 있어도 빈 카드를 그리는 게 A/B 실험 대시보드의 의도다
// (그 자리에 카드가 없으면 "아직 데이터가 없다"와 "그 채널이 없다"가 구별되지 않는다).
// single 모드는 응답에 실제로 등장한 그룹만. 응답이 통째로 비었으면 첫 그룹 하나로 접어
// 카드 자체는 남긴다 — 카드가 사라지면 왜 비었는지 말할 자리도 사라진다.
// 상단 채널 필터가 걸리면 그 채널 카드만 — 서버가 이미 그 채널만 주므로 빈 상대 카드는 정보가 아니라 소음이다.
export function groupsShown(groupMode, rows, groupFilter = "") {
  if (GROUP_ORDER.includes(groupFilter)) return [groupFilter];
  if (groupMode !== "single") return GROUP_ORDER;
  const present = groupsPresent(rows);
  return present.length ? present : [GROUP_ORDER[0]];
}

// single 모드에서 "A/B", "bedrock vs enterprise" 같은 대결 표현을 중립 문구로 바꾼다.
export function groupLabel(groupMode, abText, singleText) {
  return groupMode === "single" ? singleText : abText;
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
    const point = byX.get(r[xKey]);
    point[s] = point[s] === null || r[valueKey] == null ? null : (point[s] || 0) + Number(r[valueKey]);
  }
  const data = [...byX.values()].sort((a, b) => {
    const da = new Date(a[xKey]).getTime(), db = new Date(b[xKey]).getTime();
    return Number.isNaN(da) || Number.isNaN(db) ? 0 : da - db;
  });
  return { data, series };
}

// [{user, group, key, count}] → {"user|group": {key, count}} — 유저×그룹별 1위 항목만 뽑는다
// (leaderboard용 "주요 도구/스킬" 컬럼). group까지 키에 넣는 이유: 리더보드가 유저×그룹으로
// 행이 갈라져 있어(userLeaderboard) user만으로 조회하면 다른 그룹의 top이 잘못 붙는다.
export function topPerUser(rows, keyField, countField) {
  const top = new Map();
  for (const r of rows || []) {
    const k = `${r.user}|${r.group}`;
    const prev = top.get(k);
    if (!prev || Number(r[countField]) > prev.count) {
      top.set(k, { key: r[keyField], count: Number(r[countField]) });
    }
  }
  return top;
}
