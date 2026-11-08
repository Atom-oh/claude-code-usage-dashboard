import { test } from "node:test";
import assert from "node:assert/strict";
import { createUsageLookup, USAGE_TOOL } from "./analysisData.js";
import { CLIENT_BACKENDS } from "./clientMetrics.js";

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

test("an enabled client without observed records is unavailable, not a known free zero", async () => {
  const signal = new AbortController().signal;
  const claude = { client: "claude", backend: "anthropic", cost_usd: 2, cost_basis: "client_reported", cost_partial: false,
    tokens: 49, observed_tokens: 49, tokens_partial: false, sessions: 1, users: 1, unpriced: 0, observed_records: 1 };
  const codex = { client: "codex", backend: "unknown", cost_usd: 0, cost_basis: "aws_list_estimate", cost_partial: false,
    tokens: 0, observed_tokens: 0, tokens_partial: false, sessions: 0, users: 0, unpriced: 0, rejected_requests: 0,
    request_rejections_only: false, observed_records: 0 };
  const idle = { client: "claude", t: "2026-11-06 01:00:00", cost_usd: 0, cost_basis: "client_reported", cost_partial: false,
    tokens: 0, observed_tokens: 0, tokens_partial: false, sessions: 0, users: 0, unpriced: 0, observed_records: 0, timeline_observed: true };
  const observed = { cost_usd: 2, cost_partial: false, tokens: 49, observed_tokens: 49, tokens_partial: false, sessions: 1, users: 1, unpriced: 0, observed_records: 1 };
  const empty = { ...observed, cost_usd: 0, tokens: 0, observed_tokens: 0, sessions: 0, users: 0, observed_records: 0 };
  const lookup = totals => createUsageLookup({ enabledClients: ["claude", "codex"], overview: async () => ({
    by_client: [claude, codex], timeseries: [idle], totals, quality: { unpriced: 0 },
    effective_range: { from: "2026-11-06T00:00:00.000Z", to: "2026-11-07T00:00:00.000Z" }, bucket_hours: 1 }) });
  const range = { from: "2026-11-06T00:00:00Z", to: "2026-11-07T00:00:00Z" };
  const clients = await lookup(observed)({ ...range, dimension: "client" }, signal);
  assert.deepEqual(clients.rows.map(row => [row.client, row.cost_usd, row.tokens, row.observed_tokens, row.sessions, row.users, row.rejected_requests, row.observed_records]),
    [["claude", 2, 49, 49, 1, 1, undefined, 1], ["codex", null, null, null, null, null, null, 0]]);
  assert.equal(clients.rows[1].cost_partial, false);
  assert.equal(clients.rows[1].unpriced, 0);
  assert.equal(clients.totals.cost_usd, 2);
  const time = await lookup(observed)({ ...range, dimension: "time" }, signal);
  assert.deepEqual([time.rows[0].cost_usd, time.rows[0].observed_tokens, time.rows[0].timeline_observed], [0, 0, true]);
  const none = await lookup(empty)({ ...range, dimension: "client" }, signal);
  assert.deepEqual([none.totals.cost_usd, none.totals.tokens, none.totals.observed_tokens, none.totals.observed_records], [null, null, null, 0]);
});

test("dimension rows share the SQL chat whole-row cap and report truncation truthfully", async () => {
  const signal = new AbortController().signal;
  const users = n => Array.from({ length: n }, (_, i) => ({ client: "codex", user: `u${i}@example.invalid`,
    cost_usd: 1, cost_basis: "aws_list_estimate", cost_partial: false, observed_records: 1 }));
  const lookup = n => createUsageLookup({ enabledClients: ["codex"], overview: async () => ({ by_user: users(n),
    totals: { cost_usd: n, cost_partial: false, observed_records: n }, quality: { unpriced: 0 },
    effective_range: { from: "2026-11-06T00:00:00.000Z", to: "2026-11-07T00:00:00.000Z" }, bucket_hours: 24 }) });
  const range = { from: "2026-11-06T00:00:00Z", to: "2026-11-07T00:00:00Z", dimension: "user" };
  const cut = await lookup(201)(range, signal);
  assert.equal(cut.rows.length, 200);
  assert.equal(cut.truncated, true);
  assert.equal(cut.totals.cost_usd, 201);
  const whole = await lookup(200)(range, signal);
  assert.equal(whole.rows.length, 200);
  assert.equal(whole.truncated, false);
});

test("the usage tool backend vocabulary is the shared-view filter vocabulary", () => {
  assert.deepEqual(CLIENT_BACKENDS, ["bedrock-mantle", "bedrock-runtime", "anthropic", "unknown"]);
  assert.deepEqual(USAGE_TOOL.toolSpec.inputSchema.json.properties.backend.enum, ["all", ...CLIENT_BACKENDS]);
});
