import { test } from "node:test";
import assert from "node:assert/strict";
import { createFactorCache } from "./factorCache.js";
import { CapacityError } from "./capacity.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("equal keys share a load and cached null/zero retain their meaning", async () => {
  const cache = createFactorCache();
  const held = deferred();
  let calls = 0;
  const load = () => { calls++; return held.promise; };
  const pending = Array.from({ length: 140 }, () => cache.get("window", load));
  await tick();
  assert.equal(calls, 1);
  const value = { known: 0, unavailable: null };
  held.resolve(value);
  assert((await Promise.all(pending)).every(row => row === value));
  assert.equal(await cache.get("window", () => { throw new Error("unexpected read"); }), value);
});

test("one cancelled subscriber leaves the shared lookup available to its peer", async () => {
  const cache = createFactorCache(), held = deferred();
  const first = new AbortController(), second = new AbortController();
  let owned;
  const load = signal => { owned = signal; return held.promise; };
  const a = cache.get("window", load, first.signal);
  const b = cache.get("window", load, second.signal);
  await tick();
  first.abort();
  await assert.rejects(a, error => error === first.signal.reason);
  assert.equal(owned.aborted, false);
  held.resolve({ factors: [-1] });
  assert.deepEqual(await b, { factors: [-1] });
  assert.equal(owned.aborted, false);
});

test("last cancellation aborts owned work; a late ignored result cannot poison a replacement", async () => {
  const cache = createFactorCache(), old = deferred(), fresh = deferred();
  const first = new AbortController();
  let owned;
  const cancelled = cache.get("window", signal => { owned = signal; return old.promise; }, first.signal);
  await tick();
  first.abort();
  await assert.rejects(cancelled, error => error === first.signal.reason);
  assert.equal(owned.aborted, true);
  const replacement = cache.get("window", () => fresh.promise);
  old.resolve("stale");
  await tick();
  fresh.resolve("fresh");
  assert.equal(await replacement, "fresh");
  assert.equal(await cache.get("window", () => "unexpected"), "fresh");
});

test("pre-aborted subscriptions start no work and failures are shared without caching", async () => {
  const cache = createFactorCache(), aborted = new AbortController(), held = deferred();
  aborted.abort();
  let calls = 0;
  await assert.rejects(cache.get("window", () => { calls++; }, aborted.signal));
  assert.equal(calls, 0);
  const original = new Error("fixture SQL failure");
  const a = cache.get("window", () => held.promise), b = cache.get("window", () => held.promise);
  const assertions = [a, b].map(promise => assert.rejects(promise, error => error === original));
  held.reject(original);
  await Promise.all(assertions);
  assert.equal(await cache.get("window", () => "recovered"), "recovered");
});

test("pending admission stays bounded while equal keys still join", async () => {
  const cache = createFactorCache({ limit: 2 }), a = deferred(), b = deferred();
  const first = cache.get("a", () => a.promise), second = cache.get("b", () => b.promise);
  const peer = cache.get("a", () => { throw new Error("duplicate read"); });
  await assert.rejects(cache.get("c", () => "unexpected"), CapacityError);
  a.resolve("a"); b.resolve("b");
  assert.deepEqual(await Promise.all([first, second, peer]), ["a", "b", "a"]);
  assert.equal(await cache.get("c", () => "c"), "c");
});

test("TTL starts at completion and settled eviction preserves pending work", async () => {
  let now = 0, calls = 0;
  const cache = createFactorCache({ now: () => now, ttlMs: 60, limit: 2 }), held = deferred();
  const pending = cache.get("a", () => { calls++; return held.promise; });
  now = 100; held.resolve("a"); await pending;
  now = 159;
  assert.equal(await cache.get("a", () => { calls++; return "bad"; }), "a");
  now = 160;
  assert.equal(await cache.get("a", () => { calls++; return "renewed"; }), "renewed");
  assert.equal(calls, 2);
  const waiting = deferred(), active = cache.get("pending", () => waiting.promise);
  await cache.get("b", () => "b");
  await cache.get("c", () => "c");
  const joined = cache.get("pending", () => { throw new Error("evicted pending"); });
  waiting.resolve("finished");
  assert.deepEqual(await Promise.all([active, joined]), ["finished", "finished"]);
});

test("byte admission evicts only settled values and never truncates an oversized factor result", async () => {
  const cache = createFactorCache({ maxBytes: 12, maxEntryBytes: 8 }), held = deferred();
  const pending = cache.get("pending", () => held.promise);
  let firstReads = 0;
  await cache.get("a", () => { firstReads++; return "aaaa"; }); // Six serialized bytes.
  await cache.get("b", () => "bbbb");
  await cache.get("c", () => "cccc"); // Evict a, preserving pending.
  await cache.get("a", () => { firstReads++; return "aaaa"; });
  assert.equal(firstReads, 2);
  const peer = cache.get("pending", () => { throw new Error("pending evicted"); });
  const oversized = { keys: ["long-key"], factors: [-1] };
  held.resolve(oversized);
  assert.equal(await pending, oversized);
  assert.equal(await peer, oversized);
  let reread = 0;
  assert.deepEqual(await cache.get("pending", () => { reread++; return oversized; }), oversized);
  assert.equal(reread, 1);
});
