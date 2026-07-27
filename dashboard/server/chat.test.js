import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSql, maskEmailValues, maskEmailText, capToolResultJson, classifyChatError, SCHEMA_CONTEXT, SYSTEM } from "./chat.js";
import { GROUP_CTE } from "./grouping.js";
import { PRICING_PROMPT_TABLE } from "./pricing.js";

// 정상 쿼리는 통과해야 한다 — 특히 cumulative 함정을 피하는 max() 서브쿼리 패턴,
// CTE, JOIN, SELECT/WHERE의 스칼라·집계 함수는 테이블 함수가 아니므로 거부되면 안 된다.
const OK = [
  "SELECT count() FROM otel_metrics_sum",
  "SELECT max(Value) FROM otel_metrics_sum WHERE MetricName = 'x'",
  "SELECT toStartOfInterval(TimeUnix, INTERVAL 1 HOUR) AS t, sum(v) FROM (SELECT max(Value) AS v FROM otel_metrics_sum GROUP BY SessionId)",
  "WITH s AS (SELECT SessionId, max(Value) v FROM otel_metrics_sum GROUP BY SessionId) SELECT sum(v) FROM s",
  "SELECT a.UserEmail FROM otel_logs a JOIN otel_metrics_sum b ON a.SessionId = b.SessionId",
  "SELECT * FROM claude_code.otel_logs",
  "SELECT UserEmail FROM otel_logs WHERE Success IN (SELECT 1)",
  "select uniqExact(UserEmail) from otel_metrics_sum",
  "SELECT * FROM claude_code . otel_logs", // 점 주변 공백 — claude_code면 정상 허용
];

// 테이블 함수 우회 시도 — 전량 거부되어야 한다.
const TABLE_FN = [
  "SELECT 1 FROM otel_logs, url('http://169.254.169.254/latest/meta-data/', 'CSV', 'x String')", // comma cross-join
  "SELECT 1 FROM url('http://evil/', 'CSV', 'x String')", // FROM 직후
  "SELECT 1 FROM otel_logs a JOIN url('http://evil/') b ON 1=1", // JOIN 직후
  "SELECT 1 FROM otel_logs CROSS JOIN url('http://evil/')", // CROSS JOIN
  "SELECT 1 FROM otel_logs ARRAY JOIN urlCluster('c', 'http://evil/')", // ARRAY JOIN + Cluster 변형
  "SELECT * FROM (SELECT * FROM url('http://evil/'))", // 서브쿼리 내부 중첩
  "WITH x AS (SELECT * FROM s3('http://evil/')) SELECT * FROM x", // CTE 내부
  "SELECT 1 FROM otel_logs, numbers(10)", // 다른 테이블 함수
  "SELECT 1 FROM remote('other', db, tbl)", // remote()
  "SELECT 1 FROM file('/etc/passwd', 'CSV')", // file()
];

const REJECT_OTHER = [
  "DROP TABLE otel_logs",
  "SELECT 1; SELECT 2",
  "SELECT 1 FROM otel_logs -- comment",
  "SELECT 1 FROM otel_logs # comment", // # 단행 주석
  "SELECT 1 FROM `otel_logs`",
  'SELECT 1 FROM "url"(\'http://169.254.169.254/\')', // 큰따옴표 식별자로 테이블 함수 우회 시도
  'SELECT 1 FROM otel_logs, "s3"(\'http://evil/\')', // 큰따옴표 + comma cross-join
  "SELECT 1 FROM url #x\n('http://evil/')", // # 주석으로 identifier( 인접성 깨기
  "SELECT * FROM information_schema.tables",
  "SELECT * FROM INFORMATION_SCHEMA.tables", // 대소문자 혼합
  "SELECT * FROM system.query_log",
];

