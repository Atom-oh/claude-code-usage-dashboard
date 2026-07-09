import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSql } from "./chat.js";

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
