import { test } from "node:test";
import assert from "node:assert/strict";

// freshness.js는 모듈 로드 시 process.env.DATA_STALE_MINUTES를 한 번 읽어 staleAfterMinutes를
// 고정한다 — 그래서 정적 import를 쓰면 env를 바꾸는 테스트가 성립하지 않는다(정적 import가
// env 조작 위로 hoist된다). 순수 함수 테스트는 인자로 임계를 받으므로 env와 무관하고,
// env 검증만 ?v= 쿼리스트링으로 새 모듈 인스턴스를 만들어서 한다.
const load = (v) => import(`./freshness.js?v=${v}`);

test("classifyFreshness returns ok inside the threshold", async () => {
  const { classifyFreshness } = await load("ok");
  const now = Date.UTC(2026, 8, 2, 12, 0, 0);
  const r = classifyFreshness({ latestMs: now - 30 * 60_000, nowMs: now, staleAfterMinutes: 360 });
  assert.equal(r.status, "ok");
  assert.equal(r.ageMinutes, 30);
  assert.equal(r.staleAfterMinutes, 360);
  assert.equal(r.latest, new Date(now - 30 * 60_000).toISOString());
});

test("classifyFreshness returns stale past the threshold", async () => {
  const { classifyFreshness } = await load("ok");
  const now = Date.UTC(2026, 8, 2, 12, 0, 0);
  const r = classifyFreshness({ latestMs: now - 7 * 3600_000, nowMs: now, staleAfterMinutes: 360 });
  assert.equal(r.status, "stale");
  assert.equal(r.ageMinutes, 420);
});

// 경계: 정확히 임계값은 ok, +1분이 stale(`>` 비교) — off-by-one이 여기서만 드러난다.
test("classifyFreshness treats exactly-threshold as ok and threshold+1 as stale", async () => {
  const { classifyFreshness } = await load("ok");
  const now = Date.UTC(2026, 8, 2, 12, 0, 0);
  assert.equal(classifyFreshness({ latestMs: now - 360 * 60_000, nowMs: now, staleAfterMinutes: 360 }).status, "ok");
  assert.equal(classifyFreshness({ latestMs: now - 361 * 60_000, nowMs: now, staleAfterMinutes: 360 }).status, "stale");
});

// 실측 2026-09-02: @clickhouse/client는 toUnixTimestamp64Milli(Int64)를 문자열로 준다
// ({"latest_ms":"1788356183000"}). Number() 변환이 없으면 나이 계산이 문자열 연산으로 새고,
// 아래 숫자 케이스들은 잘못된 구현도 그냥 통과시킨다 — 이 케이스가 유일한 감지 지점이다.
test("classifyFreshness accepts the numeric string the real client returns", async () => {
  const { classifyFreshness } = await load("ok");
  const now = 1788356183000 + 90 * 60_000;
  const r = classifyFreshness({ latestMs: "1788356183000", nowMs: now, staleAfterMinutes: 360 });
  assert.equal(r.status, "ok");
  assert.equal(r.ageMinutes, 90);
});

// 실측 2026-09-02: 창 안에 행이 없으면 max()가 epoch 0을 주고 클라이언트는 문자열 "0"으로
// 내려준다 — 1970년 데이터가 아니라 "모름"이다.
test("classifyFreshness maps 0 / null / NaN / non-finite to unknown", async () => {
  const { classifyFreshness } = await load("ok");
  const now = Date.UTC(2026, 8, 2, 12, 0, 0);
  for (const latestMs of ["0", 0, null, undefined, NaN, Infinity, "nope"]) {
    const r = classifyFreshness({ latestMs, nowMs: now, staleAfterMinutes: 360 });
    assert.equal(r.status, "unknown", `expected unknown for ${String(latestMs)}`);
    assert.equal(r.latest, null);
    assert.equal(r.ageMinutes, null);
    assert.equal(r.staleAfterMinutes, 360); // 임계는 unknown일 때도 응답에 남는다
  }
});

// 시계 스큐로 latest가 미래여도 stale이 아니다 — 나이를 0으로 클램프한다.
test("classifyFreshness clamps a negative age to 0 and reports ok", async () => {
  const { classifyFreshness } = await load("ok");
  const now = Date.UTC(2026, 8, 2, 12, 0, 0);
  const r = classifyFreshness({ latestMs: now + 5 * 60_000, nowMs: now, staleAfterMinutes: 360 });
  assert.equal(r.status, "ok");
  assert.equal(r.ageMinutes, 0);
});

test("staleAfterMinutes defaults to 360 when DATA_STALE_MINUTES is unset", async () => {
  delete process.env.DATA_STALE_MINUTES;
  const m = await load("default");
  assert.equal(m.staleAfterMinutes, 360);
});

test("DATA_STALE_MINUTES overrides the default", async () => {
  process.env.DATA_STALE_MINUTES = "15";
  const m = await load("override15");
  assert.equal(m.staleAfterMinutes, 15);
  delete process.env.DATA_STALE_MINUTES;
});

// 부팅 실패여야 하는 값들 — 조용히 360으로 접으면 운영자가 바꿨다고 믿는 임계가 안 돌아간다.
test("a non-positive or non-numeric DATA_STALE_MINUTES fails module load", async () => {
  for (const [i, bad] of ["0", "-5", "abc"].entries()) {
    process.env.DATA_STALE_MINUTES = bad;
    await assert.rejects(() => load(`bad${i}`), /DATA_STALE_MINUTES/, `expected load to reject for "${bad}"`);
  }
  delete process.env.DATA_STALE_MINUTES;
});

// probeLatestTelemetryMs는 ClickHouse에 실제로 접속하려 하므로 단위 테스트에서 호출하지 않는다
// (schema.js의 probeSegmentAwareSeriesKey도 같은 이유로 테스트가 없다) — 내보내지는지만 확인해
// index.js의 import가 깨지는 리팩터를 잡는다.
test("probeLatestTelemetryMs is exported as a function", async () => {
  const m = await load("shape");
  assert.equal(typeof m.probeLatestTelemetryMs, "function");
});