// otel_reader의 ClickHouse grant(claude_code.*)가 apply 전이거나 미적용이면, DB 스코프를 앱
// 계층에서도 강제하지 않는 한 다른 DB를 그대로 조회할 수 있다 — 전량 거부되어야 한다.
const CROSS_DB = [
  "SELECT 1 FROM otherdb.some_table",
  "SELECT 1 FROM otel_logs, otherdb.some_table", // comma cross-join으로 다른 DB
  "SELECT 1 FROM otel_logs a JOIN otherdb.some_table b ON 1=1",
  "SELECT * FROM default.otel_logs", // claude_code 외 어떤 DB명이든 거부(대시보드는 claude_code만 씀)
  "SELECT 1 FROM otherdb . some_table", // 점 주변 공백으로 dot 검사 우회 시도
  "SELECT 1 FROM default\t.\totel_logs", // 탭도 마찬가지
];

// queryReadonly가 `SELECT * FROM (${sql}) LIMIT 201`로 감싸므로, sql 안에 짝 안 맞는 `)`가
// 있으면 그 래핑 괄호를 조기에 닫고 이어지는 `UNION ALL SELECT ... WHERE (...`로 LIMIT 201을
// 우회할 수 있다 — 괄호 불균형은 방향(초과 `)` / 초과 `(`) 무관하게 전량 거부되어야 한다.
const UNBALANCED_PARENS = [
  "SELECT 1 FROM otel_logs) UNION ALL SELECT sensitive FROM other_table WHERE (1=1",
  "SELECT 1 FROM otel_logs WHERE (1=1", // 초과 `(`
  "SELECT 1 FROM otel_logs)", // 초과 `)`
];

test("normal queries pass", () => {
  for (const sql of OK) assert.doesNotThrow(() => sanitizeSql(sql), sql);
});

test("table function bypass attempts are rejected", () => {
  for (const sql of TABLE_FN) assert.throws(() => sanitizeSql(sql), /테이블 함수/, sql);
});

test("other disallowed queries are rejected", () => {
  for (const sql of REJECT_OTHER) assert.throws(() => sanitizeSql(sql), sql);
});

test("cross-database table references are rejected", () => {
  for (const sql of CROSS_DB) assert.throws(() => sanitizeSql(sql), /claude_code 스키마/, sql);
});

test("unbalanced parentheses are rejected (LIMIT 201 wrapper breakout)", () => {
  for (const sql of UNBALANCED_PARENS) assert.throws(() => sanitizeSql(sql), /괄호/, sql);
});

// url이 문자열 리터럴 안에 있으면 테이블 함수가 아니다 — false positive 없어야 한다.
test("url inside a string literal is not a table function", () => {
  assert.doesNotThrow(() => sanitizeSql("SELECT 'from x, url(' AS s FROM otel_logs"));
});

// run_sql 결과가 모델에게 돌아가기 전에 이메일을 마스킹 — 컬럼명이 아니라 값 형태로 판단하므로
// `SELECT UserEmail AS user` 같은 별칭도 잡혀야 하고, 이메일이 아닌 문자열/숫자는 그대로여야 한다.
test("maskEmailValues masks email-shaped strings regardless of column alias", () => {
  const rows = [
    { UserEmail: "ojs0106@gmail.com", n: 921 },
    { user: "x@y.com", model: "claude-3" }, // 별칭 컬럼 + 1글자 로컬 파트
    { note: "not-an-email", count: 5 },
  ];
  assert.deepEqual(maskEmailValues(rows), [
    { UserEmail: "oj******@gmail.com", n: 921 },
    { user: "x******@y.com", model: "claude-3" },
    { note: "not-an-email", count: 5 },
  ]);
});

// groupArray(UserEmail)/Attributes map처럼 배열·객체로 내려오는 값도 재귀적으로 마스킹해야
// 한다 — 리뷰에서 MAJOR로 확인된 우회 경로(top-level string만 검사하면 통째로 샘).
test("maskEmailValues recurses into arrays and nested objects", () => {
  const rows = [
    { emails: ["ojs0106@gmail.com", "ssminji@amazon.com"], n: 2 },
    { attrs: { UserEmail: "comeddy@gmail.com", nested: { again: "x@y.com" } } },
  ];
  assert.deepEqual(maskEmailValues(rows), [
    { emails: ["oj******@gmail.com", "ss******@amazon.com"], n: 2 },
    { attrs: { UserEmail: "co******@gmail.com", nested: { again: "x******@y.com" } } },
  ]);
});

