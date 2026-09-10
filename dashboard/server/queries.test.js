import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ClickHouseClient } from "@clickhouse/client";
import * as queries from "./queries.js";
import { bucket, filterCond, alignHistoricalTo, range, incFlat, incFlatRaw, incBucketed, normModel, UNTAGGED_PROJECT } from "./queries.js";
import { toChDateTime } from "./clickhouse.js"; // queries.js가 이미 로드하는 모듈 — 부작용 없음
import { GROUP_CTE } from "./grouping.js";

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

// normModel()의 5단계 regex는 pricing.js normalizeModelId() / grafana-ab-queries.sql 패널 12와
// 반드시 동기 유지해야 하는 사본이다(각 파일 주석에 명시) — 값 비교는 SQL 문자열이라 못 하지만,
// SQL이 만드는 4번째 단계(bedrock 버전 접미사) 패턴이 -v1:0뿐 아니라 :0 없는 맨 -v1까지
// 벗기는 형태인지는 문자열로 확인할 수 있다. 세 사본 중 하나만 고치는 드리프트를 잡는 게 목적.
test("normModel SQL mirrors normalizeModelId's -v<n> (with optional :n) suffix rule", () => {
  const sql = normModel("Model");
  assert.ok(sql.includes("-v\\\\d+(:\\\\d+)?$"), `expected the bare -vN suffix pattern in: ${sql}`);
  // us-gov/jp/au 리전 프로파일까지 벗기는지 — 다섯 사본(pricing.js / 이 SQL /
  // grafana-ab-queries.sql 두 곳 / chat.test.js 핀) 중 하나만 고치는 드리프트를 잡는다.
  assert.ok(sql.includes("us-gov|eu|apac|jp|au|global"), `expected the widened geo-prefix alternation in: ${sql}`);
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

// rollup 분기(span≥4h, 기본 2일 뷰 포함)의 cumulative baseline — 세 가지 근사를 모두 실측으로
// 검증했다. hour는 "그 버킷 종료 시점" 값이라 근사마다 오차가 생긴다:
//   - hour < toStartOfHour(from): baseline이 너무 작아짐 → diff 과대집계(라이브 실측: 504만).
//   - hour < from (라운드 9): baseline이 너무 커짐(from-hour 종료 시점 값) → diff 과소집계
//     (라이브 실측: 27,066).
//   - from-hour rollup 행을 raw stitch로 "대체"(라운드 10, UNION ALL): 세션이 from-hour
//     안에서만 성장하고 그 뒤 rollup 행이 없으면 대체된 행(pre-from만 담음)이 baseline·current
//     양쪽에서 선택돼 post-from 성장분이 통째로 사라진다(리뷰에서 재확인 — 대체가 아니라
//     보정이어야 했다).
// 정확한 해법: 원본 rollup 행은 그대로 두고(current는 항상 정확), baseline만
// `greatest(이전 hour까지의 rollup max, raw로 구한 정확한 from 시점 값)`로 보정한다. delta는
// sum이라 같은 방식이 안 통해 from-hour의 sum_value 자체를 raw의 [from, hour 끝) 재계산값으로
// 대체한다. 라이브 클러스터로 to가 from-hour 안/다음 hour인 두 시나리오 모두 정확한
// diff(27,066)가 나옴을 확인했다.
test("incFlat's rollup branch corrects (not replaces) the from-hour baseline via raw lookup", () => {
  const rollup = incFlat("", 6 * 3600000); // 4h 초과 → rollup 분기
  assert.match(rollup, /UNION ALL/);
  assert.match(rollup, /maxIf\(Value, TimeUnix < \{from:DateTime\}\) AS from_hour_raw_baseline/);
  assert.match(rollup, /greatest\(maxIf\(mv, hh < toStartOfHour\(\{from:DateTime\}\)\), max\(from_hour_raw_baseline\)\)/);
  // 원본 rollup 행이 대체되지 않고 그대로 살아있어야 한다 — "hour != toStartOfHour(from)"로
  // 제외하지 않는다(라운드 10의 결함).
  assert.doesNotMatch(rollup, /hour != toStartOfHour/);
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

// incBucketed(시계열)가 첫 부분 버킷(t=from이 속한 버킷)을 raw-stitch로 보정해도, 최종 WHERE가
// 여전히 `t >= {from:DateTime}`이면 그 버킷의 t 라벨(항상 from보다 이르거나 같은 버킷 시작)이
// 필터에 걸려 보정된 값 자체가 통째로 버려진다 — 라이브 클러스터로 재현된 실제 회귀(값은
// 정확한데 최종 합계에 반영이 안 됨). WHERE가 `t >= startExpr`(그 버킷의 시작, from이 아니라
// 버킷 경계 기준)로 바뀌어야 첫 버킷이 살아남는다.
test("incBucketed keeps the raw-stitched first bucket alive — outer WHERE must use the bucket boundary, not {from}", () => {
  const sql = incBucketed(1, "toStartOfInterval(hour, INTERVAL {intervalHours:UInt32} HOUR)", "");
  assert.match(sql, /from_bucket_raw_baseline/);
  assert.match(sql, /from_bucket_raw_delta/);
  assert.doesNotMatch(sql, /WHERE t >= \{from:DateTime\}/);
  assert.match(sql, /WHERE t >= toStartOfInterval\(\{from:DateTime\}/);
});

// 첫 버킷의 raw delta 스캔이 버킷 끝(endExpr)이 아니라 요청 구간의 {to}도 상한으로 잡아야 한다 —
// 안 그러면 요청 구간이 버킷 폭보다 짧을 때(예: intervalHours=1인데 to-from=30분) endExpr가
// {to}를 넘어가 [from,to) 밖의 delta까지 새 들어온다(리뷰에서 MAJOR로 확인).
test("incBucketed caps the first-bucket raw delta scan at least(bucket-end, {to}), not bucket-end alone", () => {
  const sql = incBucketed(1, "toStartOfInterval(hour, INTERVAL {intervalHours:UInt32} HOUR)", "");
  assert.match(sql, /TimeUnix < least\(.*\{to:DateTime\}\)/);
});

// bedrock 판별은 "Model이 빈 값이 아니고 bare claude-*가 아니면"이다 — Bedrock은 비-Anthropic
// 모델(openai./xai./moonshotai. 등)도 서빙하는데 예전 조건('anthropic.' 또는 ':' 포함)은 이들을
// 놓쳐 32세션이 unknown, 2세션이 enterprise로 새고 있었다(실측 2026-09-04, grouping.js 주석).
// SQL 문자열이라 실행 검증은 못 하지만, (1) 조건식 자체와 (2) bedrock 분기가 has_org(enterprise)
// 분기보다 먼저 평가되는 것(비-Claude 모델을 쓴 has_org 세션은 bedrock이 이겨야 함)을 고정한다.
test("GROUP_CTE classifies any non-bare-claude model as bedrock, and bedrock wins over has_org", () => {
  assert.match(GROUP_CTE, /countIf\(Model != '' AND NOT startsWith\(Model, 'claude-'\)\) > 0, 'bedrock'/);
  assert.ok(
    GROUP_CTE.indexOf("'bedrock'") < GROUP_CTE.indexOf("max(has_org) = 1, 'enterprise'"),
    "bedrock branch must precede the enterprise branch in multiIf"
  );
});

// 위 SQL 조건의 의미론을 라이브 census(2026-09-04, otel_metrics_sum_hourly의 distinct Model
// 전수) 기준으로 고정하는 진리표 — SQL의 startsWith와 동일한 JS 판별식으로 각 형태가 어느
// 그룹 증거인지 문서화한다. 새 모델 형태가 라이브에 나타나면 여기에 추가할 것.
test("bedrock-evidence rule truth table over the live model roster", () => {
  const isBedrockEvidence = (m) => m !== "" && !m.startsWith("claude-");
  // Bedrock: [global.|us.]anthropic.* (글로벌/리전 추론 프로파일), anthropic.* (인리전),
  // -vN:M 버전 접미사, 비-Anthropic 프로바이더
  for (const m of [
    "global.anthropic.claude-sonnet-5",
    "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    "us.anthropic.claude-fable-5",
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "anthropic.claude-sonnet-5",
    "anthropic.claude-opus-5",
    "global.openai.gpt-5.6-sol",
    "global.xai.grok-4.6",
    "moonshotai.kimi-k2.5",
    "zai.glm-5",
    "deepseek.v3.2",
    "devstral-small-2",
    "minimax.minimax-m2.5",
    "gemma-4-31b-vllm",
    "qwen.qwen3-coder-next",
  ]) assert.ok(isBedrockEvidence(m), `${m} must count as bedrock evidence`);
  // Enterprise 스타일(bare claude-*, [1m] 컨텍스트 접미사 포함)과 빈 값은 bedrock 증거가 아니다
  for (const m of ["claude-sonnet-5", "claude-fable-5[1m]", "claude-haiku-4-5-20251001", "claude-fable-5-1", "claude-opus-4-8", ""])
    assert.ok(!isBedrockEvidence(m), `${m || "(empty)"} must NOT count as bedrock evidence`);
});

// project 필터는 정확 일치다 — 부분일치면 'api'가 'api-gateway'까지 잡아 프로젝트별 비교가
// 무의미해진다. cols.project를 안 넘긴 쿼리에는 아예 적용되지 않아야 한다(그 테이블에 컬럼이
// 없을 수 있다).
test("filterCond applies project as an exact match only when cols.project is given", () => {
  const f = filterCond({ project: "repo-a" }, { project: "m.ProjectName" });
  assert.match(f.where, /m\.ProjectName = \{fProject:String\}/);
  assert.strictEqual(f.params.fProject, "repo-a");
  assert.doesNotMatch(f.where, /positionCaseInsensitive\(m\.ProjectName/);

  const noCol = filterCond({ project: "repo-a" }, { group: "grp" });
  assert.doesNotMatch(noCol.where, /fProject/);
  assert.strictEqual(noCol.params.fProject, undefined);
});

// '(untagged)'는 projectBreakdown이 ProjectName='' 행에 붙이는 표시용 라벨이다. 사용자가 표에서
// 그 값을 그대로 복사해 필터에 넣는 경로가 실제로 있으므로, 저장된 값('')으로 되돌려야 0행이
// 되지 않는다.
test("filterCond maps the (untagged) display label back to the stored empty string", () => {
  assert.strictEqual(UNTAGGED_PROJECT, "(untagged)");
  const f = filterCond({ project: UNTAGGED_PROJECT }, { project: "m.ProjectName" });
  assert.strictEqual(f.params.fProject, "");
  assert.match(f.where, /m\.ProjectName = \{fProject:String\}/);
});

// 2026-09-09 신규 쿼리 4개는 실행하려면 라이브 ClickHouse가 필요해 단위 테스트로 값을 볼 수
// 없다. 대신 이 저장소가 실제로 겪은 두 가지 회귀를 소스 텍스트로 고정한다: (1) 누적 카운터를
// 직접 합산하는 것(CLAUDE.md의 100x+ 과대집계), (2) 프로젝트 그레인을 시간별 롤업에서 읽으려
// 하는 것(005는 롤업을 건드리지 않으므로 ProjectName이 거기 없다).
test("the 2026-09-09 query block diffs cumulative counters and never reads the hourly rollup", () => {
  const src = readFileSync(fileURLToPath(new URL("./queries.js", import.meta.url)), "utf8");
  const marker = "// 2026-09-09 추가 패널";
  const at = src.indexOf(marker);
  assert.ok(at > 0, "expected the 2026-09-09 section banner in queries.js");
  const section = src.slice(at);

  // 세션-경계 diff 공식(incFlat/versionCohortCost와 같은 형태)이 그대로 있어야 한다.
  assert.ok(
    section.includes("greatest(maxIf(Value, TimeUnix < {to:DateTime}) - maxIf(Value, TimeUnix < {from:DateTime}), 0)"),
    "projectBreakdown must keep the session-boundary diff formula"
  );
  // 누적 값(Value)을 그대로 합산하는 형태가 없어야 한다 — 합산 대상은 diff 결과(inc)뿐이다.
  assert.doesNotMatch(section, /sumIf\(\s*m\.Value/, "never sum cumulative Value directly");
  assert.doesNotMatch(section, /\bsum\(\s*m\.Value/, "never sum cumulative Value directly");
  // 프로젝트 그레인은 원본 테이블에서만 나온다.
  assert.ok(section.includes("FROM claude_code.otel_metrics_sum\n"), "projectBreakdown must read the raw table");
  assert.doesNotMatch(section, /otel_metrics_sum_hourly/, "the rollup carries no ProjectName (005 leaves it alone)");
});

// 라우트 4개가 import하는 이름이라 export가 빠지면 서버가 부팅 시 죽는다(index.js의 `q.*`는
// 런타임 참조라 조용히 undefined가 되고 첫 요청에서 500이 된다).
test("the four 2026-09-09 query functions are exported", async () => {
  const q = await import("./queries.js");
  for (const name of ["projectBreakdown", "permissionModeChanges", "toolDecisionSources", "entrypointBreakdown"]) {
    assert.strictEqual(typeof q[name], "function", `${name} must be exported as a function`);
  }
});

const costRow = (overrides = {}) => ({
  group: "bedrock", model: "claude-opus-5",
  input_tokens: "1000000", output_tokens: "0", cache_read_tokens: "0", cache_write_tokens: "0",
  reported_cost: "3", sessions: "0", ...overrides,
});
const from = new Date("2026-09-08T12:00:00Z");
const to = new Date("2026-09-08T14:00:00Z");
const prevFrom = new Date("2026-09-08T10:00:00Z");

function stubCostRows(t, rows) {
  // query() owns an HTTP call; keep the real endpoint transformations and replace only that boundary.
  return t.mock.method(Object.getPrototypeOf(ClickHouseClient.prototype), "query", async () => ({
    json: async () => rows,
  }));
}

test("costSummary preserves computed diagnostics while folding reported spend and missing coverage", async (t) => {
  stubCostRows(t, [
    costRow({ sessions: "2" }),
    costRow({ model: "unknown-model", reported_cost: "7", sessions: "3" }),
    costRow({ model: "", reported_cost: undefined, input_tokens: 0, sessions: "4" }),
    costRow({ group: "enterprise", reported_cost: 2 }),
    costRow({ group: "enterprise", model: "claude-sonnet-5", reported_cost: 0, cache_write_tokens: 1 }),
    costRow({ group: "unknown", reported_cost: null }),
  ]);
  const rows = await queries.costSummary(from, to);
  assert.deepEqual(rows.map((row) => row.group), ["bedrock", "enterprise", "unknown"]);
  assert.deepEqual(rows[0], {
    group: "bedrock", computed_cost: 5, reported_cost: 10,
    display_cost: 10, reported_cost_status: "reported",
    input_tokens: 2_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    unpriced_tokens: 1_000_000, sessions: 9,
  });
  assert.ok(Math.abs(rows[1].computed_cost - 7.000004) < 1e-12);
  assert.equal(rows[1].reported_cost, 2);
  assert.equal(rows[1].display_cost, null);
  assert.equal(rows[1].reported_cost_status, "partial");
  assert.equal(rows[2].display_cost, null);
  assert.equal(rows[2].reported_cost_status, "partial");
});

test("costSummary retains the supplied unpriced Bedrock baseline and harmless unknown-group zero", async (t) => {
  stubCostRows(t, [
    costRow({ model: "unknown-model", input_tokens: 541676, reported_cost: 3.260704 }),
    costRow({ group: "unknown", model: "", input_tokens: 0, reported_cost: 0, sessions: 1 }),
  ]);
  const [bedrock, unknown] = await queries.costSummary(
    new Date("2026-09-04T00:00:00Z"), new Date("2026-09-10T00:00:00Z"),
  );
  assert.equal(bedrock.computed_cost, 0);
  assert.equal(bedrock.unpriced_tokens, 541676);
  assert.equal(bedrock.reported_cost, 3.260704);
  assert.equal(bedrock.display_cost, 3.260704);
  assert.equal(bedrock.reported_cost_status, "reported");
  assert.equal(unknown.computed_cost, 0);
  assert.equal(unknown.display_cost, 0);
  assert.equal(unknown.reported_cost_status, "reported");
  assert.equal(unknown.sessions, 1);
});

for (const endpoint of ["costByModel", "costByUserModel", "costByModelDaily"]) {
  test(`${endpoint} returns reported display spend including unknown-price models and ambiguous zero`, async (t) => {
    const fixtures = [
      costRow({ user: "a", t: "2026-09-08 12:00:00" }),
      costRow({ user: "a", model: "unknown-model", reported_cost: "7" }),
      costRow({ user: "b", reported_cost: "0" }),
      costRow({ user: "c", input_tokens: "0", reported_cost: "0" }),
      costRow({ user: "d", reported_cost: null }),
    ];
    stubCostRows(t, fixtures);
    const rows = await queries[endpoint](from, to);
    assert.equal(rows[0].cost, 5);
    assert.equal(rows[0].display_cost, 3);
    assert.equal(rows[0].reported_cost, "3");
    assert.equal(rows[1].cost, null);
    assert.equal(rows[1].unpriced, true);
    assert.equal(rows[1].display_cost, 7);
    assert.equal(rows[1].reported_cost_status, "reported");
    assert.equal(rows[2].display_cost, null);
    assert.equal(rows[2].reported_cost_status, "unverified_zero");
    assert.equal(rows[3].display_cost, 0);
    assert.equal(rows[3].reported_cost_status, "reported");
    assert.equal(rows[4].display_cost, null);
    assert.equal(rows[4].reported_cost_status, "unavailable");
  });
}

test("costByModelCompare classifies previous reported zero using previous tokens", async (t) => {
  stubCostRows(t, [
    costRow({
      prev_reported_cost: "0", prev_input_tokens: 0, prev_output_tokens: 0,
      prev_cache_read_tokens: 0, prev_cache_write_tokens: 0,
    }),
    costRow({
      input_tokens: 0, reported_cost: "0", prev_reported_cost: "0",
      prev_input_tokens: 0, prev_output_tokens: 0, prev_cache_read_tokens: "1", prev_cache_write_tokens: 0,
    }),
    costRow({
      model: "unknown-model", prev_reported_cost: "2", prev_input_tokens: 100,
      prev_output_tokens: 0, prev_cache_read_tokens: 0, prev_cache_write_tokens: 0,
    }),
    costRow({
      prev_reported_cost: null, prev_input_tokens: 1_000_000,
      prev_output_tokens: 0, prev_cache_read_tokens: 0, prev_cache_write_tokens: 0,
    }),
  ]);
  const rows = await queries.costByModelCompare(from, to, prevFrom);
  assert.equal(rows[0].cost, 5);
  assert.equal(rows[0].display_cost, 3);
  assert.equal(rows[0].prev_cost, 0);
  assert.equal(rows[0].prev_display_cost, 0);
  assert.equal(rows[0].prev_reported_cost_status, "reported");
  assert.equal(rows[0].prev_reported_cost, "0");
  assert.equal(rows[1].display_cost, 0);
  assert.equal(rows[1].prev_cost, 0.0000005);
  assert.equal(rows[1].prev_display_cost, null);
  assert.equal(rows[1].prev_reported_cost_status, "unverified_zero");
  assert.equal(rows[2].prev_cost, null);
  assert.equal(rows[2].prev_display_cost, 2);
  assert.equal(rows[2].prev_reported_cost_status, "reported");
  assert.equal(rows[3].prev_cost, 5);
  assert.equal(rows[3].prev_display_cost, null);
  assert.equal(rows[3].prev_reported_cost_status, "unavailable");
});

test("effortMix folds and orders by reported spend within each group", async (t) => {
  stubCostRows(t, [
    costRow({ effort: "high", reported_cost: 1 }),
    costRow({ effort: "low", model: "unknown-model", reported_cost: 7 }),
    costRow({ effort: "partial", reported_cost: 20 }),
    costRow({ effort: "partial", model: "unknown-model", reported_cost: 0 }),
  ]);
  const rows = await queries.effortMix(from, to);
  assert.deepEqual(rows.map((row) => row.effort), ["low", "high", "partial"]);
  assert.equal(rows[0].display_cost, 7);
  assert.equal(rows[0].cost, 0);
  assert.equal(rows[0].unpriced_tokens, 1_000_000);
  assert.equal(rows[2].display_cost, null);
  assert.equal(rows[2].reported_cost, 20);
  assert.equal(rows[2].reported_cost_status, "partial");
});

test("agentCost ranks reported spend before the top-30 cutoff and places unavailable spend last", async (t) => {
  stubCostRows(t, [
    ...Array.from({ length: 31 }, (_, i) => costRow({
      agent: `computed-${i}`, input_tokens: 1_000_000 * (i + 1), reported_cost: 1,
    })),
    costRow({ agent: "reported-leader", model: "unknown-model", reported_cost: "99" }),
    costRow({ agent: "reported-leader", reported_cost: 1 }),
    costRow({ agent: "unavailable", reported_cost: 0, input_tokens: 1e12 }),
  ]);
  const rows = await queries.agentCost(from, to);
  assert.equal(rows.length, 30);
  assert.equal(rows[0].agent, "reported-leader");
  assert.equal(rows[0].display_cost, 100);
  assert.equal(rows[0].cost, 5);
  assert.equal(rows.some((row) => row.agent === "unavailable"), false);
});

test("reportedVsComputedByVersion retains the reported/computed ratio as display spend changes", async (t) => {
  stubCostRows(t, [costRow({ app_version: "2.1.test", requests: 2 })]);
  const [row] = await queries.reportedVsComputedByVersion(from, to);
  assert.equal(row.cost, 5);
  assert.equal(row.display_cost, 3);
  assert.equal(row.reported_cost, "3");
  assert.equal(row.ratio, 0.6);
});

test("log cost queries select valid micros before falling back to dollars without adding both fields", async (t) => {
  const request = stubCostRows(t, []);
  for (const endpoint of ["reportedVsComputedByVersion", "entrypointBreakdown"]) {
    await queries[endpoint](from, to);
    const sql = request.mock.calls.at(-1).arguments[0].query;
    assert.match(sql, /toFloat64OrNull\(l\.LogAttributes\['cost_usd_micros'\]\)/);
    assert.match(sql, /isFinite\(/);
    assert.match(sql, /cost_usd_micros'\]\) >= 0/);
    assert.match(sql, /cost_usd_micros'\]\) <= 9007199254740991/);
    assert.match(sql, /cost_usd_micros'\]\) \/ 1000000/);
    assert.match(sql, /toFloat64OrZero\(l\.LogAttributes\['cost_usd'\]\)/);
    assert.doesNotMatch(sql, /sum\(toFloat64OrZero\(l\.LogAttributes\['cost_usd'\]\)\)/);
  }
});
