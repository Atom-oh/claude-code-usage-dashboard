import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { clientQueryBatch } from "./clientQueryBatch.js";
import { CapacityError } from "./capacity.js";

async function within(promise, milliseconds = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("pending Claude query did not cancel")), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

test("private batch abort reaches Claude factor and counter HTTP queries",
  { timeout: 10000 }, async t => {
    let stage, hold, held, cancelled, factorRequests = 0, counterRequests = 0;
    const responses = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const sql = Buffer.concat(chunks).toString();
      const factor = sql.includes("SELECT SessionId AS session");
      if (factor) factorRequests++; else counterRequests++;
      if (!hold || (stage === "counter" && factor)) return res.end("");
      assert.equal(factor, stage === "factor");
      responses.push(res);
      res.on("close", () => { if (!res.writableEnded) cancelled(); });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{}\n"); // Hold the body open through JSON consumption.
      held();
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const previous = Object.fromEntries(["CH_URL", "CH_USER", "CH_PASSWORD"]
      .map(key => [key, process.env[key]]));
    process.env.CH_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.CH_USER = "synthetic-cancellation-fixture";
    process.env.CH_PASSWORD = "";
    try {
      const { clientClaudeRows } = await import("./queries.js?cancellation-fixture");
      const { clearNonAnthropicFactorCache } = await import("./nonAnthropicCost.js");
      for (stage of ["factor", "counter"]) {
        await t.test(`cancel pending ${stage} query and retain the sibling capacity error`, async () => {
          clearNonAnthropicFactorCache();
          hold = true;
          const received = new Promise(resolve => { held = resolve; });
          const closed = new Promise(resolve => { cancelled = resolve; });
          const original = new CapacityError();
          const batch = clientQueryBatch([
            signal => clientClaudeRows(new Date("2026-09-14"), new Date("2026-09-15"), {}, 600, signal),
            async () => { await received; throw original; },
          ]);
          // Attach immediately so the original failure cannot become unhandled.
          const rejected = assert.rejects(batch, error => error === original);
          try {
            await within(rejected);
            await within(closed);
          } finally {
            hold = false;
            for (const res of responses) if (!res.writableEnded) res.end();
            await batch.catch(() => {});
          }
        });
      }
      await t.test("one cancelled Claude view leaves its peer's shared factor request alive", async () => {
        clearNonAnthropicFactorCache();
        stage = "factor"; hold = true;
        factorRequests = 0; counterRequests = 0;
        const received = new Promise(resolve => { held = resolve; });
        let unexpectedClose = false;
        cancelled = () => { unexpectedClose = true; };
        const first = new AbortController(), second = new AbortController();
        const a = clientClaudeRows(new Date("2026-09-14"), new Date("2026-09-15"), {}, 600, first.signal);
        const b = clientClaudeRows(new Date("2026-09-14"), new Date("2026-09-15"), {}, 600, second.signal);
        b.catch(() => {}); // Preserve the result while observing cancellation first.
        const rejected = assert.rejects(a, error => error === first.signal.reason);
        try {
          await within(received);
          first.abort();
          await within(rejected);
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(factorRequests, 1);
          assert.equal(unexpectedClose, false);
          hold = false;
          for (const res of responses) if (!res.writableEnded) res.end();
          assert.deepEqual(await within(b), []);
          assert.equal(counterRequests, 1);
          assert.equal(unexpectedClose, false);
        } finally {
          hold = false;
          for (const res of responses) if (!res.writableEnded) res.end();
          await Promise.allSettled([a, b]);
        }
      });
    } finally {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      for (const res of responses) if (!res.writableEnded) res.end();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
