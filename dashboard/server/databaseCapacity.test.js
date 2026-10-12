import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { CapacityError } from "./capacity.js";

test("actual database helpers bound queries through JSON consumption and keep pings separate",
  { timeout: 10000 }, async () => {
    const events = new EventEmitter();
    const queries = [], pings = [];
    let hold = true;
    const server = createServer((req, res) => {
      req.resume();
      if (!hold) return res.end('{"value":1}\n');
      const target = req.url.startsWith("/ping") ? pings : queries;
      target.push(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write(target === pings ? "Ok." : '{"value":1}\n');
      events.emit("request");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const previous = Object.fromEntries(["CH_URL", "CH_USER", "CH_PASSWORD"].map(key => [key, process.env[key]]));
    process.env.CH_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.CH_USER = "synthetic-fixture";
    process.env.CH_PASSWORD = "";
    let pending = [];
    try {
      const database = await import("./clickhouse.js?capacity-fixture");
      // Invalid setup must release the query slot without reaching the fixture.
      for (let i = 0; i < 30; i++)
        await assert.rejects(database.queryReadonly("SELECT 1", {}), TypeError);
      pending = Array.from({ length: 24 }, () => database.query("SELECT 1"));
      const all = Promise.all(pending);
      all.catch(() => {});
      await assert.rejects(database.query("SELECT 1"), CapacityError);
      await assert.rejects(database.queryReadonly("SELECT 1"), CapacityError);
      while (queries.length < 24) await once(events, "request", { signal: AbortSignal.timeout(5000) });
      // Headers and a whole JSON row have arrived, but the response is not consumed.
      await assert.rejects(database.query("SELECT 1"), CapacityError);
      const probes = Array.from({ length: 4 }, () => database.ping());
      const allProbes = Promise.all(probes);
      allProbes.catch(() => {});
      pending.push(...probes);
      await assert.rejects(database.ping(), CapacityError);
      while (pings.length < 4) await once(events, "request", { signal: AbortSignal.timeout(5000) });
      for (const res of [...queries, ...pings]) res.end();
      assert.deepEqual(await all, Array.from({ length: 24 }, () => [{ value: 1 }]));
      assert.deepEqual(await allProbes, [true, true, true, true]);
      hold = false;
      assert.deepEqual(await database.query("SELECT 1"), [{ value: 1 }]);
      assert.equal(await database.ping(), true);
    } finally {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      for (const res of [...queries, ...pings]) if (!res.writableEnded) res.end();
      server.closeAllConnections();
      await Promise.allSettled(pending);
      await new Promise(resolve => server.close(resolve));
    }
  });
