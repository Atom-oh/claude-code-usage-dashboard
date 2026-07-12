import { test } from "node:test";
import assert from "node:assert/strict";
import { bucket, filterCond, alignHistoricalTo, range, incFlat, incFlatRaw } from "./queries.js";
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

// incFlat(KPI 스냅샷)이 span<4h(index.js MAX_MINUTE_BUCKET_RANGE_MS와 동일 임계 — 프론트
// resolutionForSpan이 분 버킷을 고르는 구간)일 때 rollup(hour 그레인) 대신 원본
// otel_metrics_sum으로 폴백해야 한다 — 안 그러면 toStartOfHour(from)이 왼쪽 경계를 최대
// 59분 넓혀, 같은 화면의 시계열(이 구간에서 incBucketedRaw를 타 from을 그대로 씀)보다
// KPI 카드 합계가 커지는 불일치가 생긴다(리뷰에서 MAJOR로 확인 — 처음엔 1h를 임계로 썼는데
// 1h~4h 밴드에서 여전히 어긋나 4h로 재조정).
test("incFlat falls back to the raw table for spans under the 4h minute-bucket threshold", () => {
  const sub = incFlat("", 30 * 60000); // 30분 span
  assert.match(sub, /FROM claude_code\.otel_metrics_sum\b/);
  assert.doesNotMatch(sub, /otel_metrics_sum_hourly/);
  const midBand = incFlat("", 3 * 3600000); // 3시간 span(1h~4h 밴드, 리뷰가 처음 잡아낸 회귀)
  assert.match(midBand, /FROM claude_code\.otel_metrics_sum\b/);
  const normal = incFlat("", 6 * 3600000); // 6시간 span → 4시간 초과, rollup
  assert.match(normal, /FROM claude_code\.otel_metrics_sum_hourly/);
  const defaultSpan = incFlat(); // spanMs 생략 → Infinity → 항상 rollup(기본 뷰 전제)
  assert.match(defaultSpan, /FROM claude_code\.otel_metrics_sum_hourly/);
});

// rollup 분기(span≥4h, 기본 2일 뷰 포함)의 cumulative baseline은 from이 속한 hour 버킷을
// 원본 테이블로 stitch해야 한다 — hour는 "그 버킷 종료 시점" 값이라 어느 쪽 근사(toStartOfHour
// 내림 또는 hour<from 그대로)도 단독으로는 부정확하다:
//   - hour < toStartOfHour(from): baseline이 너무 작아짐 → diff 과대집계(라이브 실측: 한
//     세션에서 504만 토큰 차이).
//   - hour < from (라운드 9 시도): from이 속한 hour 버킷의 "종료 시점"(최대 59분 미래) 값을
//     baseline으로 씀 → diff 과소집계(라이브 실측: 같은 종류 세션에서 27,066 차이 재현,
//     리뷰에서 재확인 — 방향이 반대인 별개의 오차였다).
// UNION ALL로 from이 속한 hour만 원본 stitch 서브쿼리로 대체하는 게 유일한 정확한 해법 —
// 라이브 클러스터에서 전체 SQL을 실행해 정확한 diff(27,066)가 나옴을 확인했다.
test("incFlat's rollup branch stitches the from-hour bucket from the raw table for exact baseline", () => {
  const rollup = incFlat("", 6 * 3600000); // 4h 초과 → rollup 분기
  assert.match(rollup, /UNION ALL/);
  assert.match(rollup, /maxIf\(Value, TimeUnix < \{from:DateTime\}\) AS mv/);
  assert.match(rollup, /hour != toStartOfHour\(\{from:DateTime\}\)/);
});

// incFlatRaw()의 임계값이 index.js의 clampIntervalHours(`to-from > 4h`일 때만 클램프 — 정확히
// 4h는 raw 허용)와 정확히 같은 경계에서 갈려야 한다. `<`를 쓰면 정확히 4h(1시간 버킷 4개짜리
// 드래그 등으로 실제 생성 가능)에서 시계열은 raw인데 스냅샷은 rollup을 보는 off-by-one이
// 재발한다(리뷰에서 확인) — `<=`라 정확히 4h도 raw여야 한다.
test("incFlatRaw threshold matches clampIntervalHours' >4h boundary (inclusive at exactly 4h)", () => {
  assert.equal(incFlatRaw(4 * 3600000 - 1), true);
  assert.equal(incFlatRaw(4 * 3600000), true); // 정확히 4h: clampIntervalHours도 raw 허용 -> 일치해야 함
  assert.equal(incFlatRaw(4 * 3600000 + 1), false);
});
