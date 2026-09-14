import { test } from "node:test";
import assert from "node:assert/strict";
import { foldClientMetrics, validateClientFilters, buildCodexQuery } from "./clientMetrics.js";

const event = { client: "codex", kind: "usage", t: "2026-09-14 10:00:00", session: "conversation-1",
  user: "person@example.invalid", backend: "bedrock-mantle", model: "openai.gpt-6-astra",
  project: "fixture", context_tier: "short", count: 1, input_tokens_total: 100, cache_read_tokens: 40,
  cache_write_tokens: 11, output_tokens: 30, reasoning_tokens: 10, invalid: 0 };

test("one fold supplies matching totals, model/user rows and time series", () => {
  const out = foldClientMetrics([
    event,
    { ...event, input_tokens_total: 120, cache_read_tokens: 60, output_tokens: 20, reasoning_tokens: 5 },
    { ...event, kind: "request", count: 2, errors: 0, duration_ms: 60, duration_count: 2 },
    { ...event, kind: "tool", tool: "exec_command", count: 1, errors: 0, duration_ms: 23 },
  ], ["codex"]);
  assert.equal(out.totals.tokens, 270);
  assert.equal(out.totals.sessions, 1);
  assert.equal(out.totals.requests, 2);
  assert.equal(out.totals.tool_calls, 1);
  assert.equal(out.totals.cost_usd, 0.00424050);
  assert.equal(out.by_client[0].input_tokens, 98);
  assert.equal(out.by_client[0].reasoning_tokens, 15);
  assert.equal(out.by_client[0].request_duration_ms, 30);
  assert.equal(out.by_model[0].cost_usd, out.totals.cost_usd);
  assert.equal(out.by_user[0].cost_usd, out.totals.cost_usd);
  assert.equal(out.timeseries[0].cost_usd, out.totals.cost_usd);
  assert.equal(out.tools[0].calls, 1);
  assert.equal(out.by_project[0].project, "fixture");
  assert.equal(out.by_project[0].cost_usd, out.totals.cost_usd);
});

test("clients namespace sessions and preserve their cost sources", () => {
  const out = foldClientMetrics([event, { ...event, client: "claude", backend: "anthropic",
    input_tokens: 49, reported_cost: 2, model: "claude-sonnet-5" }], ["claude", "codex"]);
  assert.equal(out.totals.sessions, 2);
  assert.equal(out.by_client.find((x) => x.client === "claude").cost_usd, 2);
  assert.equal(out.by_client.find((x) => x.client === "claude").cost_basis, "client_reported");
  assert.equal(out.by_client.find((x) => x.client === "codex").cost_basis, "aws_list_estimate");
  assert.equal(out.by_client.find((x) => x.client === "claude").requests, null);
  assert.equal(out.totals.users, 1);
  assert.equal(out.by_client.find((x) => x.client === "claude").backend, "anthropic");
  assert.equal(out.by_client.find((x) => x.client === "codex").backend, "bedrock-mantle");
  assert.equal(out.totals.ttft_ms, null);
});

test("an unpriced component remains visible and makes subtotal cost unavailable", () => {
  const out = foldClientMetrics([event, { ...event, model: "openai.new" }], ["codex"]);
  assert.equal(out.totals.cost_usd, null);
  assert.equal(out.by_client[0].cost_usd, null);
  assert.equal(out.by_user[0].cost_usd, null);
  assert.equal(out.timeseries[0].cost_usd, null);
  assert.equal(out.quality.unpriced, 1);
  assert.equal(out.by_model.find((x) => x.model === "openai.new").cost_usd, null);
});

test("missing Claude reports with positive usage do not become free usage", () => {
  const out = foldClientMetrics([{ ...event, client: "claude", input_tokens: 49, reported_cost: 0 }], ["claude"]);
  assert.equal(out.totals.cost_usd, null);
});

test("empty enabled clients are represented without invented operational measurements", () => {
  const out = foldClientMetrics([], ["claude", "codex"]);
  assert.equal(out.observed_records, 0);
  assert.equal(out.totals.observed_records, 0);
  assert.equal(out.by_client[0].observed_records, 0);
  assert.equal(out.by_client.length, 2);
  assert.equal(out.totals.tokens, 0);
  assert.equal(out.totals.cost_usd, 0);
  assert.equal(out.by_client[0].tool_calls, null);
  assert.equal(out.by_client[1].tool_calls, 0);
  assert.equal(out.by_client[1].ttft_ms, null);
});

test("request and generic completion activity without usage is unavailable, not free", () => {
  const out = foldClientMetrics([
    { ...event, kind: "request", count: 1, errors: 0 },
    { ...event, kind: "completion", count: 1 },
  ], ["codex"]);
  assert.equal(out.observed_records, 2);
  assert.equal(out.totals.requests, 1);
  for (const key of ["tokens", "input_tokens", "cache_read_tokens", "cache_write_tokens",
    "output_tokens", "reasoning_tokens", "cost_usd"]) assert.equal(out.totals[key], null, key);
  assert.equal(out.quality.missing_usage, 1);
  assert.equal(out.quality.unpriced, 1);
  assert.equal(out.quality.invalid, 0);
});

