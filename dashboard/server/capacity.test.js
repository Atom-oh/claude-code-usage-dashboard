import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CapacityError, createBudget, createRequestAdmission, createResultCache, createSlidingLimiter } from "./capacity.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("budgets reject excess work and release once", () => {
  const budget = createBudget(1);
  const release = budget.acquire();
  assert.throws(() => budget.acquire(), CapacityError);
  release(); release();
  assert.equal(budget.active, 0);
  budget.acquire()();
  assert.throws(() => createBudget(0), RangeError);
});

class Response extends EventEmitter {
  headers = {};
  set(name, value) { this.headers[name] = value; return this; }
  status(value) { this.statusCode = value; return this; }
  json(value) { this.body = value; return this; }
}

test("request admission sends 503 and releases on finish/close without double release", () => {
  const middleware = createRequestAdmission(1);
  const first = new Response(), second = new Response(), third = new Response();
  let admitted = 0;
  middleware({}, first, () => admitted++);
  middleware({}, second, () => admitted++);
  assert.equal(admitted, 1);
  assert.equal(second.statusCode, 503);
  assert.equal(second.headers["Retry-After"], "1");
  assert.equal(second.body.code, "capacity_exhausted");
  assert.match(second.body.error, /다시 시도/);
  first.emit("close"); first.emit("finish");
  assert.equal(first.listenerCount("finish"), 0);
  middleware({}, third, () => admitted++);
  assert.equal(admitted, 2);
  third.emit("finish");
});

test("pending cache entries stay shared past TTL and cannot be evicted to duplicate work", async () => {
  let now = 0, calls = 0;
  const cache = createResultCache({ maxEntries: 2, maxPending: 2, now: () => now });
  const waiting = deferred();
  const first = cache.get("one", () => { calls++; return waiting.promise; }, 10);
  await Promise.resolve();
  now = 1000; cache.sweep();
  assert.equal(cache.get("one", () => { throw new Error("must share"); }, 10), first);
  const second = cache.get("two", () => waiting.promise, 10);
  assert.throws(() => cache.get("three", () => waiting.promise, 10), CapacityError);
  assert.equal(cache.size, 2);
  waiting.resolve("ok");
  assert.deepEqual(await Promise.all([first, second]), ["ok", "ok"]);
  assert.equal(calls, 1);
  assert.equal(cache.pending, 0);
  now = 1009;
  assert.equal(await cache.get("one", () => "wrong", 10), "ok");
  now = 1010;
  assert.equal(await cache.get("one", () => "new", 10), "new");
});

test("cache errors are removed and synchronous throws release admission", async () => {
  const cache = createResultCache({ maxEntries: 1, maxPending: 1 });
  await assert.rejects(cache.get("one", () => { throw new Error("failure"); }, 10), /failure/);
  assert.equal(cache.size, 0);
  assert.equal(cache.pending, 0);
  assert.equal(await cache.get("one", () => "recovered", 10), "recovered");
  assert.throws(() => createResultCache({ maxEntries: 1, maxPending: 2 }), RangeError);
});

test("settled cache entries evict by insertion order and never exceed the bound", async () => {
  const cache = createResultCache({ maxEntries: 2, maxPending: 1 });
  await cache.get("one", () => 1, 10000);
  await cache.get("two", () => 2, 10000);
  assert.equal(await cache.get("one", () => 9, 10000), 1); // Reads do not change insertion order.
  await cache.get("three", () => 3, 10000);
  assert.equal(cache.size, 2);
  assert.equal(await cache.get("one", () => 9, 10000), 9);
});

test("cache serialized byte quotas evict settled results and bypass oversized entries", async () => {
  const cache = createResultCache({ maxEntries: 3, maxPending: 1, maxBytes: 10, maxEntryBytes: 8 });
  assert.equal(await cache.get("one", () => "한", 10000), "한");
  assert.equal(cache.bytes, 5); // JSON quotes plus three UTF-8 bytes.
  await cache.get("two", () => "abcd", 10000);
  assert.equal(cache.size, 1);
  assert.equal(cache.bytes, 6);
  assert.equal(await cache.get("large", () => "longer than quota", 10000), "longer than quota");
  assert.equal(cache.size, 1);
  assert.equal(cache.pending, 0);
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(cache.get("cycle", () => cycle, 10000), TypeError);
  assert.equal(cache.size, 1);
  assert.equal(cache.bytes, 6);
});

test("rate windows cap admitted hits and reject new keys without evicting live limits", () => {
  let now = 0;
  const limited = createSlidingLimiter({ maximum: 2, maxKeys: 2, windowMs: 100, now: () => now });
  assert.equal(limited("one"), false);
  assert.equal(limited("one"), false);
  for (let i = 0; i < 10000; i++) assert.equal(limited("one"), true);
  assert.equal(limited("two"), false);
  assert.equal(limited("three"), true);
  assert.equal(limited("one"), true);
  now = 100;
  assert.equal(limited("three"), false);
  assert.equal(limited("one"), false);
  assert.throws(() => createSlidingLimiter({ maxKeys: 0 }), RangeError);
});
