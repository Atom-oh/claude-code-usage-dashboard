import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAlert, initialAlertState, planAlert, postWebhook, startAlertLoop } from "./alerting.js";

// 이 파일의 단정문은 전부 인자로 상태를 주입하므로 env와 무관해야 한다. 그런데 알림을
// 디버깅하는 사람이 바로 ALERT_WEBHOOK_URL을 export해 둔 사람이다 — 그 경우 index.js가
// 실제 루프를 켜고, 원인을 가리키지 않는 실패가 다른 파일에서 나온다. 여기서 한 줄로
// 분명하게 먼저 실패시킨다.
test("this file assumes ALERT_WEBHOOK_URL / ALERT_REPEAT_MINUTES are unset", () => {
  assert.equal(process.env.ALERT_WEBHOOK_URL, undefined, "unset ALERT_WEBHOOK_URL and re-run");
  assert.equal(process.env.ALERT_REPEAT_MINUTES, undefined, "unset ALERT_REPEAT_MINUTES and re-run");
});

const HOST = "dashboard-7c9f";
const REPEAT = 60 * 60_000;
const ok = (age = 3) => ({ status: "ok", latest: "2026-09-03T00:00:00.000Z", ageMinutes: age, staleAfterMinutes: 360 });
const stale = (age = 412) => ({ status: "stale", latest: "2026-09-02T00:00:00.000Z", ageMinutes: age, staleAfterMinutes: 360 });
const unknown = () => ({ status: "unknown", latest: null, ageMinutes: null, staleAfterMinutes: 360 });

async function captureWarn(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (...a) => lines.push(a.join(" "));
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.warn = orig;
  }
}

test("formatAlert produces the three literal forms", () => {
  assert.equal(
    formatAlert("firing", stale(), { hostname: HOST }),
    "[ccdash] telemetry STALE on dashboard-7c9f: last row 412 min ago (threshold 360). See docs/runbooks/alerting.md"
  );
  assert.equal(
    formatAlert("repeat", stale(500), { hostname: HOST }),
    "[ccdash] telemetry still STALE on dashboard-7c9f: last row 500 min ago (threshold 360). See docs/runbooks/alerting.md"
  );
  assert.equal(
    formatAlert("recovered", ok(3), { hostname: HOST }),
    "[ccdash] telemetry recovered on dashboard-7c9f: last row 3 min ago"
  );
  assert.match(
    formatAlert("firing", unknown(), { hostname: HOST }),
    /UNKNOWN on dashboard-7c9f: ClickHouse probe failed/
  );
});

test("planAlert ladder: debounce, repeat, recovery, and a second ok stays silent", () => {
  let state = initialAlertState();
  let r = planAlert(state, ok(), 0, REPEAT, { hostname: HOST });
  assert.equal(r.message, null);
  assert.equal(r.state.status, "ok");
  state = r.state;

  r = planAlert(state, stale(), 1000, REPEAT, { hostname: HOST });
  assert.equal(r.message, null);
  assert.equal(r.state.notOkTicks, 1);
  state = r.state;

  r = planAlert(state, stale(), 61_000, REPEAT, { hostname: HOST });
  assert.match(r.message, /^\[ccdash\] telemetry STALE on dashboard-7c9f/);
  assert.equal(r.state.alerted, true);
  assert.equal(r.state.lastSentMs, 61_000);
  state = r.state;

  r = planAlert(state, stale(), 121_000, REPEAT, { hostname: HOST });
  assert.equal(r.message, null);
  state = r.state;

  r = planAlert(state, stale(500), 61_000 + REPEAT, REPEAT, { hostname: HOST });
  assert.match(r.message, /still STALE/);
  state = r.state;

  r = planAlert(state, ok(2), 61_000 + REPEAT + 5000, REPEAT, { hostname: HOST });
  assert.match(r.message, /telemetry recovered on dashboard-7c9f: last row 2 min ago/);
  assert.equal(r.state.alerted, false);
  assert.equal(r.state.notOkTicks, 0);
  state = r.state;

  r = planAlert(state, ok(2), 61_000 + REPEAT + 6000, REPEAT, { hostname: HOST });
  assert.equal(r.message, null, "a second ok must not re-send a recovery");
});

test("a status change inside one incident (stale<->unknown) does not page twice", () => {
  let state = initialAlertState();
  let r = planAlert(state, ok(), 0, REPEAT, { hostname: HOST });
  state = r.state;

  r = planAlert(state, unknown(), 1000, REPEAT, { hostname: HOST });
  assert.equal(r.message, null);
  state = r.state;

  r = planAlert(state, unknown(), 61_000, REPEAT, { hostname: HOST });
  assert.match(r.message, /UNKNOWN/);
  state = r.state;

  r = planAlert(state, stale(), 121_000, REPEAT, { hostname: HOST });
  assert.equal(r.message, null, "a status change inside one incident must not page again");
  assert.equal(r.state.status, "stale");
});

test("planAlert does not mutate its input state", () => {
  const state = { status: "ok", notOkTicks: 0, lastSentMs: 0, alerted: false };
  const before = JSON.stringify(state);
  planAlert(state, stale(), 61_000, REPEAT, { hostname: HOST });
  assert.equal(JSON.stringify(state), before);
});

test("postWebhook posts JSON and returns true on ok", async () => {
  let recorded;
  const fetchImpl = async (url, init) => {
    recorded = { url, init };
    return { ok: true, status: 200 };
  };
  const result = await postWebhook("https://hooks.example/T/B/X", "hello", { fetchImpl });
  assert.equal(result, true);
  assert.equal(recorded.init.method, "POST");
  assert.equal(recorded.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(recorded.init.body), { text: "hello" });
});

test("postWebhook returns false on a non-ok response and never logs the URL or token", async () => {
  const URL_WITH_TOKEN = "https://hooks.example/T/B/SUPERSECRETTOKEN";
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const { value, lines } = await captureWarn(() => postWebhook(URL_WITH_TOKEN, "hello", { fetchImpl }));
  assert.equal(value, false);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "alert webhook failed: 500");
  assert.ok(!lines[0].includes("SUPERSECRETTOKEN"));
  assert.ok(!lines[0].includes(URL_WITH_TOKEN));
});

test("postWebhook returns false and logs the error name on a rejecting fetch", async () => {
  const fetchImpl = () => Promise.reject(Object.assign(new Error("boom"), { name: "TypeError" }));
  const { value, lines } = await captureWarn(() => postWebhook("https://hooks.example/T/B/X", "hello", { fetchImpl }));
  assert.equal(value, false);
  assert.equal(lines[0], "alert webhook failed: TypeError");
});

test("postWebhook aborts on timeout and logs AbortError", async () => {
  const slowFetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
      );
    });
  const { value, lines } = await captureWarn(() =>
    postWebhook("https://hooks.example/T/B/X", "hello", { fetchImpl: slowFetch, timeoutMs: 5 })
  );
  assert.equal(value, false);
  assert.equal(lines[0], "alert webhook failed: AbortError");
});

test("startAlertLoop debounces the first tick and pages on the second", async () => {
  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body).text);
    return { ok: true, status: 200 };
  };
  const loop = startAlertLoop({
    url: "https://hooks.example/T/B/X",
    getSnapshot: () => Promise.resolve(stale()),
    now: () => 0,
    intervalMs: 60_000,
    repeatMs: REPEAT,
    hostname: HOST,
    fetchImpl,
  });
  await loop.tick();
  assert.equal(sent.length, 0, "one tick must not page");
  await loop.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^\[ccdash\] telemetry STALE on dashboard-7c9f/);
  loop.stop();
});
