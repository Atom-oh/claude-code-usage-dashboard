import { test } from "node:test";
import assert from "node:assert/strict";
import { clientQueryBatch } from "./clientQueryBatch.js";
import { CapacityError } from "./capacity.js";

test("successful private overview queries preserve values and ordering", async () => {
  const rows = await clientQueryBatch([
    async signal => { assert.equal(signal.aborted, false); return [1]; },
    async signal => { assert.equal(signal.aborted, false); return [2]; },
  ]);
  assert.deepEqual(rows, [[1], [2]]);
});

test("capacity failure cancels queued siblings and retains the original classification", async () => {
  const original = new CapacityError();
  let cancelled = false;
  await assert.rejects(clientQueryBatch([
    async () => { throw original; },
    signal => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
    }),
  ]), error => error === original);
  assert.equal(cancelled, true);
});

test("transport and SQL errors do not become empty telemetry or capacity errors", async () => {
  const original = Object.assign(new Error("fixture transport"), { code: "47" });
  await assert.rejects(clientQueryBatch([() => { throw original; }, async () => []]),
    error => error === original);
});
