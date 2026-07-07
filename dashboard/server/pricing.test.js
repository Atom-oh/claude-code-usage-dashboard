import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeModelId, priceFor, withComputedCost } from "./pricing.js";

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
