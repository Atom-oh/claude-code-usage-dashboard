// pricing.js는 모듈 로드 시 한 번 process.env를 읽어 PRICING/CACHE_WRITE_TTL을 고정하고,
// tierCosts/withComputedCost는 시그니처에 TTL 파라미터를 받지 않는다(pricing.js 헤더 주석 참조) — 그래서 5m
// 티어를 end-to-end로 검증하는 유일한 방법은 env를 바꾸고 "새" 모듈 인스턴스를 만드는 것뿐이다.
// 이 파일은 그 목적 하나로 존재한다: `?v=` 쿼리스트링으로 Node ESM 캐시를 무효화해 매번
// process.env를 다시 읽게 만든다. pricing.test.js에 합치면 정적 import가 먼저 평가되어
// env 조작보다 위로 hoist되므로 이 기법 자체가 성립하지 않는다 — 반드시 별도 파일이어야 한다.
import { test } from "node:test";
import assert from "node:assert/strict";

test("5m billing end to end: cache writes bill at the 5m rate, not 1h", async () => {
  process.env.PRICING_CACHE_WRITE_TTL = "5m";
  delete process.env.PRICING_JSON;
  const m = await import("./pricing.js?ttl=5m");
  assert.equal(m.pricingConfig.cacheWriteTtl, "5m");

  const rows = [
    { model: "claude-sonnet-4-5", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000, reported_cost: "3.5" },
  ];
  assert.equal(m.tierCosts(rows).cacheWrite, 3.75); // 5m 단가, 1h($6)가 아님

  const [row] = m.withComputedCost(rows);
  assert.equal(row.cost, 3.75);
  assert.equal(row.display_cost, 3.5);
  assert.equal(row.reported_cost_status, "reported");

  assert.match(m.PRICING_PROMPT_TABLE, /5m/);
});

// 컨트롤 케이스: 같은 픽스처를 1h로 로드했을 때 6이 나와야 5m 케이스가 실제로 env를
// 반영한 것임을 증명한다 — 이게 없으면 env를 무시하는 모듈도 5m 테스트를 통과시킬 수 있다.
test("1h billing end to end (control): same fixture bills at the 1h rate", async () => {
  process.env.PRICING_CACHE_WRITE_TTL = "1h";
  delete process.env.PRICING_JSON;
  const m = await import("./pricing.js?ttl=1h");
  assert.equal(m.pricingConfig.cacheWriteTtl, "1h");

  const rows = [
    { model: "claude-sonnet-4-5", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000, reported_cost: "3.5" },
  ];
  assert.equal(m.tierCosts(rows).cacheWrite, 6); // 1h 단가

  const [row] = m.withComputedCost(rows);
  assert.equal(row.cost, 6);
  assert.equal(row.display_cost, 3.5);
  assert.equal(row.reported_cost_status, "reported");
});

test("an invalid PRICING_CACHE_WRITE_TTL fails module load at import time", async () => {
  process.env.PRICING_CACHE_WRITE_TTL = "10m";
  delete process.env.PRICING_JSON;
  await assert.rejects(() => import("./pricing.js?ttl=bad"), /PRICING_CACHE_WRITE_TTL/);
});

test("an invalid PRICING_JSON fails module load at import time", async () => {
  delete process.env.PRICING_CACHE_WRITE_TTL;
  process.env.PRICING_JSON = "{nope";
  await assert.rejects(() => import("./pricing.js?json=bad"), /PRICING_JSON/);
});
