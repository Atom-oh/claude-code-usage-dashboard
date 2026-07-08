import { test } from "node:test";
import assert from "node:assert/strict";
import { rollupActiveUsers } from "./activity.js";

test("rollupActiveUsers computes dau/wau/mau per day from raw day-user pairs", () => {
  const rows = [
    { day: "2026-07-01", UserEmail: "a@x.com" },
    { day: "2026-07-01", UserEmail: "b@x.com" },
    { day: "2026-07-02", UserEmail: "a@x.com" },
    { day: "2026-07-03", UserEmail: "c@x.com" },
  ];
  const from = new Date("2026-07-01T00:00:00Z");
  const to = new Date("2026-07-04T00:00:00Z");
  const out = rollupActiveUsers(rows, from, to);

  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => r.t), ["2026-07-01", "2026-07-02", "2026-07-03"]);
  assert.equal(out[0].dau, 2); // a,b
  assert.equal(out[1].dau, 1); // a
  assert.equal(out[1].wau, 2); // a,b within trailing 7d
  assert.equal(out[2].dau, 1); // c
  assert.equal(out[2].wau, 3); // a,b,c within trailing 7d
  assert.equal(out[2].mau, 3); // within trailing 30d
});

test("rollupActiveUsers returns zeroed days when no activity exists", () => {
  const out = rollupActiveUsers([], new Date("2026-07-01T00:00:00Z"), new Date("2026-07-02T00:00:00Z"));
  assert.deepEqual(out, [{ t: "2026-07-01", dau: 0, wau: 0, mau: 0 }]);
});

test("rollupActiveUsers skips the partial calendar day when from is mid-day", () => {
  // from이 자정이 아니면(예: 07-01 정오) 그날의 절반은 요청 range 밖 — 다른 시계열 차트처럼
  // 그 부분 day는 버리고 다음 자정(07-02)부터 시작해야 한다.
  const rows = [
    { day: "2026-07-01", UserEmail: "a@x.com" },
    { day: "2026-07-02", UserEmail: "b@x.com" },
  ];
  const from = new Date("2026-07-01T12:00:00Z");
  const to = new Date("2026-07-03T00:00:00Z");
  const out = rollupActiveUsers(rows, from, to);
  assert.deepEqual(out.map((r) => r.t), ["2026-07-02"]);
  assert.equal(out[0].dau, 1); // b — a's 07-01 activity is outside [from, to)
});