// concat('user=', UserEmail)처럼 이메일이 문자열 중간에 박혀 있어도(값 전체 일치가 아님)
// 마스킹돼야 한다 — 리뷰에서 MAJOR로 확인된 우회 경로.
test("maskEmailValues masks an email embedded inside a larger string", () => {
  const rows = [{ label: "user=ojs0106@gmail.com done" }];
  assert.deepEqual(maskEmailValues(rows), [{ label: "user=oj******@gmail.com done" }]);
});

// 마스킹은 many-to-one이라 로컬 파트가 같은 두 글자로 시작하는 서로 다른 이메일은 같은 라벨로
// 충돌한다 — 이건 알려진/받아들여진 동작(SYSTEM 프롬프트가 모델에게 재집계 금지로 안내)이므로
// 회귀 여부만 문서화해 둔다. null/숫자/불리언 등 비문자열 값은 그대로 통과해야 한다.
test("maskEmailValues: distinct emails can collide on the same masked label (documented), non-strings pass through", () => {
  const rows = [{ a: "ab1@corp.com", b: "ab2@corp.com", n: null, flag: true, count: 3 }];
  assert.deepEqual(maskEmailValues(rows), [{ a: "ab******@corp.com", b: "ab******@corp.com", n: null, flag: true, count: 3 }]);
});

// SELECT map(UserEmail, count()) ...처럼 ClickHouse Map을 JSON으로 직렬화하면 이메일이
// object의 key로 내려온다 — value만 재귀하면 key는 원문 그대로 새므로 key도 마스킹해야 한다
// (리뷰에서 MAJOR로 확인된 우회 경로).
// map(UserEmail, ...)처럼 원본 key가 이메일 형태였던 항목은 충돌 여부와 무관하게 항상
// {values: [...]}로 감싼다 — 충돌 없어도(각 라벨당 유저 1명) 이 모양을 유지해야 "배열이면
// 충돌"이라는 추측 없이 모델이 일관되게 처리할 수 있다.
test("maskEmailValues wraps email-shaped object keys' values in {values:[...]}, even without collision", () => {
  const rows = [{ "ojs0106@gmail.com": 921, "ssminji@amazon.com": 50 }];
  assert.deepEqual(maskEmailValues(rows), [{ "oj******@gmail.com": { values: [921] }, "ss******@amazon.com": { values: [50] } }]);
});

// 같은 도메인(@amazon.com)에 로컬 파트 앞 2글자까지 겹치는 두 유저의 map(UserEmail, count())
// 결과처럼, 서로 다른 key가 같은 마스킹 라벨로 충돌해도 values 배열에 둘 다 남아야 한다
// (리뷰에서 MAJOR로 확인된 데이터 정확성 결함 — last-wins로 값이 사라졌던 최초 버전의 회귀 방지).
test("maskEmailValues preserves both values when two object keys collide on the same masked label", () => {
  const rows = [{ "ssminji@amazon.com": 50, "sskim@amazon.com": 30 }];
  assert.deepEqual(maskEmailValues(rows), [{ "ss******@amazon.com": { values: [50, 30] } }]);
});

// map(UserEmail, groupArray(...))처럼 값 자체가 배열일 때, 충돌한 두 유저의 배열이
// Array.prototype.concat으로 평탄화돼 섞이면 유저 경계가 사라진다(리뷰에서 MAJOR로 재확인된
// 회귀) — values 배열의 각 원소로 원본 배열이 그대로, 안 섞인 채 들어가야 한다.
test("maskEmailValues does not flatten array values when colliding object keys both hold arrays", () => {
  const rows = [{ "aa1@x.com": [1, 2], "aa2@x.com": [3, 4] }];
  assert.deepEqual(maskEmailValues(rows), [{ "aa******@x.com": { values: [[1, 2], [3, 4]] } }]);
});

