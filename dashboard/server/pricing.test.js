import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeModelId,
  priceFor,
  withComputedCost,
  rollupComputedCost,
  tierCosts,
  tierCostsByGroup,
  buildPricing,
  pricingConfig,
  PRICING_PROMPT_TABLE,
  parseCacheWriteTtlSchedule,
  cacheWriteTtlFor,
  cacheWriteTtlBoundaries,
  ttlSegments,
  mergeSegments,
  toInstant,
} from "./pricing.js";

// 이 파일의 모듈 레벨 단언(withComputedCost/tierCosts/pricingConfig/PRICING_PROMPT_TABLE)은
// pricing.js가 import 시점에 읽은 env를 그대로 검증하므로, 셸에 PRICING_* 가 export되어 있으면
// 4개가 한꺼번에 깨진다. 원인 없는 4개 실패보다 이 한 줄이 낫다 — env를 바꿔서 검증하는 쪽은
// pricing.ttl5m.test.js(별도 프로세스)의 몫이다.
test("the ambient env does not preset PRICING_* (these tests assume the built-in defaults)", () => {
  assert.equal(process.env.PRICING_CACHE_WRITE_TTL, undefined, "셸에서 PRICING_CACHE_WRITE_TTL을 unset하고 다시 실행하세요");
  assert.equal(process.env.PRICING_CACHE_WRITE_TTL_BEDROCK, undefined, "셸에서 PRICING_CACHE_WRITE_TTL_BEDROCK을 unset하고 다시 실행하세요");
  assert.equal(process.env.PRICING_CACHE_WRITE_TTL_ENTERPRISE, undefined, "셸에서 PRICING_CACHE_WRITE_TTL_ENTERPRISE를 unset하고 다시 실행하세요");
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

// 이 환경엔 PRICING_JSON도 PRICING_CACHE_WRITE_TTL*도 설정되어 있지 않음(host-verified) —
// pricingConfig는 단가 자체를 절대 노출하지 않는다는 R5 보장을 이 세 필드만으로 확인한다.
// cacheWriteTtlByGroup의 내장 기본값(bedrock 5m / enterprise 1h)이 곧 ADR-008의 정책이다.
test("pricingConfig exposes the TTL policy and overriddenModels, no rates", () => {
  assert.deepEqual(pricingConfig, {
    cacheWriteTtl: "1h",
    cacheWriteTtlByGroup: { bedrock: [{ since: null, ttl: "5m" }], enterprise: [{ since: null, ttl: "1h" }] },
    overriddenModels: [],
  });
  assert.equal(Object.keys(pricingConfig).length, 3);
});

test("PRICING_PROMPT_TABLE renders both cache-write tiers and the per-group policy, without cacheCreation", () => {
  assert.match(PRICING_PROMPT_TABLE, /claude-sonnet-5: input \$2, output \$10, cacheWrite5m \$2\.5, cacheWrite1h \$4/);
  assert.match(PRICING_PROMPT_TABLE, /bedrock → 5m/);
  assert.match(PRICING_PROMPT_TABLE, /enterprise → 1h/);
  assert.match(PRICING_PROMPT_TABLE, /PRICING_CACHE_WRITE_TTL_BEDROCK/);
  assert.doesNotMatch(PRICING_PROMPT_TABLE, /cacheCreation/);
});

// ---------------------------------------------------------------------------------------------
// 그룹별 캐시 쓰기 TTL 정책(ADR-008). 2026-09-07 한화 이벤트 실측: Bedrock 세션의 캐시 쓰기는
// 전량 5m 티어였는데 대시보드는 1h(×2.0)로 계산해 +17.72% 과대계상 — 그룹을 무시한 전역 TTL이
// 원인이었다. 아래 테스트는 (1) 그룹별 기본값, (2) env 우선순위, (3) 전환 시각 스케줄,
// (4) 행 단위 판정, (5) 구간 분할/합치기를 고정한다.
// ---------------------------------------------------------------------------------------------

test("buildPricing defaults bedrock to 5m and enterprise to 1h when no TTL env is set", () => {
  const { cacheWriteTtlByGroup } = buildPricing({});
  assert.deepEqual(cacheWriteTtlByGroup, { bedrock: [{ since: null, ttl: "5m" }], enterprise: [{ since: null, ttl: "1h" }] });
});

// 전역 env를 명시하면 "전부 한 티어"라는 예전 의미를 보존한다 — 내장 그룹 기본값보다 우선.
test("an explicit global PRICING_CACHE_WRITE_TTL overrides the built-in per-group defaults", () => {
  const { cacheWriteTtlByGroup } = buildPricing({ PRICING_CACHE_WRITE_TTL: "1h" });
  assert.equal(cacheWriteTtlByGroup.bedrock[0].ttl, "1h");
  assert.equal(cacheWriteTtlByGroup.enterprise[0].ttl, "1h");
  const five = buildPricing({ PRICING_CACHE_WRITE_TTL: "5m" });
  assert.equal(five.cacheWriteTtlByGroup.enterprise[0].ttl, "5m");
});

test("a per-group env beats the global env for that group only", () => {
  const { cacheWriteTtlByGroup } = buildPricing({ PRICING_CACHE_WRITE_TTL: "5m", PRICING_CACHE_WRITE_TTL_ENTERPRISE: "1h" });
  assert.equal(cacheWriteTtlByGroup.bedrock[0].ttl, "5m");
  assert.equal(cacheWriteTtlByGroup.enterprise[0].ttl, "1h");
});

test("parseCacheWriteTtlSchedule accepts a bare tier and an ascending instant schedule", () => {
  assert.deepEqual(parseCacheWriteTtlSchedule("1h", "X"), [{ since: null, ttl: "1h" }]);
  const sched = parseCacheWriteTtlSchedule(" 5m , 2026-09-09T00:00:00Z=1h ,2026-10-01T00:00:00+00:00=5m", "X");
  assert.equal(sched.length, 3);
  assert.equal(sched[0].ttl, "5m");
  assert.equal(sched[1].since.toISOString(), "2026-09-09T00:00:00.000Z");
  assert.equal(sched[1].ttl, "1h");
  assert.equal(sched[2].since.toISOString(), "2026-10-01T00:00:00.000Z");
});

test("parseCacheWriteTtlSchedule rejects malformed schedules, naming the env var", () => {
  const rejects = (raw, re) => assert.throws(() => parseCacheWriteTtlSchedule(raw, "PRICING_CACHE_WRITE_TTL_BEDROCK"), (e) => /PRICING_CACHE_WRITE_TTL_BEDROCK/.test(e.message) && re.test(e.message));
  rejects("10m", /1h.*5m|5m.*1h/);
  rejects("", /schedule/);
  rejects("5m,1h", /omit/); // 두 번째 항목에 시각이 없다
  rejects("2026-09-09T00:00:00Z=1h", /first schedule entry/); // 초기 티어가 없다
  rejects("5m,2026-09-09T00:00:00=1h", /timezone/); // 로컬 시간 해석 금지
  rejects("5m,2026-09-09T00:30:00Z=1h", /hour boundary/); // 롤업 hour 경계
  rejects("5m,2026-09-09T00:00:00Z=1h,2026-09-09T00:00:00Z=5m", /strictly increasing/);
  rejects("5m,not-a-date=1h", /timezone|ISO-8601/);
});

// cacheWriteTtlFor는 모듈 로드 시 읽은 정책(이 환경: 내장 기본값)으로 판정한다 — 스케줄 판정은
// buildPricing 결과를 직접 검사하는 위 테스트와, 새 모듈 인스턴스로 env를 바꿔 로드하는
// pricing.ttl5m.test.js가 나눠 맡는다.
test("cacheWriteTtlFor resolves by group and falls back to the global tier for unknown/missing groups", () => {
  assert.equal(cacheWriteTtlFor("bedrock"), "5m");
  assert.equal(cacheWriteTtlFor("enterprise"), "1h");
  assert.equal(cacheWriteTtlFor("unknown"), "1h");
  assert.equal(cacheWriteTtlFor(undefined), "1h");
  assert.deepEqual(cacheWriteTtlBoundaries(), []); // 기본 정책엔 전환 시각이 없다
});

// 같은 토큰, 다른 그룹 → 캐시 쓰기 항만 다르다(opus-5 1M: 5m $6.25 vs 1h $10). 이 차이가 곧
// 2026-09-07 이벤트의 +17.72%였다. 적용한 티어와 그 항의 금액이 응답에 드러나야 한다.
test("withComputedCost prices cache writes by the row's group and exposes the tier it used", () => {
  const tokens = { model: "claude-opus-5", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 };
  const [b, e, u, none] = withComputedCost([
    { ...tokens, group: "bedrock" },
    { ...tokens, group: "enterprise" },
    { ...tokens, group: "unknown" },
    { ...tokens },
  ]);
  assert.deepEqual([b.cost, b.cache_write_ttl, b.cache_write_cost], [6.25, "5m", 6.25]);
  assert.deepEqual([e.cost, e.cache_write_ttl, e.cache_write_cost], [10, "1h", 10]);
  assert.equal(u.cost, 10); // 정책 없는 그룹은 전역(1h)
  assert.equal(none.cost, 10); // group 컬럼이 없는 행도 전역
  const [unpriced] = withComputedCost([{ ...tokens, model: "titan-text-lite", group: "bedrock" }]);
  assert.deepEqual([unpriced.cost, unpriced.unpriced, unpriced.cache_write_ttl, unpriced.cache_write_cost], [null, true, null, null]);
});

// tierCosts는 이미 단가가 매겨진 행의 cache_write_cost를 그대로 쓴다 — 전환 시각을 걸쳐 합쳐진
// 행은 토큰 합계 × 단가 하나로 복원할 수 없기 때문. 값이 없는 원시 행은 그룹 정책으로 계산한다.
test("tierCosts takes cache_write_cost from priced rows and prices raw rows by group", () => {
  const raw = { model: "claude-opus-5", group: "bedrock", input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 };
  assert.deepEqual(tierCosts([raw]), { uncachedInput: 5, cacheRead: 0, cacheWrite: 6.25, output: 0 });
  // 합쳐진 행: 5m 구간 1M($6.25) + 1h 구간 1M($10) = $16.25, 토큰은 2M
  const merged = { ...raw, cache_write_tokens: 2_000_000, cache_write_cost: 16.25, cache_write_ttl: "mixed" };
  assert.equal(tierCosts([merged]).cacheWrite, 16.25);
  assert.equal(tierCostsByGroup([raw, { ...raw, group: "enterprise" }]).enterprise.cacheWrite, 10);
});

test("ttlSegments splits [from, to) only at boundaries strictly inside it", () => {
  const from = new Date("2026-09-04T00:00:00Z");
  const to = new Date("2026-09-10T00:00:00Z");
  const cut = new Date("2026-09-09T00:00:00Z");
  assert.deepEqual(ttlSegments(from, to, []), [{ from, to }]);
  assert.deepEqual(ttlSegments(from, to, [cut]), [{ from, to: cut }, { from: cut, to }]);
  // 경계와 같은 시각, 구간 밖 시각은 쪼개지 않는다
  assert.deepEqual(ttlSegments(from, to, [from, to, new Date("2026-08-01T00:00:00Z")]), [{ from, to }]);
});

test("mergeSegments adds numeric fields per key, keeps null cost, ORs unpriced and marks mixed tiers", () => {
  const rows = mergeSegments(
    [
      [
        { group: "bedrock", model: "claude-opus-5", cost: 6.25, cache_write_tokens: "1000000", cache_write_ttl: "5m", cache_write_cost: 6.25, unpriced: false, sessions: 2 },
        { group: "bedrock", model: "titan-text-lite", cost: null, cache_write_tokens: 5, cache_write_ttl: null, cache_write_cost: null, unpriced: true, sessions: 1 },
      ],
      [
        { group: "bedrock", model: "claude-opus-5", cost: 10, cache_write_tokens: "1000000", cache_write_ttl: "1h", cache_write_cost: 10, unpriced: false, sessions: 3 },
        { group: "enterprise", model: "claude-opus-5", cost: 10, cache_write_tokens: 1_000_000, cache_write_ttl: "1h", cache_write_cost: 10, unpriced: false, sessions: 1 },
      ],
    ],
    ["group", "model"]
  );
  assert.equal(rows.length, 3);
  const [opusB, titan, opusE] = rows;
  // 드라이버가 준 숫자형 문자열도 더해져 숫자가 된다
  assert.deepEqual([opusB.cost, opusB.cache_write_tokens, opusB.cache_write_ttl, opusB.cache_write_cost, opusB.sessions], [16.25, 2_000_000, "mixed", 16.25, 5]);
  assert.deepEqual([titan.cost, titan.unpriced], [null, true]);
  assert.deepEqual([opusE.cost, opusE.cache_write_ttl], [10, "1h"]); // 한 조각만 있는 키는 그대로
});

test("toInstant reads ClickHouse's timezone-less DateTime string as UTC", () => {
  assert.equal(toInstant("2026-09-09 00:00:00").toISOString(), "2026-09-09T00:00:00.000Z");
  assert.equal(toInstant("2026-09-09T03:00:00Z").toISOString(), "2026-09-09T03:00:00.000Z");
  assert.equal(toInstant(new Date(0)).getTime(), 0);
});

// 2026-09-02 단가표 보강: 이 6개 계열이 표에 없어 토큰이 unpriced로 새고 있었다(계산 비용에서
// 통째로 제외 — 대시보드 비용이 하한선이 되는 원인 중 하나). cacheWrite1h는 표에 안 적고
// buildPricing이 입력×2로 파생한다.
test("priceFor covers the 2026-09-02 additions with the derived 1h cache-write rate", () => {
  assert.equal(priceFor("claude-mythos-5").input, 10);
  assert.equal(priceFor("claude-mythos-5").cacheRead, 1);
  assert.equal(priceFor("claude-fable-5-1").cacheWrite1h, 20); // 10 × 2
  assert.equal(priceFor("claude-opus-4-1").cacheWrite1h, 30); // 15 × 2
  assert.equal(priceFor("claude-opus-4").output, 75);
  assert.equal(priceFor("claude-sonnet-4").cacheWrite, 3.75);
});

// fable-5-1/mythos-5-1의 cacheRead는 입력×0.1(=1.0)이 아니라 0.25다 — 모듈의 파생 규칙을
// 그대로 믿으면 4배 과대계상된다. 표에 명시된 값이 살아있는지 고정한다.
test("the -5-1 models keep their explicit 0.025x cacheRead instead of the derived 0.1x", () => {
  assert.equal(priceFor("claude-fable-5-1").cacheRead, 0.25);
  assert.equal(priceFor("claude-mythos-5-1").cacheRead, 0.25);
  // 대조군: 같은 입력 단가($10)의 fable-5/mythos-5는 파생 규칙대로 1.0이다 — 이게 없으면
  // 위 두 단정문이 "모든 $10 모델이 0.25"인 잘못된 구현도 통과시킨다.
  assert.equal(priceFor("claude-fable-5").cacheRead, 1);
  assert.equal(priceFor("claude-mythos-5").cacheRead, 1);
});

// -\d{8}$(날짜 스냅샷) 단계가 -4 / -1 같은 마이너 버전까지 먹으면 다른 모델 행으로 매칭돼
// 조용한 오가격이 된다. 두 방향 모두 고정한다.
test("normalizeModelId strips the date snapshot without eating a minor version", () => {
  assert.equal(normalizeModelId("us.anthropic.claude-opus-4-1-20250805-v1:0"), "claude-opus-4-1");
  assert.equal(normalizeModelId("claude-opus-4-20250514"), "claude-opus-4");
  assert.equal(normalizeModelId("claude-sonnet-4-20250514"), "claude-sonnet-4");
  // fable-5-1이 fable-5로 접히면 cacheRead가 0.25가 아니라 1.0으로 잡힌다(4배).
  assert.equal(normalizeModelId("claude-fable-5-1"), "claude-fable-5-1");
  assert.equal(normalizeModelId("claude-fable-5-1[1m]"), "claude-fable-5-1");
  assert.equal(priceFor("claude-fable-5-1").cacheRead, 0.25);
});

// 실측: Bedrock cross-region 추론 프로파일 접두사는 us./global./eu./apac. 외에
// us-gov./jp./au.도 있다. 안 벗기면 모델 분포가 리전별로 쪼개지고 단가표에도 안 맞는다.
test("normalizeModelId strips the us-gov/jp/au cross-region profile prefixes", () => {
  assert.equal(normalizeModelId("jp.anthropic.claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(normalizeModelId("us-gov.anthropic.claude-haiku-4-5-20251001-v1:0"), "claude-haiku-4-5");
  assert.equal(normalizeModelId("au.anthropic.claude-opus-5"), "claude-opus-5");
  // us-gov는 us보다 뒤에 오는 대안이라(정규식 순서) us가 먼저 매칭됐다가 백트래킹으로
  // us-gov를 잡는다 — 위 두 번째 단정문이 그 백트래킹을 고정한다.
  assert.equal(priceFor("us-gov.anthropic.claude-haiku-4-5-20251001-v1:0").input, 1);
  // 대조군: 접두사처럼 보이지만 목록에 없는 값은 그대로 남아야 한다(과잉 매칭 방지).
  assert.equal(normalizeModelId("us-gov-west.anthropic.claude-opus-5"), "us-gov-west.anthropic.claude-opus-5");
});

// rollupComputedCost: 그룹 컬럼 × model 그레인의 쿼리 결과를 그룹 컬럼 단위로 접는다. 이 헬퍼가
// 없으면 effortMix/agentCost가 SQL에서 바로 합계를 내야 하는데, 그러면 model이 사라져 단가를
// 고를 수 없다(그래서 두 패널이 계산 비용이 아니라 보고 비용을 쓰고 있었다).
const rollupRow = (o) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reported_cost: 0,
  ...o,
});
const M = 1000000;

test("rollupComputedCost folds two models under one key into one computed-cost row", () => {
  const [row, ...rest] = rollupComputedCost(
    [
      rollupRow({ group: "bedrock", effort: "high", model: "claude-opus-5", input_tokens: M, output_tokens: M, cache_read_tokens: M, cache_write_tokens: M, reported_cost: 30 }),
      rollupRow({ group: "bedrock", effort: "high", model: "claude-fable-5", input_tokens: 2 * M, reported_cost: 12 }),
    ],
    ["group", "effort"]
  );
  assert.equal(rest.length, 0);
  // opus-5: 5 + 25 + 0.5 + 6.25(bedrock은 5m 티어) = 36.75 (1M씩) · fable-5: 2M × $10/M = 20
  // → 56.75. 두 모델을 접기 전에 각자 단가로 계산해야만 나오는 값이다 — 접은 뒤에 아무 단가나
  // 곱하면 6M 토큰 × 어떤 단가로도 56.75가 되지 않는다.
  assert.deepEqual(row, {
    group: "bedrock",
    effort: "high",
    cost: 56.75,
    reported_cost: 42,
    tokens: 6 * M,
    unpriced_tokens: 0,
  });
  // 대조군: 같은 픽스처가 enterprise면 캐시 쓰기가 1h($10)라 60.5 — 접기 경로가 그룹 정책을
  // 통과시키는지 확인한다(이게 없으면 그룹을 무시하는 구현도 위 단정문 하나는 통과할 수 있다).
  const [ent] = rollupComputedCost(
    [rollupRow({ group: "enterprise", effort: "high", model: "claude-opus-5", input_tokens: M, output_tokens: M, cache_read_tokens: M, cache_write_tokens: M }), rollupRow({ group: "enterprise", effort: "high", model: "claude-fable-5", input_tokens: 2 * M })],
    ["group", "effort"]
  );
  assert.equal(ent.cost, 60.5);
});

test("rollupComputedCost keeps unpriced-model tokens out of cost but inside tokens", () => {
  const [row] = rollupComputedCost(
    [
      rollupRow({ group: "bedrock", effort: "high", model: "claude-opus-5", input_tokens: M, reported_cost: 3 }),
      // 단가표에 없는 모델(withComputedCost가 unpriced: true, cost: null로 표시).
      // reported_cost는 일부러 문자열 — 드라이버가 집계값을 문자열로 주는 경우를 고정한다.
      // Number() 강제가 빠지면 += 가 문자열 연결이 되어 이 단정문이 "37"로 깨진다.
      rollupRow({ group: "bedrock", effort: "high", model: "openai.gpt-5.6-sol", input_tokens: M, output_tokens: 500000, reported_cost: "7" }),
    ],
    ["group", "effort"]
  );
  assert.equal(row.cost, 5); // opus-5 1M 입력만 — 미산정 모델은 0을 더한다(null이 아니다)
  assert.equal(typeof row.cost, "number");
  assert.equal(row.reported_cost, 10);
  assert.equal(row.tokens, 2.5 * M);
  assert.equal(row.unpriced_tokens, 1.5 * M);
});

test("rollupComputedCost splits on every key column and preserves first-seen order", () => {
  const rows = rollupComputedCost(
    [
      rollupRow({ group: "bedrock", agent: "main", model: "claude-opus-5", input_tokens: M, reported_cost: 4 }),
      rollupRow({ group: "bedrock", agent: "code-reviewer", model: "claude-opus-5", input_tokens: 2 * M, reported_cost: 9 }),
      rollupRow({ group: "enterprise", agent: "main", model: "claude-opus-5", input_tokens: 3 * M, reported_cost: 1 }),
      rollupRow({ group: "enterprise", agent: "main", model: "claude-fable-5", input_tokens: M, reported_cost: 2 }),
    ],
    ["group", "agent"]
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => `${r.group}/${r.agent}`),
    ["bedrock/main", "bedrock/code-reviewer", "enterprise/main"]
  );
  // 같은 agent 이름이 그룹으로 갈라지는지 — 4행 중 마지막 두 행만 한 행으로 접힌다.
  assert.equal(rows[2].cost, 25); // 3M × $5/M + 1M × $10/M
  assert.equal(rows[2].reported_cost, 3);
  assert.equal(rows[2].tokens, 4 * M);
  assert.equal(rows[0].cost, 5);
});

test("rollupComputedCost returns an empty array for empty input", () => {
  assert.deepEqual(rollupComputedCost([], ["group", "effort"]), []);
});

// fable-5-1의 cacheRead는 파생 규칙(입력×0.1 = 1.0)이 아니라 명시값 0.25다. priceFor 단위로는
// 이미 고정되어 있지만(위쪽 테스트), 접기 경로에서도 살아있는지 따로 고정한다 — 접는 쪽이
// 모델을 잃고 아무 단가로 재계산하면 여기서 4배가 된다.
test("rollupComputedCost carries the fable-5-1 0.025x cacheRead through the fold", () => {
  const rows = rollupComputedCost(
    [
      rollupRow({ group: "bedrock", effort: "high", model: "claude-fable-5-1", cache_read_tokens: 4 * M }),
      // 대조군: 같은 입력 단가($10)의 fable-5는 파생 규칙대로 cacheRead $1 → 4.0.
      rollupRow({ group: "bedrock", effort: "medium", model: "claude-fable-5", cache_read_tokens: 4 * M }),
    ],
    ["group", "effort"]
  );
  assert.equal(rows[0].cost, 1); // 4M × $0.25/M — 파생 규칙이었다면 대조군과 똑같이 4.0이 된다
  assert.equal(rows[1].cost, 4);
  assert.equal(rows[0].tokens, 4 * M);
  assert.equal(rows[0].unpriced_tokens, 0);
});
