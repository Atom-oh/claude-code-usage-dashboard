import { test } from "node:test";
import assert from "node:assert/strict";
import { CapacityError, createResultCache } from "./capacity.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test("140 distinct views can wait without increasing the 64 active loads per process", async () => {
  const caches = [createResultCache({ maxWaiting: 64 }), createResultCache({ maxWaiting: 64 })];
  const boundary = deferred();
  let started = 0;
  const active = [0, 0], peak = [0, 0];
  const requests = Array.from({ length: 140 }, (_, i) => {
    const process = i % 2;
    return caches[process].get(`user:${i}`, async () => {
      started++;
      peak[process] = Math.max(peak[process], ++active[process]);
      try {
        await boundary.promise;
        return { user: i, cost_usd: i % 2 ? null : 0.000001, cost_partial: i % 2 === 1 };
      } finally { active[process]--; }
    }, 10_000);
  });
  await tick();
  assert.equal(started, 128);
  assert.deepEqual(caches.map(cache => cache.pending), [64, 64]);
  assert.deepEqual(caches.map(cache => cache.waiting), [6, 6]);
  boundary.resolve();
  const results = await Promise.all(requests);
  assert.deepEqual(results, Array.from({ length: 140 }, (_, i) =>
    ({ user: i, cost_usd: i % 2 ? null : 0.000001, cost_partial: i % 2 === 1 })));
  assert.equal(started, 140);
  assert.deepEqual(peak, [64, 64]);
  assert.deepEqual(caches.map(cache => [cache.pending, cache.waiting]), [[0, 0], [0, 0]]);
});

test("queued keys share one promise, cannot expire, and receive TTL only after completion", async () => {
  let now = 0, started = 0;
  const cache = createResultCache({ maxEntries: 2, maxPending: 1, maxWaiting: 1, now: () => now });
  const first = deferred(), second = deferred();
  const one = cache.get("one", () => first.promise, 10);
  const two = cache.get("two", () => { started++; return second.promise; }, 10);
  await tick();
  now = 1000;
  cache.sweep();
  assert.equal(cache.get("two", () => { throw new Error("must share"); }, 10), two);
  assert.equal(cache.size, 2);
  assert.equal(cache.waiting, 1);
  assert.equal(started, 0);
  first.resolve(1);
  await one;
  await tick();
  assert.equal(started, 1);
  second.resolve(2);
  assert.equal(await two, 2);
  now = 1009;
  assert.equal(await cache.get("two", () => 99, 10), 2);
  now = 1010;
  assert.equal(await cache.get("two", () => 3, 10), 3);
});

test("full waiting admission rejects bounded work and removes its failed key", async () => {
  const cache = createResultCache({ maxEntries: 2, maxPending: 1, maxWaiting: 1 });
  const blocked = deferred();
  const first = cache.get("one", () => blocked.promise, 10);
  const second = cache.get("two", () => 2, 10);
  let deniedStarted = false;
  for (let i = 0; i < 1000; i++)
    assert.throws(() => cache.get(`denied:${i}`, () => { deniedStarted = true; }, 10), CapacityError);
  assert.equal(deniedStarted, false);
  assert.equal(cache.size, 2);
  assert.equal(cache.pending, 1);
  assert.equal(cache.waiting, 1);
  blocked.resolve(1);
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.equal(await cache.get("denied", () => 3, 10), 3);
});

test("a waiting timeout does not start a loader, cache a zero, or leak admission", async () => {
  const cache = createResultCache({ maxEntries: 2, maxPending: 1, maxWaiting: 1, waitMs: 5 });
  const blocked = deferred();
  const first = cache.get("one", () => blocked.promise, 10);
  let started = 0;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(cache.get("two", () => { started++; return 0; }, 10), CapacityError);
  } finally { clearTimeout(keepAlive); }
  assert.equal(started, 0);
  assert.equal(cache.size, 1);
  assert.equal(cache.pending, 1);
  assert.equal(cache.waiting, 0);
  blocked.resolve(1);
  await first;
  assert.equal(await cache.get("two", () => { started++; return 0; }, 10), 0);
  assert.equal(started, 1);
  assert.equal(cache.pending, 0);
});

test("a failed load retains its error and hands its slot to the next distinct key", async () => {
  const cache = createResultCache({ maxEntries: 2, maxPending: 1, maxWaiting: 1 });
  const first = deferred();
  const original = new Error("synthetic SQL failure");
  const failed = cache.get("one", () => first.promise, 10);
  const next = cache.get("two", () => ({ cost_usd: null }), 10);
  const rejection = assert.rejects(failed, error => error === original);
  first.reject(original);
  await rejection;
  assert.deepEqual(await next, { cost_usd: null });
  assert.equal(cache.size, 1);
  assert.equal(cache.pending, 0);
  assert.equal(cache.waiting, 0);
  assert.equal(await cache.get("one", () => 1, 10), 1);
});

test("queued results retain serialized byte quotas and oversized result bypass", async () => {
  const cache = createResultCache({ maxEntries: 2, maxPending: 1, maxWaiting: 1,
    maxBytes: 10, maxEntryBytes: 8 });
  const first = deferred();
  const one = cache.get("one", () => first.promise, 10_000);
  const large = cache.get("large", () => "longer than quota", 10_000);
  first.resolve("한");
  assert.deepEqual(await Promise.all([one, large]), ["한", "longer than quota"]);
  assert.equal(cache.bytes, 5);
  assert.equal(cache.size, 1);
  assert.equal(cache.pending, 0);
  assert.equal(cache.waiting, 0);
});

test("cache configuration accommodates active and queued keys and rejects invalid bounds", () => {
  assert.throws(() => createResultCache({ maxEntries: 2, maxPending: 2, maxWaiting: 1 }), RangeError);
  for (const maxWaiting of [-1, 0.5, NaN, Infinity])
    assert.throws(() => createResultCache({ maxWaiting }), RangeError);
  for (const waitMs of [0, -1, 0.5, NaN])
    assert.throws(() => createResultCache({ waitMs }), RangeError);
});