test("a priced session cannot hide another session's missing usage in any subtotal", () => {
  const out = foldClientMetrics([
    event,
    { ...event, session: "missing-session", kind: "request", count: 2 },
    { ...event, session: "missing-session", kind: "completion", count: 1 },
  ], ["codex"]);
  assert.equal(out.observed_records, 4);
  assert.equal(out.totals.sessions, 2);
  assert.equal(out.quality.missing_usage, 1);
  for (const row of [out.totals, ...out.by_client, ...out.by_user, ...out.by_model,
    ...out.by_project, ...out.timeseries]) {
    assert.equal(row.tokens, null);
    assert.equal(row.cost_usd, null);
    assert.equal(row.unpriced, 1);
  }
});

test("missing Codex usage propagates through a combined Claude reported-cost total", () => {
  const out = foldClientMetrics([
    { ...event, client: "claude", backend: "anthropic", input_tokens: 49, reported_cost: 2 },
    { ...event, kind: "request", count: 1 },
  ], ["claude", "codex"]);
  assert.equal(out.totals.cost_usd, null);
  assert.equal(out.by_client.find((r) => r.client === "claude").cost_usd, 2);
  assert.equal(out.by_client.find((r) => r.client === "codex").cost_usd, null);
  assert.equal(out.quality.missing_usage, 1);
});

test("usage can satisfy its own scope across time buckets, including explicit zero usage", () => {
  const zero = { ...event, t: "2026-09-14 10:01:00", input_tokens_total: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
  const out = foldClientMetrics([
    { ...event, kind: "request" }, { ...event, kind: "completion" }, zero,
  ], ["codex"]);
  assert.equal(out.observed_records, 3);
  assert.equal(out.quality.missing_usage, 0);
  assert.equal(out.quality.unpriced, 0);
  assert.equal(out.totals.cost_usd, 0);
  assert.equal(out.totals.tokens, 0);
  assert.equal(out.by_client[0].observed_records, 3);
  assert.ok(out.timeseries.every((r) => r.cost_usd === 0));
});

test("usage availability is isolated by model, backend, user, and project", () => {
  for (const patch of [
    { model: "other-model" }, { backend: "bedrock-runtime" },
    { user: "other@example.invalid" }, { project: "another-project" },
  ]) {
    const out = foldClientMetrics([event, { ...event, ...patch, kind: "completion" }], ["codex"]);
    assert.equal(out.totals.cost_usd, null, JSON.stringify(patch));
    assert.equal(out.quality.missing_usage, 1);
  }
});

test("model-less tools share usage availability with their identified session", () => {
  const out = foldClientMetrics([event, { ...event, model: "", kind: "tool", tool: "exec_command" }], ["codex"]);
  assert.equal(out.totals.cost_usd, 0.00238425);
  assert.equal(out.quality.missing_usage, 0);
});

test("missing tool duration stays unavailable even alongside a measured duration", () => {
  const out = foldClientMetrics([
    { ...event, kind: "tool", tool: "exec_command", duration_ms: 12, duration_count: 1 },
    { ...event, kind: "tool", tool: "exec_command", duration_ms: 0, duration_count: 0 },
  ], ["codex"]);
  assert.equal(out.tools[0].calls, 2);
  assert.equal(out.tools[0].duration_ms, null);
});

test("a recorded failed SSE response is an API error even after HTTP 200", () => {
  const out = foldClientMetrics([
    { ...event, kind: "request", count: 1, errors: 0 },
    { ...event, kind: "stream_error", count: 1 },
  ], ["codex"]);
  assert.equal(out.totals.requests, 1);
  assert.equal(out.totals.api_errors, 1);
});

test("unsupported mixed-client filters fail before queries and prices remain server-side", () => {
  assert.throws(() => validateClientFilters({ client: "codex" }, ["claude"]));
  assert.throws(() => validateClientFilters({ group: "enterprise" }, ["claude", "codex"]));
  assert.throws(() => validateClientFilters({ project: "project" }, ["claude", "codex"]));
  assert.throws(() => validateClientFilters({ backend: ["bedrock-mantle"] }, ["codex"]));
  assert.deepEqual(validateClientFilters({ client: "codex", user: "person", backend: "bedrock-mantle" }, ["claude", "codex"]),
    { clients: ["codex"], user: "person", model: "", backend: "bedrock-mantle" });
  const { sql, params } = buildCodexQuery(new Date("2026-09-14"), new Date("2026-09-15"),
    { user: "x' OR 1=1", model: "openai" });
  assert.ok(!sql.includes("x' OR 1=1"));
  assert.equal(params.clientUser, "x' OR 1=1");
});

test("client model terms are normalized and bound", () => {
  const term = "global.anthropic.claude-sonnet-5' OR 1=1";
  for (const client of ["claude", "codex"]) {
    const { sql, params } = buildCodexQuery(new Date("2026-09-14"), new Date("2026-09-15"), { model: term }, {}, client);
    assert.equal(params.clientModel, client === "claude" ? "claude-sonnet-5' OR 1=1" : term);
    assert.ok(!sql.includes("OR 1=1"));
  }
});