// ClickHouse 파싱 오류는 입력값을 메시지에 에코한다(toDateTime(UserEmail) → "Cannot parse
// string 'x@y.com' ...") — 이 경로로도 원본 이메일이 모델→화면에 노출되면 안 된다
// (리뷰에서 MAJOR로 확인된 우회 경로).
test("maskEmailText masks emails embedded in error messages", () => {
  assert.equal(
    maskEmailText("Code: 27. DB::Exception: Cannot parse string 'ojs0106@gmail.com' as DateTime"),
    "Code: 27. DB::Exception: Cannot parse string 'oj******@gmail.com' as DateTime"
  );
});

// server/web은 의존성을 안 섞으므로(dashboard/CLAUDE.md) web/src/fmt.js의 maskEmail을 그대로
// import할 수 없다 — 여기 복제해 두고 대표 입력에서 두 구현이 같은 출력을 내는지 고정한다.
// 어긋나면(예: 한쪽만 수정) 이 테스트가 실패해 silent divergence를 잡는다.
function webMaskEmail(s) {
  const str = String(s ?? "");
  if (!str) return str;
  const at = str.indexOf("@");
  return at === -1 ? `${str.slice(0, 2)}******` : `${str.slice(0, Math.min(2, at))}******${str.slice(at)}`;
}
test("server maskEmailText agrees with web fmt.js's maskEmail on full-string email inputs", () => {
  for (const s of ["ojs0106@gmail.com", "x@y.com", "ab@c.com", "test.user@corp.io"]) {
    assert.equal(maskEmailText(s), webMaskEmail(s), s);
  }
});

// SYSTEM 프롬프트가 GROUP_CTE(grouping.js)를 모델에게 그대로 가르친다 — 모델이 그 CTE 형태의
// bedrock/enterprise 그룹핑 쿼리를 쓸 것이므로, sanitizeSql이 실제 CTE + LEFT JOIN 쿼리를
// 통과시키는지 회귀 테스트로 고정한다(회귀하면 프롬프트가 가르친 대로 써도 챗이 막힌다).
test("sanitizeSql passes the real bedrock/enterprise GROUP_CTE joined against the hourly rollup", () => {
  const sql = `${GROUP_CTE}
SELECT g.grp AS grp, h.Model AS model, sum(h.inc) AS cost
FROM (
  SELECT SessionId, SeriesKey, Model,
         greatest(maxIf(max_value, hour < now()) - maxIf(max_value, hour < now() - INTERVAL 2 DAY), 0) AS inc
  FROM claude_code.otel_metrics_sum_hourly
  WHERE MetricName = 'claude_code.cost.usage' GROUP BY SessionId, SeriesKey, Model
) h
LEFT JOIN session_group g ON g.SessionId = h.SessionId
GROUP BY grp, model HAVING cost > 0 ORDER BY grp, cost DESC`;
  assert.doesNotThrow(() => sanitizeSql(sql));
});

// 위 테스트는 CTE가 샌드박스를 통과하는지만 본다 — 프롬프트가 그 CTE를 실제로 가르치는지는
// 별개 회귀다(문자열이 손으로 복사돼 grouping.js와 드리프트하면 챗이 다시 "그룹 구분 정보가
// 없다"고 답한다 — 이 PR이 고친 원래 버그).
test("SYSTEM embeds grouping.js's GROUP_CTE verbatim, not a hand-copied duplicate", () => {
  assert.ok(SYSTEM.includes(GROUP_CTE));
});

// 200행 상한과 별개로 hop마다 messages에 누적되는 툴 결과 텍스트 자체를 캡해야 한다 — 안 그러면
// MAX_HOPS번 왕복하는 동안 다음 hop 입력이 눈덩이처럼 불어나 maxTokens를 넘긴다(실제 증상: 긴
// 대화 뒤 챗이 죽음). 잘려도 유효한 JSON이어야 한다.
test("capToolResultJson caps large row sets and stays valid JSON", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ UserEmail: `user${i}@x.com`, cost: i }));
  const out = capToolResultJson(rows, false);
  assert.ok(JSON.stringify(out).length <= 20_000);
  assert.equal(out.truncated, true);
  assert.ok(out.rows.length < rows.length);
});

