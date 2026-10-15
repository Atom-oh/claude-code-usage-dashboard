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

test("private batches start at most two tasks and preserve ordering through staggered completion", async () => {
  const pending = [];
  let active = 0, peak = 0;
  const result = clientQueryBatch(Array.from({ length: 4 }, (_, i) => async signal => {
    assert.equal(signal.aborted, false);
    peak = Math.max(peak, ++active);
    await new Promise(resolve => { pending[i] = resolve; });
    active--;
    return i;
  }));
  assert.equal(pending.filter(Boolean).length, 2);
  pending[1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.filter(Boolean).length, 3);
  pending[2]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.filter(Boolean).length, 4);
  pending[3](); pending[0]();
  assert.deepEqual(await result, [0, 1, 2, 3]);
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(await clientQueryBatch([]), []);
});

test("failure cancels started siblings and never starts later private tasks", async () => {
  const original = new CapacityError();
  let laterStarted = false, cancelled = false;
  await assert.rejects(clientQueryBatch([
    async () => { throw original; },
    signal => new Promise((resolve, reject) => signal.addEventListener("abort", () => {
      cancelled = true;
      reject(signal.reason);
    }, { once: true })),
    () => { laterStarted = true; return []; },
  ]), error => error === original);
  assert.equal(cancelled, true);
  assert.equal(laterStarted, false);
});
