import { test } from "node:test";
import assert from "node:assert/strict";
import { rollupAdoption } from "./activity.js";

test("rollupAdoption computes dau/wau/mau/stickiness per day from day-user rows", () => {
  const rows = [
    { d: "2026-07-01", users: ["a@x.com", "b@x.com"] },
    { d: "2026-07-02", users: ["a@x.com"] },
    { d: "2026-07-03", users: ["c@x.com"] },
  ];
  const from = new Date("2026-07-01T00:00:00Z");
  const to = new Date("2026-07-04T00:00:00Z");
  const out = rollupAdoption(rows, from, to);

  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => r.t), ["2026-07-01", "2026-07-02", "2026-07-03"]);
  assert.equal(out[0].dau, 2);
  assert.equal(out[0].wau, 2);
  assert.equal(out[0].mau, 2);
  assert.equal(out[0].stickiness, 100);
  assert.equal(out[1].dau, 1);
  assert.equal(out[1].wau, 2);
  assert.equal(out[1].mau, 2);
  assert.equal(out[1].stickiness, 50);
  assert.equal(out[2].dau, 1);
  assert.equal(out[2].wau, 3);
  assert.equal(out[2].mau, 3);
  // 33.3은 리터럴로 안전하다: Number(((1/3)*100).toFixed(1)) === 33.3이 이 런타임에서 true다.
  assert.equal(out[2].stickiness, 33.3);
});

test("rollupAdoption zero-fills days with no activity", () => {
  const out = rollupAdoption([], new Date("2026-07-01T00:00:00Z"), new Date("2026-07-02T00:00:00Z"));
  assert.deepEqual(out, [{ t: "2026-07-01", dau: 0, wau: 0, mau: 0, stickiness: 0 }]);
});

test("rollupAdoption skips the partial calendar day when from is mid-day", () => {
  // from이 자정이 아니면(예: 07-01 정오) 그날의 절반은 요청 range 밖 — 첫 point는 다음
  // 자정(07-02)부터지만, a의 07-01 활동은 union 윈도우 계산에는 여전히 걸려 wau/mau에는
  // 반영된다(dau만 그날의 값 자체가 빠진다) — 그래서 wau/mau는 2이지 1이 아니다.
  const rows = [
    { d: "2026-07-01", users: ["a@x.com"] },
    { d: "2026-07-02", users: ["b@x.com"] },
  ];
  const from = new Date("2026-07-01T12:00:00Z");
  const to = new Date("2026-07-03T00:00:00Z");
  const out = rollupAdoption(rows, from, to);
  assert.deepEqual(out.map((r) => r.t), ["2026-07-02"]);
  assert.equal(out[0].dau, 1);
  assert.equal(out[0].wau, 2);
  assert.equal(out[0].mau, 2);
  assert.equal(out[0].stickiness, 50);
});

test("rollupAdoption counts a user active 29 days ago in mau today but not tomorrow", () => {
  // union(30)은 i=0..29를 돌아 당일 포함 정확히 29일 전까지 닿는다 — day+1부터는 안 닿는다.
  const rows = [
    { d: "2026-07-01", users: ["old@x.com"] },
    { d: "2026-07-30", users: ["new@x.com"] },
    { d: "2026-07-31", users: ["new@x.com"] },
  ];
  const from = new Date("2026-07-30T00:00:00Z");
  const to = new Date("2026-08-01T00:00:00Z");
  const out = rollupAdoption(rows, from, to);
  assert.deepEqual(out.map((r) => r.t), ["2026-07-30", "2026-07-31"]);
  assert.equal(out[0].dau, 1);
  assert.equal(out[0].wau, 1);
  assert.equal(out[0].mau, 2);
  assert.equal(out[0].stickiness, 50);
  assert.equal(out[1].dau, 1);
  assert.equal(out[1].wau, 1);
  assert.equal(out[1].mau, 1);
  assert.equal(out[1].stickiness, 100);
});