test("capToolResultJson leaves small row sets untouched", () => {
  const rows = [{ UserEmail: "a@x.com", cost: 1 }];
  assert.deepEqual(capToolResultJson(rows, false), { rows: [{ UserEmail: "a******@x.com", cost: 1 }], truncated: false });
});

// AWS SDK 에러 이름/상태코드로 사용자에게 보일 분류 문구가 갈리는지 — 이게 깨지면 모든 실패가
// 다시 "요청을 처리하지 못했습니다" 하나로 뭉개진다(원래 버그).
// SCHEMA_CONTEXT는 챗이 실제로 조회 가능한 스키마/집계 규칙을 모델에게 가르치는 유일한
// 자리다 — 이 지식이 빠지면 모델이 (a) temporality=1(delta) 행을 cumulative처럼 diff하거나,
// (b) lines_of_code.count/active_time.total의 TokenType을 token.usage 것과 혼동하거나,
// (c) cost.usage(reported)와 대시보드 계산 비용을 같은 값처럼 답하는 회귀가 조용히 재발한다.
// 실측(라이브 클러스터, DESCRIBE + GROUP BY)으로 확인한 사실이 프롬프트 문자열에서 삭제되면
// 이 테스트가 잡는다.
test("SCHEMA_CONTEXT teaches the temporality branch (cumulative vs delta), not just cumulative", () => {
  assert.match(SCHEMA_CONTEXT, /AggregationTemporality\s*=\s*2/);
  assert.match(SCHEMA_CONTEXT, /temporality\s*=\s*1\(delta\)/);
  assert.match(SCHEMA_CONTEXT, /sumIf/);
});

test("SCHEMA_CONTEXT documents TokenType's per-metric meaning (not just token.usage's)", () => {
  assert.match(SCHEMA_CONTEXT, /lines_of_code\.count[\s\S]*?added\s*\/\s*removed/);
  assert.match(SCHEMA_CONTEXT, /active_time\.total[\s\S]*?cli\s*\/\s*user/);
});

// pricing.js가 단가를 바꾸면(PRICING) 이 문자열도 같이 바뀌어야 챗이 대시보드 Cost 카드와
// 같은 숫자를 계산할 수 있다 — 인용이 아니라 하드코딩된 복제로 되돌아가면(리뷰에서 실제로
// 있었던 실수 유형) 값이 조용히 드리프트한다.
test("SCHEMA_CONTEXT quotes pricing.js's PRICING_PROMPT_TABLE verbatim, not a hand-copied duplicate", () => {
  assert.ok(SCHEMA_CONTEXT.includes(PRICING_PROMPT_TABLE));
});

test("SCHEMA_CONTEXT distinguishes reported cost (cost.usage) from the dashboard's computed cost", () => {
  assert.match(SCHEMA_CONTEXT, /reported_cost/);
  assert.match(SCHEMA_CONTEXT, /computed cost/);
});

// TokenType 값은 cacheCreation인데 PRICING 단가 필드명은 cacheWrite다 — 매핑을 명시하지 않으면
// 모델이 캐시 생성 비용을 누락하거나 존재하지 않는 TokenType='cacheWrite'로 조회해 Cost 카드와
// 다른 값을 낸다(리뷰에서 MAJOR로 확인). 두 이름이 실제로 어긋나 있음을 여기서 함께 고정한다.
test("SCHEMA_CONTEXT maps the cacheCreation TokenType onto pricing's cacheWrite field", () => {
  assert.match(PRICING_PROMPT_TABLE, /cacheWrite/); // 단가표 쪽 이름
  assert.doesNotMatch(PRICING_PROMPT_TABLE, /cacheCreation/); // 단가표에는 없는 이름
  assert.match(SCHEMA_CONTEXT, /cacheCreation\s*→\s*cacheWrite/);
  assert.match(SCHEMA_CONTEXT, /TokenType='cacheWrite'는[\s\S]*?존재하지 않/);
});

