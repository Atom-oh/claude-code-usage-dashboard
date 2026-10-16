import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { createResultCache } from "./capacity.js";
import { createFactorCache } from "./factorCache.js";
import { createQueryDeadline, QueryDeadlineError, querySignal } from "./queryContext.js";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const untilAborted = signal => new Promise((_, reject) => {
  if (signal.aborted) return reject(signal.reason);
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

test("one deadline belongs to a shared key and timeout results are never cached", async () => {
  const cache = createResultCache({ maxEntries: 1, maxPending: 1, loadMs: 30 });
  let started = 0;
  const first = cache.get("same", signal => { started++; return untilAborted(signal); }, 1000);
  const second = cache.get("same", () => assert.fail("duplicate loader"), 1000);
  assert.equal(first, second);
  const alive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(first, QueryDeadlineError);
    await assert.rejects(second, QueryDeadlineError);
  } finally { clearTimeout(alive); }
  assert.equal(started, 1);
  assert.equal(cache.pending, 0);
  assert.equal(cache.size, 0);
  assert.deepEqual(await cache.get("same", () => ({ cost_usd: null }), 1000), { cost_usd: null });
});

test("deadline includes cache admission and never releases an ignored active load early", async () => {
  const cache = createResultCache({ maxEntries: 2, maxPending: 1, maxWaiting: 1,
    waitMs: 1000, loadMs: 30 });
  const held = deferred();
  const first = cache.get("active", () => held.promise, 1000);
  let nextStarted = false;
  const next = cache.get("waiting", () => { nextStarted = true; return 0; }, 1000);
  const firstRejected = assert.rejects(first, QueryDeadlineError);
  const nextRejected = assert.rejects(next, QueryDeadlineError);
  await delay(60);
  await nextRejected;
  assert.equal(nextStarted, false);
  assert.equal(cache.waiting, 0);
  assert.equal(cache.pending, 1); // Still accounted while the loader ignores abort.
  held.resolve(0);
  await firstRejected;
  assert.equal(cache.pending, 0);
  assert.equal(cache.size, 0);
});

test("deadline context combines sibling cancellation and remains isolated between producers", async () => {
  const a = createQueryDeadline(1000), b = createQueryDeadline(1000);
  const external = new AbortController();
  try {
    let aSignal, bSignal;
    await Promise.all([
      a.run(async () => { await delay(1); aSignal = querySignal(external.signal); }),
      b.run(async () => { await delay(1); bSignal = querySignal(); }),
    ]);
    const reason = new Error("synthetic sibling failure");
    external.abort(reason);
    assert.equal(aSignal.reason, reason);
    assert.equal(bSignal.aborted, false);
    assert.equal(querySignal(), undefined);
  } finally { a.dispose(); b.dispose(); }
});

test("sequential work keeps the original shared deadline rather than starting a new one", async () => {
  const cache = createResultCache({ loadMs: 60 });
  const alive = setTimeout(() => {}, 1000);
  let remainingStageStarted = false;
  const start = performance.now();
  try {
    await assert.rejects(cache.get("sequential", async () => {
      await delay(35);
      remainingStageStarted = true;
      return untilAborted(querySignal());
    }, 1000), QueryDeadlineError);
    assert.equal(remainingStageStarted, true);
    assert.ok(performance.now() - start < 500);
    assert.equal(cache.pending, 0);
  } finally { clearTimeout(alive); }
});

test("synchronous overrun is rejected before cache admission even before the timer fires", async () => {
  const cache = createResultCache({ maxEntries: 1, maxPending: 1, loadMs: 10 });
  await assert.rejects(cache.get("blocked-event-loop", () => {
    const end = performance.now() + 25;
    while (performance.now() < end) { /* Deliberately block the synthetic loader. */ }
    return { observed_tokens: 0 };
  }, 1000), QueryDeadlineError);
  assert.equal(cache.size, 0);
  assert.equal(cache.pending, 0);
});

test("deadline configuration rejects invalid and overflowing timer values", () => {
  for (const loadMs of [-1, NaN, Infinity, 0.5, 2_147_483_648])
    assert.throws(() => createResultCache({ loadMs }), RangeError);
  for (const milliseconds of [0, -1, NaN, Infinity, 0.5, 2_147_483_648])
    assert.throws(() => createQueryDeadline(milliseconds), RangeError);
});

test("actual HTTP queries cancel on a shared deadline while peer factor subscribers survive",
  { timeout: 10000 }, async t => {
    const events = new EventEmitter();
    const responses = [];
    let hold = true, received = 0, prematurelyClosed = 0;
    const server = createServer((req, res) => {
      req.resume();
      received++;
      if (!hold) return res.end('{"value":1}\n');
      responses.push(res);
      res.on("close", () => { if (!res.writableEnded) prematurelyClosed++; });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"value":1}\n');
      events.emit("request");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const previous = Object.fromEntries(["CH_URL", "CH_USER", "CH_PASSWORD"]
      .map(key => [key, process.env[key]]));
    process.env.CH_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.CH_USER = "synthetic-deadline-fixture";
    process.env.CH_PASSWORD = "";
    const pending = [];
    try {
      const database = await import("./clickhouse.js?deadline-fixture");
      await t.test("deadline aborts HTTP response consumption and releases DB slots", async () => {
        const cache = createResultCache({ loadMs: 150 });
        const first = cache.get("held", () => database.query("SELECT 1"), 1000);
        const second = cache.get("held", () => assert.fail("duplicate query"), 1000);
        pending.push(first, second);
        const a = assert.rejects(first, QueryDeadlineError);
        const b = assert.rejects(second, QueryDeadlineError);
        while (received < 1)
          await once(events, "request", { signal: AbortSignal.timeout(2000) });
        await Promise.all([a, b]);
        await delay(25);
        assert.equal(prematurelyClosed, 1);
        assert.equal(cache.size, 0);
        assert.equal(cache.pending, 0);
        hold = false;
        assert.deepEqual(await database.query("SELECT 1"), [{ value: 1 }]);
      });
      await t.test("owned deadline also closes readonly SQL bodies after headers", async () => {
        hold = true;
        const before = received, closedBefore = prematurelyClosed;
        const cache = createResultCache({ loadMs: 150 });
        const result = cache.get("readonly-body", () => database.queryReadonly("SELECT 1"), 1000);
        pending.push(result);
        const rejected = assert.rejects(result, QueryDeadlineError);
        while (received < before + 1)
          await once(events, "request", { signal: AbortSignal.timeout(2000) });
        await rejected;
        await delay(25);
        assert.equal(prematurelyClosed, closedBefore + 1);
        assert.equal(cache.size, 0);
        assert.equal(cache.pending, 0);
        hold = false;
        assert.deepEqual(await database.queryReadonly("SELECT 1"),
          { rows: [{ value: 1 }], truncated: false });
      });
      await t.test("expired first producer cannot cancel a peer's shared factor HTTP request", async () => {
        hold = true;
        const before = received, closedBefore = prematurelyClosed;
        const factor = createFactorCache();
        const firstCache = createResultCache({ loadMs: 150 });
        const peerCache = createResultCache({ loadMs: 2000 });
        const load = () => factor.get("shared-factor",
          signal => database.query("SELECT 1 -- factor", {}, signal));
        const first = firstCache.get("first", load, 1000);
        const peer = peerCache.get("peer", load, 1000);
        pending.push(first, peer);
        peer.catch(() => {});
        const rejected = assert.rejects(first, QueryDeadlineError);
        while (received < before + 1)
          await once(events, "request", { signal: AbortSignal.timeout(2000) });
        await rejected;
        assert.equal(received, before + 1);
        assert.equal(prematurelyClosed, closedBefore);
        hold = false;
        for (const res of responses) if (!res.writableEnded) res.end();
        assert.deepEqual(await peer, [{ value: 1 }]);
        assert.equal(peerCache.pending, 0);
      });
    } finally {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      for (const res of responses) if (!res.writableEnded) res.end();
      server.closeAllConnections();
      await Promise.allSettled(pending);
      await new Promise(resolve => server.close(resolve));
    }
  });
