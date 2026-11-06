import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createHealthProbe } from "./health.js";

test("health requests return immediately while sharing one background ping", async t => {
  let now = 0, calls = 0, finish;
  const probe = createHealthProbe(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, { now: () => now });
  t.after(probe.stop);
  assert.deepEqual(await Promise.all(Array.from({ length: 100 }, () => probe())), Array(100).fill(false));
  await Promise.resolve();
  assert.equal(calls, 1);
  finish(true);
  await nextTurn();
  assert.equal(await probe(), true);
  now = 1001;
  assert.equal(await probe(), true);
  await Promise.resolve();
  assert.equal(calls, 2);
  now = 15001;
  assert.equal(await probe(), false); // A slow refresh cannot keep a pod ready forever.
  finish(false);
  await nextTurn();
  assert.equal(await probe(), false);
});

test("failed probes remain unavailable and are briefly cached", async t => {
  let calls = 0;
  const probe = createHealthProbe(async () => { calls++; throw new Error("database unavailable"); });
  t.after(probe.stop);
  assert.equal(await probe(), false);
  await nextTurn();
  assert.equal(await probe(), false);
  assert.equal(calls, 1);
});

test("a healthy result survives the normal ten-second Kubernetes probe interval", async t => {
  let now = 0, calls = 0;
  const probe = createHealthProbe(async () => { calls++; return true; }, { now: () => now });
  t.after(probe.stop);
  assert.equal(probe(), false);
  await nextTurn();
  now = 10_000;
  assert.equal(probe(), true);
  await nextTurn();
  now = 20_000;
  assert.equal(probe(), true);
  assert.equal(calls, 2);
});

test("background refresh keeps Docker's thirty-second health check current", async t => {
  let now = 0, tick, calls = 0, cancelled = false;
  const probe = createHealthProbe(async () => { calls++; return true; }, {
    now: () => now,
    schedule: callback => { tick = callback; return { unref() {} }; },
    cancel: () => { cancelled = true; },
  });
  t.after(() => probe.stop());
  await nextTurn();
  for (now = 1000; now <= 30_000; now += 1000) { tick(); await nextTurn(); }
  assert.equal(probe(), true);
  assert.equal(calls, 31);
  probe.stop();
  assert.equal(cancelled, true);
});
