import { test } from "node:test";
import assert from "node:assert/strict";
import { createUsageLookup } from "./analysisData.js";

test("usage lookup reuses canonical cost/coverage, validates filters and carries effective range", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const lookup = createUsageLookup({ enabledClients: ["claude", "codex"], overview: async (from, to, raw, clients, active) => {
    calls++;
    assert.equal(from.toISOString(), "2026-11-06T00:00:00.000Z");
    assert.equal(to.toISOString(), "2026-11-07T00:00:00.000Z");
    assert.equal(active, signal);
    assert.equal(raw.view, "cost");
    assert.deepEqual(clients, ["claude", "codex"]);
    return {
      by_model: [{ client: "codex", backend: "bedrock-mantle", model: "new-model", cost_usd: null,
        cost_basis: "aws_list_estimate", cost_partial: true, observed_tokens: 20, tokens_partial: true }],
      totals: { cost_usd: null, cost_partial: true }, quality: { unpriced: 1 },
      effective_range: { from: from.toISOString(), to: to.toISOString() }, bucket_hours: 1,
    };
  } });
  const range = { from: "2026-11-06T00:00:00Z", to: "2026-11-07T00:00:00Z", dimension: "model" };
  const result = await lookup(range, signal);
  assert.equal(result.rows[0].cost_usd, null);
  assert.equal(result.rows[0].cost_partial, true);
  assert.equal(result.rows[0].observed_tokens, 20);
  assert.equal(result.rows[0].tokens_partial, true);
  assert.equal(result.source, "dashboard");
  assert.equal(result.effective_range.to, "2026-11-07T00:00:00.000Z");
  await assert.rejects(lookup({ ...range, client: "other" }, signal));
  await assert.rejects(lookup({ ...range, backend: "other" }, signal));
  await assert.rejects(lookup({ ...range, dimension: "raw" }, signal));
  await assert.rejects(lookup({ ...range, group: "enterprise" }, signal));
  await assert.rejects(lookup({ ...range, user: "sy******@example.invalid" }, signal), /masked/);
  await assert.rejects(lookup({ ...range, model: "sy******@example.invalid" }, signal), /masked/);
  assert.equal(calls, 1);
});
