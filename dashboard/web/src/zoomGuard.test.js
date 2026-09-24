import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

// 드래그 줌(useDragZoom)을 쓰는 차트를 그리는 모든 호출부의 정적 점검. 시계열 차트는 데이터 훅의
// stale을 zoomDisabled로 넘겨야 한다 — stale인 동안 화면의 행은 이전 기간의 버킷 크기인데 우측 끝
// 보정은 새 선택의 버킷 크기를 쓴다(GroupCharts.jsx useDragZoom 주석). 카테고리 축 차트(horizontal이거나
// xKey가 시간 키가 아닌 차트)는 라벨이 날짜로 파싱되지 않아 줌 자체가 no-op이라 제외한다.
const ZOOMABLE = ["GroupAreaChart", "DualLineChart", "SeriesBarChart", "ModelCostTrend"];
const TIME_KEYS = new Set(["t", "day"]);
// UserDrawer는 useApi가 아닌 자체 fetch로, 기간이 바뀌면 곧바로 "불러오는 중..."으로 비운다 — 이전
// 기간의 행을 보여주는 구간이 없다.
const EXEMPT = new Set(["components/UserDrawer.jsx"]);

function sources() {
  return ["pages", "components"].flatMap((dir) => fs.readdirSync(path.join(__dirname, dir))
    .filter((f) => f.endsWith(".jsx") && !f.endsWith(".test.jsx") && f !== "GroupCharts.jsx")
    .map((f) => `${dir}/${f}`));
}

// <Name ... />를 중괄호 깊이를 세며 잘라낸다 — 속성 안의 JSX(right={<X />})에서 멈추지 않게.
function elements(src, name) {
  const out = [];
  for (const m of src.matchAll(new RegExp(`<${name}\\b`, "g"))) {
    let depth = 0;
    for (let i = m.index + m[0].length; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      else if (depth === 0 && src.startsWith("/>", i)) { out.push(src.slice(m.index, i + 2)); break; }
    }
  }
  return out;
}

test("every drag-zoomable time-series chart suspends zoom while its data hook is stale", () => {
  const found = { guarded: [], unguarded: [], categorical: [], exempt: [] };
  for (const file of sources()) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    for (const name of ZOOMABLE) {
      for (const el of elements(src, name)) {
        const xKey = el.match(/\bxKey="([^"]+)"/)?.[1];
        const site = `${file} <${name} xKey="${xKey}">`;
        if (/\bhorizontal\b/.test(el) || !TIME_KEYS.has(xKey)) found.categorical.push(site);
        else if (EXEMPT.has(file)) found.exempt.push(site);
        else if (/\bzoomDisabled=\{[^}]*\bstale\b[^}]*\}/.test(el)) found.guarded.push(site);
        else found.unguarded.push(site);
      }
    }
  }
  expect(found.unguarded).toEqual([]);
  // 스캐너가 아무것도 찾지 못해 통과하는 일을 막는 호출부 수 — 차트를 더하거나 빼면 이 숫자를 고친다.
  expect([found.guarded.length, found.categorical.length, found.exempt.length]).toEqual([14, 4, 1]);
});
