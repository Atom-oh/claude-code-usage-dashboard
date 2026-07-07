import { createClient } from "@clickhouse/client";

// ponytail: single shared client, no pool wrapper — @clickhouse/client already pools HTTP keep-alive connections.
const client = createClient({
  url: process.env.CH_URL || `http://${process.env.CH_HOST || "localhost"}:${process.env.CH_PORT || "8123"}`,
  database: process.env.CH_DB || "claude_code",
  username: process.env.CH_USER || "default",
  password: process.env.CH_PASSWORD || "",
  request_timeout: 15000,
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
// (실측: "Cannot modify 'max_result_rows' setting in readonly mode") — 그래서 행수/시간
// 상한은 여기서 걸지 않고 JS 쪽(slice + race timeout)에서 건다. sanitize(chat.js)가 1차 방어.
export async function queryReadonly(sql) {
  const rs = await Promise.race([
    client.query({ query: sql, format: "JSONEachRow" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("쿼리 30초 초과")), 30000)),
  ]);
  const rows = await rs.json();
  return rows.slice(0, 200);
}

export async function ping() {
  const r = await client.ping();
  return r.success;
}