// 롤업은 시간 버킷이라 정각이 아닌 경계에서는 경계 버킷이 통째로 포함/제외된다 — 틀리는 양은
// "1시간"이 아니라 그 시간대의 실제 증가량이라 사용량이 몰리면 임의로 커진다(리뷰에서 MAJOR로
// 확인: 처음엔 양쪽 경계를 toStartOfHour로 내리고 "최대 1시간 오차"라고만 적었다). 그래서
// 프롬프트는 "정각 경계일 때만 롤업, 아니면 원본 강제"를 규칙으로 못박아야 한다.
test("SCHEMA_CONTEXT forces the raw table when the range boundaries are not whole hours", () => {
  assert.match(SCHEMA_CONTEXT, /\*\*둘 다 정각\*\*/);
  assert.match(SCHEMA_CONTEXT, /반드시 원본\s*\n?\s*otel_metrics_sum을 TimeUnix로/);
  assert.match(SCHEMA_CONTEXT, /"1시간"이 아니라/);
  assert.match(SCHEMA_CONTEXT, /toStartOfHour/);
});

// SYSTEM이 SCHEMA_CONTEXT에 가르치는 대로 temporality를 분기하는 실제 쿼리를 쓸 것이므로,
// sanitizeSql이 그 형태(중첩 if/greatest/sumIf, GROUP BY에 AggregationTemporality 포함)를
// 통과시키는지 고정한다 — 회귀하면 프롬프트가 가르친 대로 써도 챗이 막힌다.
test("sanitizeSql passes the temporality-branching (cumulative vs delta) query taught in SCHEMA_CONTEXT", () => {
  const sql = `
SELECT sum(inc) FROM (
  SELECT if(AggregationTemporality = 2,
             greatest(maxIf(max_value, hour < now()) - maxIf(max_value, hour < now() - INTERVAL 2 DAY), 0),
             sumIf(sum_value, hour >= now() - INTERVAL 2 DAY AND hour < now())) AS inc
  FROM claude_code.otel_metrics_sum_hourly
  WHERE MetricName='claude_code.cost.usage' AND hour < now()
  GROUP BY SessionId, SeriesKey, AggregationTemporality)`;
  assert.doesNotThrow(() => sanitizeSql(sql));
});

// 실측(라이브 클러스터, 2026-07-27): 모델이 별칭에 큰따옴표(예: AS "그룹")를 쓰면 sanitizeSql이
// "주석/인용부호는 허용되지 않습니다"로 쿼리 전체를 거부한다 — 인용부호 자체는 무해한데도
// 테이블 함수 우회 방어(assertNoTableFunctions)가 인용부호가 있으면 토큰 경계를 신뢰할 수
// 없다는 전제로 전부 차단하기 때문이다(보안 샌드박스는 건드리지 않는다). 실측 확인: 프리셋
// 질문 하나에서 hop 4개 중 3개가 이 사유로 ClickHouse에 도달하지도 못하고 낭비됐다. 프롬프트가
// 이 함정을 명시적으로 경고하지 않으면 회귀한다.
test("SYSTEM warns the model against double-quoted/backtick aliases (sanitizeSql rejects them outright)", () => {
  assert.match(SYSTEM, /큰따옴표.*백틱|따옴표/);
  assert.doesNotThrow(() => sanitizeSql(`SELECT count() AS total FROM otel_logs`));
  assert.throws(() => sanitizeSql(`SELECT count() AS "total" FROM otel_logs`), /주석\/인용부호/);
});

test("classifyChatError maps known AWS error names to distinct Korean messages", () => {
  const throttled = classifyChatError({ name: "ThrottlingException", $metadata: { requestId: "r1" } });
  const denied = classifyChatError({ name: "AccessDeniedException" });
  const unknown = classifyChatError({ name: "SomeOtherError" });
  assert.match(throttled, /몰려/);
  assert.match(throttled, /r1/);
  assert.match(denied, /권한/);
  assert.match(unknown, /요청을 처리하지 못했습니다/);
  assert.notEqual(throttled, denied);
  assert.notEqual(denied, unknown);
});
