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

// 챗 샌드박스의 전제("이 서버가 붙은 ClickHouse 계정은 readonly")를 가정하지 않고 부팅 시
// 실측한다. 정상 배포에서는 otel_reader 프로필이 readonly=1을 강제하지만, compose·오설정·
// otel_writer로 뜨면 run_sql 툴이 쓰기 능력을 갖고 sanitizeSql(chat.js) 하나만 남는다.
// 클라이언트 쪽에서 clickhouse_settings로 readonly=1을 걸 수는 없다(위 주석 — otel_reader
// 프로필이 세션 설정 변경 자체를 거부한다). 그래서 강제하지 못하는 대신 확인만 한다.
const READONLY_PROBE_SQL = "SELECT toUInt8(getSetting('readonly')) AS ro";

// Number() 강제 변환이 이 함수의 핵심이다: @clickhouse/client는 JSONEachRow에서 정수를
// 문자열로 줄 수 있다(실측 2026-09-02, schema.js classifySeriesKeyProbe와 같은 실패 모드).
// `row.ro >= 1` 같은 비교를 문자열에 그대로 걸면 조용히 틀린 결과가 나오므로 숫자로 바꾼 뒤
// 판정한다. 판정 불가(행 없음/필드 없음/숫자 아님)는 null — 호출자가 fail-closed로 다룬다.
export function classifyReadonly(row) {
  if (!row || row.ro === undefined || row.ro === null) return null;
  const ro = Number(row.ro);
  if (!Number.isFinite(ro)) return null;
  return ro >= 1;
}

// 부팅/주기 실행 모두 비치명적 — 어떤 에러(접속 불가, 권한, 문법)든 null로 접는다. null은
// "readonly가 아니다"가 아니라 "확인하지 못했다"이고, 호출자는 둘을 같게(챗 비활성) 다룬다.
export async function assertReadonlySession() {
  try {
    const rows = await query(READONLY_PROBE_SQL);
    if (!rows || rows.length === 0) return null;
    return classifyReadonly(rows[0]);
  } catch {
    return null;
  }
}

export async function ping() {
  const r = await client.ping();
  return r.success;
}
