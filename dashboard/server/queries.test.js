import { test } from "node:test";
import assert from "node:assert/strict";
import { bucket, filterCond, alignHistoricalTo, range } from "./queries.js";
import { toChDateTime } from "./clickhouse.js"; // queries.js가 이미 로드하는 모듈 — 부작용 없음

// bucket()이 intervalHours를 세 가지 버킷(분/시/일)으로 올바르게 매핑하는지 — 차트 드래그 줌이
// 넘기는 fractional intervalHours(예: 15분=0.25)가 UInt32 MINUTE로 환산되는 게 핵심.
test("bucket maps intervalHours to minute/hour/day intervals", () => {
  assert.deepEqual(bucket(0.25).params, { intervalMinutes: 15 }); // 15분 줌
  assert.match(bucket(0.25).expr, /INTERVAL \{intervalMinutes:UInt32\} MINUTE/);
  assert.deepEqual(bucket(5 / 60).params, { intervalMinutes: 5 }); // 5분 줌(최소)
  assert.deepEqual(bucket(1).params, { intervalHours: 1 }); // 기본 시간 버킷
  assert.match(bucket(1).expr, /INTERVAL \{intervalHours:UInt32\} HOUR/);
  assert.deepEqual(bucket(24).params, { intervalDays: 1 }); // 일 버킷
  assert.deepEqual(bucket(168).params, { intervalDays: 7 }); // 주간(반올림)
  // 0에 수렴하는 값도 최소 1분으로 클램프 — INTERVAL 0 MINUTE 방지.
  assert.deepEqual(bucket(0.001).params, { intervalMinutes: 1 });
});

// activeUsers/adoptionLevels(총계 지표)는 excludeUnknown:false로 unknown 세션도 포함해야
// "전체 유저 수"가 실제보다 작게 나오지 않는다(PR #9 리뷰에서 MAJOR로 확인) — 그 외 쿼리는
// 기본값(true)으로 계속 unknown을 제외해야 A/B 비교에 노이즈가 안 낀다.
test("filterCond excludes unknown group by default, includes it when excludeUnknown:false", () => {
  const cols = { group: "grp" };
  assert.match(filterCond({}, cols).where, /grp != 'unknown'/);
  assert.doesNotMatch(filterCond({ excludeUnknown: false }, cols).where, /!= 'unknown'/);
  // group 필터 자체(사용자가 명시적으로 bedrock/enterprise를 고른 경우)는 excludeUnknown과
  // 무관하게 항상 적용된다.
  const f = filterCond({ group: "bedrock", excludeUnknown: false }, cols);
  assert.match(f.where, /grp = \{fGroup:String\}/);
  assert.equal(f.params.fGroup, "bedrock");
});

// incFlat/incBucketed의 `hour < {to}` 경계는 to가 정각이 아니면 그 hour 버킷 전체(최대 59분)를
// 포함해 과대집계한다 — to=현재(기본 뷰)에서는 "더 신선할 뿐"이라 그대로 두지만, 드래그 줌 같은
// 과거 임의 to에서는 실제 오차다(PR #9 리뷰에서 MAJOR로 확인). alignHistoricalTo가 이 둘을
// 구분해야 한다.
test("alignHistoricalTo leaves live `to` untouched, aligns historical `to` to the hour", () => {
  const now = new Date();
  assert.equal(alignHistoricalTo(now).getTime(), now.getTime()); // 라이브 뷰: 그대로
  const past = new Date(now.getTime() - 3 * 3600000 - 17 * 60000); // 3시간 17분 전
  const aligned = alignHistoricalTo(past);
  assert.equal(aligned.getTime(), Math.floor(past.getTime() / 3600000) * 3600000); // 정각으로 내림
});

// range()가 alignHistoricalTo(to)를 무조건 적용하면, from/to가 같은 시간(hour) 안에 있는 짧은
// 과거 구간(분 단위 드래그 줌)에서 to만 정각으로 내려가 from보다 작아져 역전된다 — 서버가
// "WHERE ... >= from AND ... < to"에서 from > to면 빈 결과를 낸다(PR #9 리뷰에서 CRITICAL로
// 확인: 이 PR의 핵심 신기능인 분 단위 드래그 줌이 통째로 깨지는 회귀였다).
test("range() never produces an inverted from>to window for short historical spans", () => {
  // 3시간 전의 :15~:45(같은 hour 안, 30분 구간) — alignHistoricalTo(to)가 정렬하면 to는
  // 그 hour의 :00으로 내려가 from(:15)보다 앞서게 된다(역전). range()는 이 경우 정렬을
  // 포기하고 원본 to를 써야 한다.
  const now = new Date();
  const hourAgo3 = new Date(Math.floor((now.getTime() - 3 * 3600000) / 3600000) * 3600000); // 3시간 전의 정각
  const from = new Date(hourAgo3.getTime() + 15 * 60000); // :15
  const to = new Date(hourAgo3.getTime() + 45 * 60000); // :45
  const r = range(from, to);
  assert.ok(new Date(r.from) <= new Date(r.to), `expected from<=to, got ${r.from} > ${r.to}`);
  assert.equal(r.to, toChDateTime(to)); // 역전 위험 시 원본 to 그대로 유지
});

// 경계 케이스: from이 이미 정각이면 alignHistoricalTo(to)가 from과 "같아질" 수 있다 —
// `aligned < from`만 검사하면 이 경우를 놓쳐 [10:00,10:00) 빈 창이 된다(리뷰에서 MAJOR로
// 재확인). `aligned <= from`으로 같음도 역전으로 취급해야 한다.
test("range() handles the exact-hour-boundary edge case (from is already on the hour)", () => {
  const now = new Date();
  const hourAgo3 = new Date(Math.floor((now.getTime() - 3 * 3600000) / 3600000) * 3600000); // 정각
  const from = hourAgo3; // :00 그대로
  const to = new Date(hourAgo3.getTime() + 45 * 60000); // :45 — 정렬하면 to도 :00 → from과 같음
  const r = range(from, to);
  assert.ok(new Date(r.from) < new Date(r.to), `expected from<to, got ${r.from} >= ${r.to}`);
  assert.equal(r.to, toChDateTime(to));
});

// raw=true(분 버킷, incBucketedRaw 경로)면 hour 정렬을 절대 적용하지 않는다 — 이 경로는
// TimeUnix로 경계를 직접 계산해 부분-hour 과대집계 문제가 없으므로, 정렬하면 오히려 마지막
// 최대 59분이 잘려나간다(리뷰에서 MAJOR로 확인: 2.5시간 같은 raw 허용 구간에서 재현).
test("range() skips hour-alignment entirely when raw=true, even for long historical spans", () => {
  const now = new Date();
  const from = new Date(now.getTime() - 5 * 3600000 - 15 * 60000); // 5시간 15분 전
  const to = new Date(now.getTime() - 3 * 3600000 - 45 * 60000); // 3시간 45분 전 (2.5시간 구간)
  const r = range(from, to, true);
  assert.equal(r.to, toChDateTime(to)); // 정렬 없이 원본 to 그대로
});
