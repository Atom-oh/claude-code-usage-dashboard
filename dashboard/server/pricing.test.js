import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeModelId,
  priceFor,
  withComputedCost,
  tierCosts,
  tierCostsByGroup,
  buildPricing,
  pricingConfig,
  PRICING_PROMPT_TABLE,
} from "./pricing.js";

// 이 파일의 모듈 레벨 단언(withComputedCost/tierCosts/pricingConfig/PRICING_PROMPT_TABLE)은
// pricing.js가 import 시점에 읽은 env를 그대로 검증하므로, 셸에 PRICING_* 가 export되어 있으면
// 4개가 한꺼번에 깨진다. 원인 없는 4개 실패보다 이 한 줄이 낫다 — env를 바꿔서 검증하는 쪽은
// pricing.ttl5m.test.js(별도 프로세스)의 몫이다.
test("the ambient env does not preset PRICING_* (these tests assume the built-in defaults)", () => {
  assert.equal(process.env.PRICING_CACHE_WRITE_TTL, undefined, "셸에서 PRICING_CACHE_WRITE_TTL을 unset하고 다시 실행하세요");
  assert.equal(process.env.PRICING_JSON, undefined, "셸에서 PRICING_JSON을 unset하고 다시 실행하세요");
});

test("normalizeModelId strips bedrock/date/context-window variants", () => {
  assert.equal(normalizeModelId("us.anthropic.claude-sonnet-4-5-20250929-v1:0"), "claude-sonnet-4-5");
  assert.equal(normalizeModelId("global.anthropic.claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(normalizeModelId("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(normalizeModelId("claude-fable-5[1m]"), "claude-fable-5");
  assert.equal(normalizeModelId("anthropic.claude-haiku-4-5"), "claude-haiku-4-5");
  // 실측: bedrock 버전 접미사가 항상 -v1:0 형태인 건 아니다 — :0 없는 맨 -vN도 관측됨.
  // 4번째 단계가 -v\d+:\d+$만 벗기면 이 형태가 남아 단가표 매칭이 빗나간다(unpriced로 샘).
  assert.equal(normalizeModelId("global.anthropic.claude-opus-4-6-v1"), "claude-opus-4-6");
  assert.equal(normalizeModelId("claude-haiku-4-5-20251001-v2"), "claude-haiku-4-5");
});

test("priceFor returns null for unknown models", () => {
  assert.equal(priceFor("some-unknown-model"), null);
  assert.ok(priceFor("claude-sonnet-4-5"));
});

// opus-5 출시 직후 단가표에 없어서 unpriced로 새던 회귀 방지 — 실측 raw 문자열 두 형태
// (bare / [1m] 접미사)가 모두 단가에 매칭되어야 한다.
test("priceFor covers claude-opus-5 in both observed raw forms", () => {
  assert.ok(priceFor("claude-opus-5"));
  assert.ok(priceFor("claude-opus-5[1m]"));
  assert.equal(priceFor("claude-opus-5").input, 5);
  assert.equal(priceFor("claude-opus-5").output, 25);
});

// 맨 -v<n> bedrock 접미사(:0 없는 버전)가 unpriced로 새던 회귀 방지.
test("priceFor matches the bare -v<n> bedrock suffix form", () => {
  assert.ok(priceFor("global.anthropic.claude-opus-4-6-v1"));
});

// 기본 TTL이 1h로 바뀌면서 cache_write_tokens는 cacheWrite1h($6 = $3×2) 단가로 계산된다
// (기존 5m 단가 $3.75는 더 이상 기본값이 아님). host-computed 0.45423, 아래는 그 산출식:
//   input   35490 × 3    =  106470
//   output  17220 × 15   =  258300
//   cacheRd 54600 × 0.3  =   16380
//   cacheWr 12180 × 6.00 =   73080   (was 12180 × 3.75 = 45675, 1h 가정으로 전환)
//           sum          =  454230  / 1e6 = 0.45423   (기존 0.426825 → +0.027405)
test("withComputedCost multiplies token sums by per-type unit price", () => {
  const rows = [
    {
      model: "claude-sonnet-4-5-20250929",
      input_tokens: 35490,
      output_tokens: 17220,
      cache_read_tokens: 54600,
      cache_write_tokens: 12180,
    },
  ];
  const [row] = withComputedCost(rows);
  assert.equal(row.unpriced, false);
  assert.ok(Math.abs(row.cost - 0.45423) < 0.0005, `expected ~0.45423, got ${row.cost}`);
});

test("tierCosts sums $ per token tier across rows, skipping unpriced models", () => {
  const rows = [
    { model: "claude-sonnet-4-5", input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    { model: "claude-sonnet-4-5", input_tokens: 0, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 },
    { model: "claude-sonnet-4-5", input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000, cache_write_tokens: 0 },
    { model: "claude-sonnet-4-5", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 },
    { model: "some-unknown-model", input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
  ];
  const t = tierCosts(rows);
  assert.equal(t.uncachedInput, 3); // $3/M input
  assert.equal(t.output, 15); // $15/M output
  assert.equal(t.cacheRead, 0.3); // $0.3/M cacheRead
  assert.equal(t.cacheWrite, 6); // $6/M cacheWrite (1h 기본 TTL, $3×2)
});

test("tierCostsByGroup splits tierCosts by bedrock/enterprise group", () => {
  const rows = [
    { group: "bedrock", model: "claude-sonnet-4-5", input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    { group: "enterprise", model: "claude-sonnet-4-5", input_tokens: 0, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 },
  ];
  const t = tierCostsByGroup(rows);
  assert.equal(t.bedrock.uncachedInput, 3);
  assert.equal(t.bedrock.output, 0);
  assert.equal(t.enterprise.output, 15);
  assert.equal(t.enterprise.uncachedInput, 0);
});

test("withComputedCost flags unpriced models without dropping reported_cost", () => {
  const rows = [
    {
      model: "some-unknown-model",
      reported_cost: 1.23,
      input_tokens: 100,
      output_tokens: 100,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  ];
  const [row] = withComputedCost(rows);
  assert.equal(row.cost, null);
  assert.equal(row.unpriced, true);
  assert.equal(row.reported_cost, 1.23);
});

// 실측(Enterprise 청구서 대조): claude-sonnet-5는 $3/$15가 아니라 $2/$10 — 옛 단가는 계산
// 비용을 1.5배 과대계상했다. raw bedrock 문자열도 같은 행으로 정규화되어야 한다.
test("priceFor prices claude-sonnet-5 at the corrected rate", () => {
  const p = priceFor("claude-sonnet-5");
  assert.equal(p.input, 2);
  assert.equal(p.output, 10);
  assert.equal(p.cacheWrite, 2.5);
  assert.equal(p.cacheRead, 0.2);
  assert.equal(priceFor("us.anthropic.claude-sonnet-5-20260101-v1:0").input, 2);
});

test("cacheWrite1h is derived as input times 2 for every table entry", () => {
  const { table } = buildPricing({});
  const entries = Object.entries(table);
  assert.ok(entries.length > 0, "table must not be empty for this loop to mean anything");
  for (const [model, p] of entries) {
    assert.equal(p.cacheWrite1h, p.input * 2, `cacheWrite1h mismatch for ${model}`);
  }
});

test("default cache-write TTL is 1h", () => {
  assert.equal(buildPricing({}).cacheWriteTtl, "1h");
  assert.equal(buildPricing({ PRICING_CACHE_WRITE_TTL: "1h" }).cacheWriteTtl, "1h");
});

test("PRICING_CACHE_WRITE_TTL=5m switches cacheWriteTtl while both rate fields remain present", () => {
  const { table, cacheWriteTtl } = buildPricing({ PRICING_CACHE_WRITE_TTL: "5m" });
  assert.equal(cacheWriteTtl, "5m");
  assert.equal(table["claude-sonnet-4-5"].cacheWrite, 3.75);
  assert.equal(table["claude-sonnet-4-5"].cacheWrite1h, 6);
});

test("PRICING_JSON adds a new model with derived cache fields", () => {
  const { table, overriddenModels } = buildPricing({
    PRICING_JSON: JSON.stringify({ "claude-newmodel-9": { input: 7, output: 21 } }),
  });
  const p = table["claude-newmodel-9"];
  assert.ok(p);
  assert.equal(p.cacheWrite, 8.75); // 7 × 1.25
  // 7 × 0.1 === 0.7000000000000001 (IEEE 754) — 리터럴 0.7로 적으면 실패한다. 0.1이 이진수로
  // 정확히 표현되지 않아서인데, input이 2의 거듭제곱 배수일 때(8 × 0.1)는 지수 이동만 일어나
  // 우연히 정확해진다(아래 partial 케이스). 그래서 파생 규칙 자체를 단언한다.
  assert.equal(p.cacheRead, 7 * 0.1); // 7 × 0.1
  assert.equal(p.cacheWrite1h, 14); // 7 × 2
  assert.deepEqual(overriddenModels, ["claude-newmodel-9"]);
});

test("PRICING_JSON overrides an existing model wholesale, leaving other rows untouched", () => {
  const { table, overriddenModels } = buildPricing({
    PRICING_JSON: JSON.stringify({
      "claude-opus-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.4, cacheWrite1h: 8 },
    }),
  });
  const p = table["claude-opus-5"];
  assert.equal(p.input, 4);
  assert.equal(p.output, 20);
  assert.equal(p.cacheWrite, 5);
  assert.equal(p.cacheRead, 0.4);
  assert.equal(p.cacheWrite1h, 8);
  assert.ok(overriddenModels.includes("claude-opus-5"));
  assert.equal(table["claude-haiku-4-5"].input, 1); // 다른 행은 영향 없음
});

test("PRICING_JSON with only cacheWrite supplied still derives cacheRead and cacheWrite1h from input", () => {
  const { table } = buildPricing({
    PRICING_JSON: JSON.stringify({ "claude-partial-1": { input: 8, output: 40, cacheWrite: 9 } }),
  });
  const p = table["claude-partial-1"];
  assert.equal(p.cacheWrite, 9); // supplied 값 그대로
  assert.equal(p.cacheRead, 0.8); // 8 × 0.1, 유도
  assert.equal(p.cacheWrite1h, 16); // 8 × 2, 유도
});

// 파생 기본값 채우기가 ??가 아니라 ||면 명시적으로 설정한 0(무료/프로모션 티어)이 falsy라서
// 조용히 input 파생값으로 덮인다 — cacheWrite 0이 6.25로 바뀌는 식이라 무료 티어가 유료로
// 청구된다. 뮤테이션 검증: ?? → ||로 바꾸면 이 테스트만 깨진다(다른 75개는 통과).
test("an explicitly configured zero rate survives the derived-default fill", () => {
  const { table } = buildPricing({
    PRICING_JSON: JSON.stringify({ "claude-freewrite-1": { input: 5, output: 10, cacheWrite: 0 } }),
  });
  const p = table["claude-freewrite-1"];
  assert.equal(p.cacheWrite, 0); // ||였다면 5 × 1.25 = 6.25로 덮였다
  assert.equal(p.cacheRead, 0.5); // 미지정이므로 5 × 0.1 유도 — 대조군
  assert.equal(p.cacheWrite1h, 10); // 미지정이므로 5 × 2 유도 — 대조군

  // 세 캐시 필드를 각각 0으로 명시. input을 0이 아닌 5로 두는 게 핵심 — input이 0이면
  // ??든 ||든 파생값도 0이라 두 연산자를 구별할 수 없다(vacuous fixture).
  const zeros = buildPricing({
    PRICING_JSON: JSON.stringify({
      "claude-free-1": { input: 5, output: 10, cacheWrite: 0, cacheRead: 0, cacheWrite1h: 0 },
    }),
  }).table["claude-free-1"];
  assert.deepEqual(zeros, { input: 5, output: 10, cacheWrite: 0, cacheRead: 0, cacheWrite1h: 0 });
});

// buildPricing이 베이스 리터럴을 딥카피하지 않으면 첫 호출의 오버라이드가 이후 호출에 새어든다 —
// 두 번째 호출은 오버라이드 없는 env를 넘겼으므로 claude-opus-5는 원래 단가($5)를 유지해야 한다.
test("buildPricing does not mutate shared base-table state across calls", () => {
  buildPricing({ PRICING_JSON: JSON.stringify({ "claude-opus-5": { input: 4, output: 20 } }) });
  const second = buildPricing({});
  assert.equal(second.table["claude-opus-5"].input, 5);
});

test("invalid PRICING_JSON throws naming the env var", () => {
  assert.throws(() => buildPricing({ PRICING_JSON: "{not json" }), /PRICING_JSON/);
});

test("a non-object PRICING_JSON (array or primitive) throws naming the env var", () => {
  assert.throws(() => buildPricing({ PRICING_JSON: "[1,2]" }), /PRICING_JSON/);
  assert.throws(() => buildPricing({ PRICING_JSON: "42" }), /PRICING_JSON/);
});

test("a PRICING_JSON row missing numeric input throws, naming the offending key", () => {
  assert.throws(
    () => buildPricing({ PRICING_JSON: JSON.stringify({ "claude-bad-1": { output: 5 } }) }),
    (err) => /PRICING_JSON/.test(err.message) && /claude-bad-1/.test(err.message)
  );
});

test("a negative PRICING_JSON rate throws, naming the offending key", () => {
  assert.throws(
    () => buildPricing({ PRICING_JSON: JSON.stringify({ "claude-bad-2": { input: -1, output: 5 } }) }),
    (err) => /PRICING_JSON/.test(err.message) && /claude-bad-2/.test(err.message)
  );
});

// 정규화되지 않은 키를 조용히 정규화해 받아주면, priceFor의 PRICING[normalizeModelId(model)]
// 조회와 절대 맞지 않아 오버라이드가 조용히 무시된다 — R2가 금지하는 조용한 오가격과 동일한
// 실패 모드이므로 하드 에러로 막는다.
test("a non-normalized PRICING_JSON key throws, naming the normalized form", () => {
  assert.throws(
    () =>
      buildPricing({
        PRICING_JSON: JSON.stringify({
          "us.anthropic.claude-sonnet-5-20260101-v1:0": { input: 2, output: 10 },
        }),
      }),
    (err) => /PRICING_JSON/.test(err.message) && /claude-sonnet-5/.test(err.message)
  );
});

test("an invalid PRICING_CACHE_WRITE_TTL throws naming the env var and both accepted values", () => {
  assert.throws(
    () => buildPricing({ PRICING_CACHE_WRITE_TTL: "1hr" }),
    (err) => /PRICING_CACHE_WRITE_TTL/.test(err.message) && /1h/.test(err.message) && /5m/.test(err.message)
  );
  // 대소문자까지 정확히 일치해야 하는 계약 — 그럴듯해 보이는 "1H"도 거부되어야 한다.
  assert.throws(
    () => buildPricing({ PRICING_CACHE_WRITE_TTL: "1H" }),
    (err) => /PRICING_CACHE_WRITE_TTL/.test(err.message) && /1h/.test(err.message) && /5m/.test(err.message)
  );
});

// 이 환경엔 PRICING_JSON도 PRICING_CACHE_WRITE_TTL도 설정되어 있지 않음(host-verified) —
// pricingConfig는 단가 자체를 절대 노출하지 않는다는 R5 보장을 이 두 필드만으로 확인한다.
test("pricingConfig exposes only cacheWriteTtl and overriddenModels, no rates", () => {
  assert.deepEqual(pricingConfig, { cacheWriteTtl: "1h", overriddenModels: [] });
  assert.equal(Object.keys(pricingConfig).length, 2);
});

test("PRICING_PROMPT_TABLE renders the in-effect rate and the TTL assumption, without cacheCreation", () => {
  assert.match(PRICING_PROMPT_TABLE, /claude-sonnet-5: input \$2, output \$10/);
  assert.match(PRICING_PROMPT_TABLE, /cacheWrite \$4/); // sonnet-5 1h = 2 × 2
  assert.match(PRICING_PROMPT_TABLE, /PRICING_CACHE_WRITE_TTL/);
  assert.doesNotMatch(PRICING_PROMPT_TABLE, /cacheCreation/);
});
