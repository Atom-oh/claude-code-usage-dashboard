// index.js를 import해 실제 Express app을 진짜 소켓으로 검증한다 — 순수 함수(http.js)가 아니라
// route() 래퍼 자체(400/500 매핑, no-store, 500 본문에 SQL/드라이버 오류를 안 싣기)를 핀다.
// 실측: 이 파일이 없을 때 no-store 한 줄을 지워도 스위트가 119/119로 통과했다.
//
// env를 먼저 세우고 dynamic import한다 — static import는 hoist돼서 아래 대입보다 먼저 돈다.
// CH_URL은 닫힌 포트라 데이터 라우트는 의도적으로 500이다. 그래서 이 파일을 돌리면 stderr에
// @clickhouse/client 접속 오류, `[<uuid>] /api/overview/kpi` 한 줄, `WARNING:
// AUTH_ALLOW_INSECURE=1` 경고가 찍힌다 — 전부 정상이고 실패가 아니다.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_ALLOW_INSECURE = "1";
process.env.CH_URL = "http://127.0.0.1:1";
delete process.env.BASIC_AUTH_USER;
delete process.env.BASIC_AUTH_PASSWORD;

const { app } = await import("./index.js");

let server, base;
before(() => {
  server = app.listen(0); // 0 = 커널이 빈 포트를 고른다 — 다른 테스트/로컬 서버와 충돌 없음
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("잘못된 from은 400이고 detail이 입력값을 되돌려주지 않는다", async () => {
  const r = await fetch(`${base}/api/overview/kpi?from=garbage`);
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const b = await r.json();
  assert.equal(b.error, "invalid range");
  assert.ok(!String(b.detail).includes("garbage"));
});

test("from >= to는 400", async () => {
  const r = await fetch(`${base}/api/overview/kpi?from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z`);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).detail, "'from' must be strictly earlier than 'to'");
});

test("intervalHours 0과 745는 400", async () => {
  for (const v of ["0", "745"]) {
    const r = await fetch(`${base}/api/cost/summary?intervalHours=${v}`);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, "invalid intervalHours");
  }
});

test("500 본문에는 SQL도 드라이버 오류도 실리지 않는다", async () => {
  const r = await fetch(`${base}/api/overview/kpi`);
  assert.equal(r.status, 500);
  const text = await r.text();
  // 본문 텍스트로 먼저 본다 — JSON으로 파싱한 뒤 키만 보면 값에 섞여 든 유출을 놓친다.
  assert.ok(!/SELECT|ECONNREFUSED|clickhouse/i.test(text), `leaked: ${text}`);
  const b = JSON.parse(text);
  assert.deepEqual(Object.keys(b), ["error", "id"]);
  assert.equal(b.error, "internal error");
  assert.match(b.id, /^[0-9a-f-]{36}$/);
});

test("POST /api/chat은 503이고 no-store를 단다", async () => {
  const r = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("GET /api/config는 200이고 no-store를 단다", async () => {
  const r = await fetch(`${base}/api/config`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(typeof (await r.json()).piiMask, "boolean");
});

test("healthz는 200, ClickHouse가 죽어 있으면 readyz는 503", async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
});
