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
  "SELECT 1 FROM `otel_logs`",
  "SELECT * FROM information_schema.tables",
  "SELECT * FROM INFORMATION_SCHEMA.tables", // 대소문자 혼합
  "SELECT * FROM system.query_log",
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

// url이 문자열 리터럴 안에 있으면 테이블 함수가 아니다 — false positive 없어야 한다.
test("url inside a string literal is not a table function", () => {
  assert.doesNotThrow(() => sanitizeSql("SELECT 'from x, url(' AS s FROM otel_logs"));
});
