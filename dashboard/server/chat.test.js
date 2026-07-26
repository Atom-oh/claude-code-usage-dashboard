import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSql, maskEmailValues, maskEmailText } from "./chat.js";

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
test("maskEmailValues masks email-shaped object keys, not just values", () => {
  const rows = [{ "ojs0106@gmail.com": 921, "ssminji@amazon.com": 50 }];
  assert.deepEqual(maskEmailValues(rows), [{ "oj******@gmail.com": 921, "ss******@amazon.com": 50 }]);
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
