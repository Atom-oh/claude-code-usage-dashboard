import { test } from "node:test";
import assert from "node:assert/strict";
import { bucket, filterCond, alignHistoricalTo } from "./queries.js";

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
