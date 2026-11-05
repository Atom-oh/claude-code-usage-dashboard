import { test } from "node:test";
import assert from "node:assert/strict";
import { createPriceDiscovery, setPriceDiscoveryObserver } from "./pricingDiscovery.js";
import { codexInsights } from "./codexInsights.js";

const terra = { model: "openai.gpt-6.1-terra", backend: "bedrock-mantle" };

test("unknown models trigger one background refresh and successful rates suppress retries", async () => {
  let calls = 0, release;
  const prices = {};
  const hold = new Promise(resolve => { release = resolve; });
  const discovery = createPriceDiscovery({ prices, refresh: async () => {
    calls++; await hold; prices[terra.model] = {}; return { changed: 1 };
  } });
  discovery.observe([terra, terra, { ...terra, model: `global.${terra.model}`, backend: "bedrock-runtime" }]);
  discovery.observe([terra]);
  await Promise.resolve();
  assert.equal(calls, 1);
  release(); await discovery.idle();
  discovery.observe([terra]);
  assert.equal(calls, 1);
});

test("unsupported and failed lookups have bounded retry intervals and new models queue", async () => {
  let now = 0, calls = 0, scheduled;
  const discovery = createPriceDiscovery({ prices: {}, now: () => now,
    setTimer: (fn, delay) => { scheduled = { fn, delay }; return { unref() {} }; },
    refresh: async () => { calls++; if (calls === 1) throw new Error("network"); return { changed: 0 }; } });
  discovery.observe([terra]); await discovery.idle();
  discovery.observe([terra]);
  assert.equal(calls, 1);
  discovery.observe([{ model: "openai.gpt-new", backend: "bedrock-mantle" }]);
  assert.equal(scheduled.delay, 300000);
  now = 300000; scheduled.fn(); await discovery.idle();
  assert.equal(calls, 2);
  discovery.observe([{ model: "openai.gpt-new", backend: "bedrock-mantle" }]);
  assert.equal(calls, 2);
  now = 21900001;
  discovery.observe([{ model: "openai.gpt-new", backend: "bedrock-mantle" }]);
  await discovery.idle();
  assert.equal(calls, 3);
});

test("only valid unknown Bedrock non-Anthropic models trigger discovery", async () => {
  let calls = 0;
  const discovery = createPriceDiscovery({ prices: { "openai.known": {} }, refresh: async () => { calls++; return { changed: 0 }; } });
  discovery.observe([
    { model: "openai.known", backend: "bedrock-mantle" },
    { model: "openai.unknown", backend: "unknown" },
    { model: "anthropic.claude-x", backend: "bedrock-mantle" },
    { model: "../../sensitive", backend: "bedrock-mantle" },
    { model: "us-gov.openai.unknown", backend: "bedrock-runtime" },
  ]);
  await discovery.idle(); assert.equal(calls, 0);
});

test("Codex insights reports observed usage models for discovery", async () => {
  let observed = [];
  setPriceDiscoveryObserver(rows => { observed.push(...rows); });
  try {
    await codexInsights(new Date("2026-09-15T00:00:00Z"), new Date("2026-09-15T01:00:00Z"),
      { profile: "effort" }, async () => [{ family: "scope", dimensions: JSON.stringify(["s", "", "bedrock-mantle", "", terra.model, ""]),
        records: 1, has_usage: 1, last_seen: "2026-09-15 00:01:00" }]);
    assert.deepEqual(observed, [terra]);
  } finally { setPriceDiscoveryObserver(); }
});
