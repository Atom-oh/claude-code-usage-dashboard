import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeEffort, foldClaudeEffort, validateClaudeEffort } from "./claudeEffort.js";
import { effortMixSql } from "./queries.js";

const from = new Date("2026-10-01T00:00:00Z");
const to = new Date("2026-10-28T12:00:00Z");
const row = (overrides = {}) => ({
  effort: "high", model: "claude-sonnet-5", backend: "bedrock-runtime",
  reported_cost: 5, input_tokens: 10, output_tokens: 1,
  cache_read_tokens: 0, cache_write_tokens: 0,
  cost_counter_rows: 1, observed_usage_rows: 1, ...overrides,
});

test("shared Claude effort preserves known subtotals, unknown amounts and cost bases", () => {
  const result = foldClaudeEffort([
    row(), row({ reported_cost: null }),
    row({ model: "openai.gpt-6.1-sol", reported_cost: 2 }),
    row({ effort: "medium", reported_cost: 0 }),
    row({ effort: "", backend: "unknown", reported_cost: 0, input_tokens: 0, output_tokens: 0 }),
  ]);
  const high = result.find(r => r.effort === "high");
  assert.equal(high.cost_usd, 7);
  assert.equal(high.cost_partial, true);
  assert.equal(high.cost_basis, "mixed");
  assert.equal(high.unpriced, 1);
  assert.equal(result.find(r => r.effort === "medium").cost_usd, null);
  assert.equal(result.find(r => r.effort === "unknown").cost_usd, 0);
  assert.equal(result.find(r => r.effort === "unknown").cost_partial, false);
  assert.deepEqual(foldClaudeEffort([]), []);
});

test("backend identity stays separate even when effort names match", () => {
  const result = foldClaudeEffort([row(), row({ backend: "anthropic", reported_cost: 3 })]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(r => r.cost_usd).sort(), [3, 5]);
  assert.ok(result.every(r => !Object.hasOwn(r, "model") && !Object.hasOwn(r, "user")));
});

test("lookback-only rows establish neither measured zero nor exclusions", () => {
  const result = foldClaudeEffort([
    row(), row({ reported_cost: 0, input_tokens: 0, output_tokens: 0,
      observed_usage_rows: 0, cost_counter_rows: 0 }),
  ]);
  assert.equal(result[0].cost_usd, 5);
  assert.equal(result[0].cost_partial, false);
  assert.equal(result[0].unpriced, 0);
});

test("shared effort validates filters and preserves parent response bounds", async () => {
  let args;
  const result = await claudeEffort(from, to,
    { client: "claude", backend: "bedrock-mantle", user: " fixture ", model: "opus" },
    async (...received) => { args = received; return [row()]; });
  assert.deepEqual(result.range, { from: from.toISOString(), to: to.toISOString() });
  assert.equal(result.cost_scope, "reported_or_rescaled_counters");
  assert.deepEqual(args, [from, to,
    { user: "fixture", model: "opus", backend: "bedrock-mantle", excludeUnknown: false },
    { byModel: true }]);
  for (const raw of [{ client: "codex" }, { group: "bedrock" }, { project: "project" },
    { backend: "bedrock" }, { userExact: "fixture" }, { modelExact: "opus" }])
    assert.throws(() => validateClaudeEffort(raw));
});

test("shared counter SQL preserves temporality and binds backend/user/model selection", () => {
  const { sql, params } = effortMixSql(from, to,
    { user: "fixture'--", model: "us.anthropic.claude-sonnet-5", backend: "bedrock-runtime", excludeUnknown: false },
    { byModel: true });
  assert.match(sql, /maxIf\(Value, TimeUnix < \{to:DateTime\}\) - maxIf\(Value, TimeUnix < \{from:DateTime\}\)/);
  assert.match(sql, /sumIf\(Value, TimeUnix >= \{from:DateTime\} AND TimeUnix < \{to:DateTime\}\)/);
  assert.match(sql, /HAVING countIf\(m\.InWindow\) > 0/);
  assert.ok(!sql.includes("ResourceAttributes['backend']"),
    "Claude backend fallback follows parent overview, not Codex resource tags");
  assert.match(sql, /backend = \{fBackend:String\}/);
  assert.match(sql, /GROUP BY "group", effort, model, backend, m\.SessionId, m\.UserEmail/);
  assert.equal(params.fBackend, "bedrock-runtime");
  assert.equal(params.fUser, "fixture'--");
  assert.equal(params.fModel, "claude-sonnet-5");
  assert.ok(!sql.includes("fixture'--"));
});

test("legacy effort SQL keeps its existing grain and unknown-group policy", () => {
  const { sql, params } = effortMixSql(from, to);
  assert.match(sql, /GROUP BY "group", effort, model\s/);
  assert.ok(!sql.includes("AS backend"));
  assert.ok(!Object.hasOwn(params, "fBackend"));
  assert.ok(!sql.includes("LIMIT 50001"));
});

test("shared effort bounds transported scopes without returning a truncated subtotal", async () => {
  assert.match(effortMixSql(from, to, {}, { byModel: true }).sql, /LIMIT 50001\s*$/);
  const scopes = Array(50000).fill(row());
  assert.equal((await claudeEffort(from, to, {}, async () => scopes)).effort[0].cost_usd, 250000);
  await assert.rejects(claudeEffort(from, to, {}, async () => [...scopes, row()]),
    error => error.status === 400 && error.message === "too much client data");
});

test("known effort subtotal bases omit excluded scopes while all-unknown bases retain sources", () => {
  const awsMissing = row({ model: "openai.gpt-6.1-sol", reported_cost: null });
  const known = foldClaudeEffort([row(), awsMissing])[0];
  assert.equal(known.cost_basis, "client_reported");
  assert.equal(known.cost_usd, 5);
  assert.equal(known.cost_partial, true);
  assert.equal(known.unpriced, 1);
  assert.equal(foldClaudeEffort([awsMissing])[0].cost_basis, "aws_list_estimate");
  assert.equal(foldClaudeEffort([row({ reported_cost: null }), awsMissing])[0].cost_basis, "mixed");
});
