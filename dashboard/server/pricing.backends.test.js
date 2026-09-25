// Same reason as pricing.ttl5m.test.js: needs a fresh module instance per import.
import { test } from "node:test";
import assert from "node:assert/strict";

test("priceFor/computeCost apply a model's backend override only for that backend", async () => {
  process.env.PRICING_JSON = JSON.stringify({
    "claude-fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25,
      backends: { "bedrock-mantle": { output: 60 } } },
  });
  delete process.env.PRICING_CACHE_WRITE_TTL;
  const m = await import("./pricing.js?backends=override");

  const mantle = m.priceFor("global.anthropic.claude-fable-5-1", "bedrock-mantle");
  assert.equal(mantle.output, 60);
  assert.equal(mantle.input, 10);

  const runtime = m.priceFor("global.anthropic.claude-fable-5-1", "bedrock-runtime");
  assert.equal(runtime.output, 50);

  const base = m.priceFor("claude-fable-5-1");
  assert.equal(base.output, 50);

  assert.equal(
    m.computeCost("global.anthropic.claude-fable-5-1", "bedrock-mantle",
      { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }),
    60,
  );
  assert.equal(
    m.computeCost("global.anthropic.claude-fable-5-1", "bedrock-runtime",
      { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }),
    50,
  );
});

test("computeCost returns null for a model absent from the table, at any backend", async () => {
  delete process.env.PRICING_JSON;
  delete process.env.PRICING_CACHE_WRITE_TTL;
  const m = await import("./pricing.js?backends=nomodel");
  assert.equal(m.computeCost("openai.gpt-6-astra", "bedrock-mantle", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(m.computeCost("openai.gpt-6-astra", undefined, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
});

test("resolvedRatesTable resolves every model's backend rates through priceFor itself", async () => {
  process.env.PRICING_JSON = JSON.stringify({
    "claude-fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25,
      backends: { "bedrock-mantle": { output: 60 } } },
  });
  delete process.env.PRICING_CACHE_WRITE_TTL;
  const m = await import("./pricing.js?backends=resolved");
  const table = m.resolvedRatesTable();
  const entry = table["claude-fable-5-1"];
  assert.deepEqual(entry.base, { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20 });
  assert.deepEqual(entry.backends["bedrock-mantle"], { input: 10, output: 60, cacheRead: 0.25, cacheWrite: 20 });
  assert.deepEqual(entry.backends["bedrock-runtime"], entry.base);
  const sonnet = table["claude-sonnet-5"];
  assert.deepEqual(sonnet.backends["bedrock-mantle"], sonnet.base);
  assert.deepEqual(sonnet.backends["bedrock-runtime"], sonnet.base);
});
