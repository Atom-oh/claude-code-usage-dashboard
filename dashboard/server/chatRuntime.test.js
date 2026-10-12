import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createChatHandler, capToolResultJson, sendConverseWithRetry } from "./chat.js";

class Response extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  chunks = [];
  writeHead(status, headers) { this.statusCode = status; this.headers = headers; }
  write(value) { this.chunks.push(value); }
  end() { this.writableEnded = true; this.emit("close"); }
}
const request = () => ({ ip: "fixture", body: { messages: [{ role: "user", content: "synthetic question" }] } });
const toolTurn = (id = "one", sql = "SELECT 1") => ({
  content: [{ toolUse: { toolUseId: id, name: "run_sql", input: { sql } } }],
  stopReason: "tool_use", truncatedToolIds: new Set(),
});
const done = { content: [{ text: "done" }], stopReason: "end_turn", truncatedToolIds: new Set() };
const configuration = { limit: () => false };

test("active tool path bounds JSON context and preserves masking configuration", async () => {
  for (const mask of [true, false]) {
    let turns = 0;
    const response = new Response();
    const rows = Array.from({ length: 30 }, (_, i) => ({ user: "fixture@example.invalid", i, value: "x".repeat(1500) }));
    const handler = createChatHandler({ ...configuration, mask,
      query: async (_sql, signal) => {
        assert.ok(signal instanceof AbortSignal);
        return { rows, truncated: false };
      },
      runTurn: async ({ messages }) => {
        if (!turns++) return toolTurn();
        const result = messages.at(-1).content[0].toolResult.content[0].json;
        assert.ok(JSON.stringify(result).length <= 20000);
        assert.equal(result.truncated, true);
        assert.ok(result.rows.length > 0 && result.rows.length < rows.length);
        assert.equal(result.rows[0].user, mask ? "fi******@example.invalid" : "fixture@example.invalid");
        return done;
      },
    });
    await handler(request(), response);
    assert.equal(turns, 2);
    assert.ok(response.chunks.some(chunk => chunk.startsWith("event: done")));
    assert.equal(response.listenerCount("close"), 0);
  }
});

test("a single oversized row becomes a truthful empty truncated result", () => {
  assert.deepEqual(capToolResultJson([{ value: "x".repeat(25000) }], false, false), { rows: [], truncated: true });
});

test("disconnect aborts active SQL and prevents every later model/tool call", async () => {
  let calls = 0;
  let queries = 0;
  let signal;
  const response = new Response();
  const handler = createChatHandler({ ...configuration,
    runTurn: async () => { calls++; return toolTurn(); },
    query: (_sql, active) => {
      queries++; signal = active;
      return new Promise((_resolve, reject) => {
        active.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        response.destroyed = true;
        response.emit("close");
      });
    },
  });
  await handler(request(), response);
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(queries, 1);
  assert.ok(!response.chunks.some(chunk => /event: (done|error)/.test(chunk)));
  assert.equal(response.listenerCount("close"), 0);
});

test("turn deadline aborts model work and reports timeout instead of success", async () => {
  const response = new Response();
  let signal;
  const handler = createChatHandler({ ...configuration, timeoutMs: 10,
    runTurn: ({ abortSignal }) => {
      signal = abortSignal;
      return new Promise((_resolve, reject) => abortSignal.addEventListener("abort",
        () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    },
  });
  const keepAlive = setTimeout(() => {}, 200);
  try { await handler(request(), response); } finally { clearTimeout(keepAlive); }
  assert.equal(signal.aborted, true);
  assert.ok(response.chunks.some(chunk => chunk.startsWith("event: error") && chunk.includes("초과")));
  assert.ok(!response.chunks.some(chunk => chunk.startsWith("event: done")));
  assert.equal(response.writableEnded, true);
  assert.equal(response.listenerCount("close"), 0);
});

test("SQL validation still blocks unsafe statements before execution", async () => {
  let turns = 0;
  let queries = 0;
  const response = new Response();
  await createChatHandler({ ...configuration,
    query: async () => { queries++; throw new Error("must not execute"); },
    runTurn: async ({ messages }) => {
      if (!turns++) return toolTurn("unsafe", "DROP TABLE otel_logs");
      assert.equal(messages.at(-1).content[0].toolResult.status, "error");
      return done;
    },
  })(request(), response);
  assert.equal(queries, 0);
  assert.equal(turns, 2);
});

test("existing hop and SQL budgets remain bounded independently", async () => {
  let turns = 0;
  let queries = 0;
  const toolsAllowed = [];
  await createChatHandler({ ...configuration,
    query: async () => { queries++; return { rows: [], truncated: false }; },
    runTurn: async ({ allowTools }) => {
      toolsAllowed.push(allowTools); turns++;
      if (!allowTools) return done;
      return { ...toolTurn(), content: Array.from({ length: 3 }, (_, i) => toolTurn(`${turns}-${i}`).content[0]) };
    },
  })(request(), new Response());
  assert.equal(turns, 5);
  assert.equal(queries, 8);
  assert.deepEqual(toolsAllowed, [true, true, true, true, false]);
});

test("malformed history makes no model/query call", async () => {
  for (const messages of [{}, null, [null, { role: "system", content: "ignored" }]]) {
    let calls = 0;
    const response = new Response();
    await createChatHandler({ ...configuration, runTurn: async () => { calls++; return done; } })(
      { ip: "fixture", body: { messages } }, response);
    assert.equal(calls, 0);
    assert.ok(response.chunks.some(chunk => chunk.startsWith("event: error")));
  }
});

test("aborting a throttle retry cancels the wait without another SDK invocation", async () => {
  let calls = 0;
  const abort = new AbortController();
  const sdk = { send: async () => {
    calls++;
    throw Object.assign(new Error("synthetic throttle"), { name: "ThrottlingException" });
  } };
  const pending = sendConverseWithRetry({}, abort.signal, sdk);
  const timer = setTimeout(() => abort.abort(), 5);
  try { await assert.rejects(pending, error => error.name === "AbortError"); }
  finally { clearTimeout(timer); }
  assert.equal(calls, 1);
  await assert.rejects(sendConverseWithRetry({}, abort.signal, sdk), error => error.name === "AbortError");
  assert.equal(calls, 1);
});
