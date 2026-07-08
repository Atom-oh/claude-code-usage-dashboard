import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeModelId, priceFor, withComputedCost, tierCosts } from "./pricing.js";

test("normalizeModelId strips bedrock/date/context-window variants", () => {
  assert.equal(normalizeModelId("us.anthropic.claude-sonnet-4-5-20250929-v1:0"), "claude-sonnet-4-5");
  assert.equal(normalizeModelId("global.anthropic.claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(normalizeModelId("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(normalizeModelId("claude-fable-5[1m]"), "claude-fable-5");
  assert.equal(normalizeModelId("anthropic.claude-haiku-4-5"), "claude-haiku-4-5");
});

test("priceFor returns null for unknown models", () => {
  assert.equal(priceFor("some-unknown-model"), null);
  assert.ok(priceFor("claude-sonnet-4-5"));
});

test("withComputedCost multiplies token sums by per-type unit price", () => {
  const rows = [
    {
      model: "claude-sonnet-4-5-20250929",
      input_tokens: 35490,
      output_tokens: 17220,
      cache_read_tokens: 54600,
      cache_write_tokens: 12180,
    },
  ];
  const [row] = withComputedCost(rows);
  assert.equal(row.unpriced, false);
  assert.ok(Math.abs(row.cost - 0.4268) < 0.0005, `expected ~0.4268, got ${row.cost}`);
});

test("tierCosts sums $ per token tier across rows, skipping unpriced models", () => {
  const rows = [
    { model: "claude-sonnet-4-5", input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    { model: "claude-sonnet-4-5", input_tokens: 0, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 },
    { model: "claude-sonnet-4-5", input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000, cache_write_tokens: 0 },
    { model: "claude-sonnet-4-5", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 },
    { model: "some-unknown-model", input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
  ];
  const t = tierCosts(rows);
  assert.equal(t.uncachedInput, 3); // $3/M input
  assert.equal(t.output, 15); // $15/M output
  assert.equal(t.cacheRead, 0.3); // $0.3/M cacheRead
  assert.equal(t.cacheWrite, 3.75); // $3.75/M cacheWrite
});

test("withComputedCost flags unpriced models without dropping reported_cost", () => {
  const rows = [
    {
      model: "some-unknown-model",
      reported_cost: 1.23,
      input_tokens: 100,
      output_tokens: 100,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  ];
  const [row] = withComputedCost(rows);
  assert.equal(row.cost, null);
  assert.equal(row.unpriced, true);
  assert.equal(row.reported_cost, 1.23);
});
