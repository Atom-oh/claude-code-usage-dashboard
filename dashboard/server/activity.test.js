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
