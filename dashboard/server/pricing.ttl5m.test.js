// pricing.js는 모듈 로드 시 한 번 process.env를 읽어 PRICING/CACHE_WRITE_TTL을 고정하고,
// tierCosts/withComputedCost는 시그니처에 TTL 파라미터를 받지 않는다(pricing.js 헤더 주석 참조) — 그래서 5m
// 티어를 end-to-end로 검증하는 유일한 방법은 env를 바꾸고 "새" 모듈 인스턴스를 만드는 것뿐이다.
// 이 파일은 그 목적 하나로 존재한다: `?v=` 쿼리스트링으로 Node ESM 캐시를 무효화해 매번
// process.env를 다시 읽게 만든다. pricing.test.js에 합치면 정적 import가 먼저 평가되어
// env 조작보다 위로 hoist되므로 이 기법 자체가 성립하지 않는다 — 반드시 별도 파일이어야 한다.
import { test } from "node:test";
import assert from "node:assert/strict";

// 그룹별 env는 매 케이스 전에 지운다 — 셸에 남아 있으면 전역 env 케이스가 그룹 정책에 가려진다.
const clearGroupEnv = () => {
  delete process.env.PRICING_CACHE_WRITE_TTL_BEDROCK;
  delete process.env.PRICING_CACHE_WRITE_TTL_ENTERPRISE;
};

test("5m billing end to end: cache writes bill at the 5m rate, not 1h", async () => {
  process.env.PRICING_CACHE_WRITE_TTL = "5m";
  delete process.env.PRICING_JSON;
  clearGroupEnv();
  const m = await import("./pricing.js?ttl=5m");
  assert.equal(m.pricingConfig.cacheWriteTtl, "5m");
  // 전역을 명시하면 그룹 정책도 그 값으로 — enterprise의 내장 1h가 가려진다
  assert.equal(m.cacheWriteTtlFor("enterprise"), "5m");

  const rows = [
    { model: "claude-sonnet-4-5", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 },
  ];
  assert.equal(m.tierCosts(rows).cacheWrite, 3.75); // 5m 단가, 1h($6)가 아님

  const [row] = m.withComputedCost(rows);
  assert.equal(row.cost, 3.75);

  assert.match(m.PRICING_PROMPT_TABLE, /5m/);
});

// 컨트롤 케이스: 같은 픽스처를 1h로 로드했을 때 6이 나와야 5m 케이스가 실제로 env를
// 반영한 것임을 증명한다 — 이게 없으면 env를 무시하는 모듈도 5m 테스트를 통과시킬 수 있다.
test("1h billing end to end (control): same fixture bills at the 1h rate", async () => {
  process.env.PRICING_CACHE_WRITE_TTL = "1h";
  delete process.env.PRICING_JSON;
  clearGroupEnv();
  const m = await import("./pricing.js?ttl=1h");
  assert.equal(m.pricingConfig.cacheWriteTtl, "1h");

  const rows = [
    { model: "claude-sonnet-4-5", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 },
  ];
  assert.equal(m.tierCosts(rows).cacheWrite, 6); // 1h 단가

  const [row] = m.withComputedCost(rows);
  assert.equal(row.cost, 6);
});

test("an invalid PRICING_CACHE_WRITE_TTL fails module load at import time", async () => {
  process.env.PRICING_CACHE_WRITE_TTL = "10m";
  delete process.env.PRICING_JSON;
  clearGroupEnv();
  await assert.rejects(() => import("./pricing.js?ttl=bad"), /PRICING_CACHE_WRITE_TTL/);
});

// 워크샵 ccb의 실제 궤적: Bedrock 기본(5m)이었다가 CFN이 promptCacheTtl=1h를 고정하는 시각부터
// 1h. 같은 프로세스에서 시각만 바꿔 판정이 갈리는지, 전환 시각이 구간 분할 경계로 노출되는지,
// 행 단위 at 판정(스냅샷 구간 시작 / 버킷 시각)이 실제 단가 계산에 반영되는지를 end-to-end로 본다.
test("a bedrock schedule switches tiers at the instant and exposes it as a split boundary", async () => {
  delete process.env.PRICING_CACHE_WRITE_TTL;
  delete process.env.PRICING_JSON;
  clearGroupEnv();
  process.env.PRICING_CACHE_WRITE_TTL_BEDROCK = "5m,2026-09-09T00:00:00Z=1h";
  const m = await import("./pricing.js?ttl=schedule");
  assert.deepEqual(m.pricingConfig.cacheWriteTtlByGroup.bedrock, [
    { since: null, ttl: "5m" },
    { since: "2026-09-09T00:00:00.000Z", ttl: "1h" },
  ]);
  assert.deepEqual(m.pricingConfig.cacheWriteTtlByGroup.enterprise, [{ since: null, ttl: "1h" }]); // 내장 기본 유지
  assert.equal(m.cacheWriteTtlFor("bedrock", new Date("2026-09-08T23:00:00Z")), "5m");
  assert.equal(m.cacheWriteTtlFor("bedrock", new Date("2026-09-09T00:00:00Z")), "1h"); // 경계 포함
  assert.equal(m.cacheWriteTtlFor("bedrock", "2026-09-10 12:00:00"), "1h"); // ClickHouse 문자열도 UTC로
  assert.equal(m.cacheWriteTtlFor("enterprise", new Date("2026-09-01T00:00:00Z")), "1h");
  assert.deepEqual(m.cacheWriteTtlBoundaries().map((d) => d.toISOString()), ["2026-09-09T00:00:00.000Z"]);

  const row = { group: "bedrock", model: "claude-opus-5", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 };
  assert.equal(m.withComputedCost([row], { at: new Date("2026-09-05T00:00:00Z") })[0].cost, 6.25);
  assert.equal(m.withComputedCost([row], { at: new Date("2026-09-12T00:00:00Z") })[0].cost, 10);
  // 행마다 다른 시각(costByModelDaily의 day 버킷) — 함수형 at
  const daily = m.withComputedCost(
    [
      { ...row, day: "2026-09-08 00:00:00" },
      { ...row, day: "2026-09-09 00:00:00" },
    ],
    { at: (r) => m.toInstant(r.day) }
  );
  assert.deepEqual(daily.map((r) => [r.cache_write_ttl, r.cost]), [["5m", 6.25], ["1h", 10]]);
  assert.match(m.PRICING_PROMPT_TABLE, /bedrock → 5m, 2026-09-09T00:00:00\.000Z부터 1h/);
});

test("an invalid per-group schedule fails module load at import time", async () => {
  delete process.env.PRICING_CACHE_WRITE_TTL;
  delete process.env.PRICING_JSON;
  clearGroupEnv();
  process.env.PRICING_CACHE_WRITE_TTL_ENTERPRISE = "1h,2026-09-09T00:30:00Z=5m";
  await assert.rejects(() => import("./pricing.js?ttl=badsched"), /PRICING_CACHE_WRITE_TTL_ENTERPRISE.*hour boundary/);
  clearGroupEnv();
});

test("an invalid PRICING_JSON fails module load at import time", async () => {
  delete process.env.PRICING_CACHE_WRITE_TTL;
  clearGroupEnv();
  process.env.PRICING_JSON = "{nope";
  await assert.rejects(() => import("./pricing.js?json=bad"), /PRICING_JSON/);
});
