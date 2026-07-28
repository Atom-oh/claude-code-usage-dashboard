import { createClient } from "@clickhouse/client";

// ponytail: single shared client, no pool wrapper — @clickhouse/client already pools HTTP keep-alive connections.
// max_open_connections 기본값 10은 index.js의 캐시 warmer(배치당 5개 동시 쿼리)와 실제 브라우저
// 트래픽(useApi가 페이지당 7~9개 동시 요청)이 겹치면 쉽게 고갈된다 — 소켓 대기가 request_timeout에
// 포함되어 정상 쿼리(leaderboard 등, ClickHouse 자체 처리는 2~3초)가 타임아웃으로 잡히는 원인이었다
// (실측 2026-07-10: warm /api/users/leaderboard Timeout error). 30으로 늘려 warmer 배치 + 동시
// 브라우저 요청을 함께 감당한다.
const client = createClient({
  url: process.env.CH_URL || `http://${process.env.CH_HOST || "localhost"}:${process.env.CH_PORT || "8123"}`,
  database: process.env.CH_DB || "claude_code",
  username: process.env.CH_USER || "default",
  password: process.env.CH_PASSWORD || "",
  request_timeout: 30000,
  max_open_connections: 30,
});

export function toChDateTime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export async function query(sql, query_params = {}) {
  const rs = await client.query({ query: sql, query_params, format: "JSONEachRow" });
  return rs.json();
}

// 챗봇 run_sql 툴 전용. otel_reader 계정 프로필이 서버 쪽에서 이미 readonly=1을 강제해
// 쓰기는 원천 차단되지만, 그 결과 클라이언트가 clickhouse_settings로 *어떤* 세션 설정을
// 바꾸는 것도(readonly 자체는 물론 max_result_rows 같은 무관한 값도) 거부한다
// (실측: "Cannot modify 'max_result_rows' setting in readonly mode") — 그래서 행수 상한은
// SQL을 LIMIT 201 서브쿼리로 감싸 서버 쪽에서 강제하고(201행이면 잘린 것), 타임아웃은
// AbortController로 HTTP 요청 자체를 취소해 ClickHouse가 쿼리를 kill하게 한다.
// sanitize(chat.js)가 1차 방어.
// externalSignal(브라우저가 SSE 연결을 끊었을 때 chat.js가 넘기는 신호)이 걸리면 30초를
// 기다리지 않고 즉시 이 쿼리도 취소한다 — 클라이언트가 사라진 뒤에도 ClickHouse가 계속
// 풀스캔을 도는 걸 막는다. 타임아웃 abort와 외부 abort를 구분해야 에러 메시지가 정확하다
// (외부 abort는 "30초 초과"가 아니므로 그대로 AbortError를 던져 위로 전달한다).
export async function queryReadonly(sql, externalSignal) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30000);
  const signal = externalSignal ? AbortSignal.any([abort.signal, externalSignal]) : abort.signal;
  try {
    const rs = await client.query({
      query: `SELECT * FROM (${sql}) LIMIT 201`,
      format: "JSONEachRow",
      abort_signal: signal,
    });
    const rows = await rs.json();
    return { rows: rows.slice(0, 200), truncated: rows.length > 200 };
  } catch (err) {
    if (abort.signal.aborted) throw new Error("쿼리 30초 초과");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function ping() {
  const r = await client.ping();
  return r.success;
}
