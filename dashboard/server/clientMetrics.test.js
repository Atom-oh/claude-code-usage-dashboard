import { test } from "node:test";
import assert from "node:assert/strict";
import { foldClientMetrics, validateClientFilters, buildCodexQuery } from "./clientMetrics.js";

const event = { client: "codex", kind: "usage", t: "2026-09-14 10:00:00", session: "conversation-1",
  user: "person@example.invalid", backend: "bedrock-mantle", model: "openai.gpt-6-astra",
  project: "fixture", context_tier: "short", count: 1, input_tokens_total: 100, cache_read_tokens: 40,
  cache_write_tokens: 11, output_tokens: 30, reasoning_tokens: 10, invalid: 0 };

test("idle Claude counter observations fill only the timeline, not active population or totals", () => {
  const active = { ...event, client: "claude", input_tokens: 49, reported_cost: 2 };
  const baseline = foldClientMetrics([active], ["claude", "codex"]);
  const actual = foldClientMetrics([active, {
    ...active, t: "2026-09-14 11:00:00", timeline_only: 1,
    token_observed: 1, cost_observed: 1, token_missing: 0, cost_missing: 0,
    session: "", user: "", model: "", backend: "",
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reported_cost: 0,
  }], ["claude", "codex"]);
  assert.deepEqual({ ...actual, timeseries: [] }, { ...baseline, timeseries: [] });
  assert.deepEqual(actual.timeseries[0], baseline.timeseries[0]);
  const zero = actual.timeseries[1];
  assert.equal(zero.timeline_observed, true);
  assert.equal(zero.client, "claude");
  assert.equal(zero.observed_tokens, 0);
  assert.equal(zero.cost_usd, 0);
  assert.equal(zero.sessions, 0);
  assert.equal(zero.users, 0);
  assert.equal(zero.observed_records, 0);
  assert.equal(zero.reasoning_tokens, null);
  assert.equal(actual.timeseries.some(row => row.client === "codex"), false);
  assert.equal(actual.timeseries.some(row => row.t === "2026-09-14 12:00:00"), false);
});

test("idle markers do not consume the active-row budget and both classes remain bounded", () => {
  const marker = { client: "claude", timeline_only: 1, t: "2026-09-14 09:00:00",
    token_observed: 1, cost_observed: 1, token_missing: 0, cost_missing: 0 };
  const active = Array(50000).fill(event);
  assert.equal(foldClientMetrics([...active, marker], ["claude", "codex"]).totals.observed_tokens, 6500000);
  assert.throws(() => foldClientMetrics([...active, event, marker], ["claude", "codex"]), /too much client data/);
  assert.throws(() => foldClientMetrics(Array(50001).fill(marker), ["claude"]), /too much client data/);
});

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
  assert.equal(out.totals.cost_partial, false);
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

test("request-only rejected scopes have zero recorded usage while retaining request errors", () => {
  const rejected = { ...event, kind: "request", count: 3, rejected_count: 3, errors: 3,
    model: "global.openai.gpt-6-astra", duration_ms: 90, duration_count: 3 };
  const out = foldClientMetrics([rejected], ["codex"]);
  for (const row of [out.totals, ...out.by_client, ...out.by_model, ...out.by_user, ...out.by_project, ...out.timeseries]) {
    assert.equal(row.observed_tokens, 0);
    assert.equal(row.cost_usd, 0);
    assert.equal(row.cost_partial, false);
    assert.equal(row.tokens_partial, false);
    assert.equal(row.rejected_requests, 3);
  }
  assert.equal(out.timeseries[0].request_rejections_only, true);
  assert.equal(out.totals.requests, 3);
  assert.equal(out.totals.api_errors, 3);
  assert.equal(out.quality.missing_usage, 0);
  assert.equal(out.quality.unpriced, 0);
});

test("accepted, uncertain and mixed requests still require completion usage", () => {
  const rejected = { ...event, kind: "request", count: 3, rejected_count: 3, errors: 3 };
  for (const extra of [
    { ...rejected, count: 1, rejected_count: 0 },
    { ...event, kind: "completion" },
    { ...event, kind: "stream_error" },
    { ...event, kind: "tool" },
  ]) {
    const out = foldClientMetrics([rejected, extra], ["codex"]);
    assert.equal(out.totals.observed_tokens, null);
    assert.equal(out.totals.cost_usd, null);
    assert.equal(out.quality.missing_usage, 1);
  }
  const mixed = foldClientMetrics([{ ...rejected, count: 4 }], ["codex"]);
  assert.equal(mixed.totals.observed_tokens, null);
  for (const fields of [{ session: "" }, { requires_usage: 1 }, { requires_usage: "invalid" }]) {
    const uncertain = foldClientMetrics([{ ...rejected, ...fields }], ["codex"]);
    assert.equal(uncertain.totals.observed_tokens, null);
    assert.equal(uncertain.timeseries[0].request_rejections_only, false);
  }
  const known = foldClientMetrics([event, { ...rejected, session: "rejected" }], ["codex"]);
  assert.equal(known.totals.observed_tokens, 130);
  assert.equal(known.totals.cost_usd, 0.00238425);
  assert.equal(known.quality.missing_usage, 0);
  for (const evidence of [{ ...event, kind: "tool" }, { ...event, kind: "stream_error" }]) {
    const unknownModel = foldClientMetrics([{ ...rejected, model: "" },
      { ...evidence, t: "2026-09-14 11:00:00" }], ["codex"]);
    assert.equal(unknownModel.totals.observed_tokens, null);
    assert.equal(unknownModel.totals.cost_usd, null);
    assert.equal(unknownModel.timeseries[0].observed_tokens, null);
  }
  assert.equal(foldClientMetrics([{ ...rejected, model: "" }, event], ["codex"]).quality.missing_usage, 0);
});
test("known observed tokens survive an unmatched usage scope without changing canonical coverage or cost", () => {
  const out = foldClientMetrics([
    event,
    { ...event, t: "2026-09-14 11:00:00", input_tokens_total: 40, cache_read_tokens: 10,
      cache_write_tokens: 5, output_tokens: 10, reasoning_tokens: 1 },
    { ...event, kind: "request", session: "missing-usage" },
  ], ["codex"]);
  for (const row of [out.totals, ...out.by_client, ...out.by_model, ...out.by_user, ...out.by_project]) {
    assert.equal(row.tokens, null);
    assert.equal(row.observed_tokens, 180);
    assert.equal(row.tokens_partial, true);
  }
  assert.equal(out.totals.cost_usd, 0.003289);
  assert.equal(out.quality.missing_usage, 1);
  assert.deepEqual(out.timeseries.map(({ tokens, observed_tokens, tokens_partial }) =>
    ({ tokens, observed_tokens, tokens_partial })), [
    { tokens: null, observed_tokens: 130, tokens_partial: true },
    { tokens: 50, observed_tokens: 50, tokens_partial: false },
  ]);
});

test("missing cache metadata preserves observed input/output while full token totals stay unavailable", () => {
  const out = foldClientMetrics([{ ...event, cache_write_tokens: null }], ["codex"]);
  assert.equal(out.totals.tokens, null);
  assert.equal(out.totals.observed_tokens, 130);
  assert.equal(out.totals.tokens_partial, true);
  assert.equal(out.totals.cost_usd, null);
  assert.equal(out.quality.invalid, 1);
});

test("observed token totals distinguish zero, unknown, empty and overflow", () => {
  const zero = { ...event, input_tokens_total: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 };
  const unknown = { ...event, output_tokens: null };
  const mixed = foldClientMetrics([zero, unknown], ["codex"]);
  assert.equal(mixed.totals.observed_tokens, 0);
  assert.equal(mixed.totals.tokens_partial, true);
  assert.equal(foldClientMetrics([unknown], ["codex"]).totals.observed_tokens, null);
  assert.equal(foldClientMetrics([{ ...event, kind: "request" }], ["codex"]).totals.observed_tokens, null);
  const empty = foldClientMetrics([], ["codex"]);
  assert.equal(empty.totals.observed_tokens, 0);
  assert.equal(empty.totals.tokens_partial, false);
  const huge = { ...zero, input_tokens_total: Number.MAX_SAFE_INTEGER };
  const overflow = foldClientMetrics([huge, huge], ["codex"]);
  assert.equal(overflow.totals.observed_tokens, null);
  assert.equal(overflow.totals.tokens_partial, true);
});

test("missing model prices do not invalidate measured tokens or mark them partial", () => {
  const out = foldClientMetrics([{ ...event, model: "openai.unpriced" }], ["codex"]);
  assert.equal(out.totals.observed_tokens, 130);
  assert.equal(out.totals.tokens_partial, false);
  assert.equal(out.totals.tokens, 130);
  assert.equal(out.totals.cost_usd, null);
});

test("mixed clients retain their own observed amounts and combine known counts", () => {
  const out = foldClientMetrics([event,
    { ...event, kind: "request", session: "missing" },
    { ...event, client: "claude", input_tokens: 49, reported_cost: 2 },
  ], ["claude", "codex"]);
  assert.equal(out.totals.tokens, null);
  assert.equal(out.totals.observed_tokens, 260);
  assert.equal(out.totals.tokens_partial, true);
  const claude = out.by_client.find(row => row.client === "claude");
  assert.equal(claude.tokens, 130);
  assert.equal(claude.observed_tokens, 130);
  assert.equal(claude.tokens_partial, false);
  assert.equal(claude.cost_usd, 2);
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

test("an unpriced component is excluded from known cost subtotals and remains disclosed", () => {
  const out = foldClientMetrics([event, { ...event, model: "openai.new" }], ["codex"]);
  for (const row of [out.totals, ...out.by_client, ...out.by_user, ...out.by_project, ...out.timeseries]) {
    assert.equal(row.cost_usd, 0.00238425);
    assert.equal(row.cost_partial, true);
    assert.equal(row.unpriced, 1);
  }
  assert.equal(out.quality.unpriced, 1);
  assert.equal(out.by_model.find((x) => x.model === "openai.new").cost_usd, null);
  assert.equal(out.by_model.find((x) => x.model === "openai.new").cost_partial, true);
  assert.equal(out.by_model.find((x) => x.model === event.model).cost_partial, false);
});

test("a known zero cost can be summed without turning an all-unknown cost into zero", () => {
  const zero = { ...event, input_tokens_total: 0, cache_read_tokens: 0,
    cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
  const unknown = { ...event, model: "openai.unpriced" };
  const partial = foldClientMetrics([zero, unknown], ["codex"]);
  assert.equal(partial.totals.cost_usd, 0);
  assert.equal(partial.totals.cost_partial, true);
  assert.equal(partial.quality.unpriced, 1);
  const absent = foldClientMetrics([unknown], ["codex"]);
  for (const row of [absent.totals, ...absent.by_client, ...absent.by_model, ...absent.by_user,
    ...absent.by_project, ...absent.timeseries]) {
    assert.equal(row.cost_usd, null);
    assert.equal(row.cost_partial, true);
  }
});

test("valid Claude reported costs survive missing token components without repricing", () => {
  const out = foldClientMetrics([
    { ...event, client: "claude", input_tokens: undefined, reported_cost: "2.5" },
  ], ["claude"]);
  assert.equal(out.totals.cost_usd, 2.5);
  assert.equal(out.totals.cost_partial, false);
  assert.equal(out.totals.tokens, null);
  assert.equal(out.quality.invalid, 1);
  assert.equal(out.quality.unpriced, 0);
});

test("invalid Claude reports are excluded rather than poisoning a valid report subtotal", () => {
  for (const report of [null, undefined, "", " ", true, false, [2], {}, NaN, Infinity, -1, 0]) {
    const valid = { ...event, client: "claude", input_tokens: 49, reported_cost: 2 };
    const out = foldClientMetrics([valid, { ...valid, reported_cost: report }], ["claude"]);
    assert.equal(out.totals.cost_usd, 2, String(report));
    assert.equal(out.totals.cost_partial, true, String(report));
    assert.equal(out.quality.unpriced, 1, String(report));
  }
});

test("a non-finite aggregate is unavailable rather than an infinite known subtotal", () => {
  const huge = { ...event, client: "claude", input_tokens: 49, reported_cost: Number.MAX_VALUE };
  const out = foldClientMetrics([huge, huge], ["claude"]);
  assert.equal(out.totals.cost_usd, null);
  assert.equal(out.totals.cost_partial, true);
});

test("missing Claude reports with positive usage do not become free usage", () => {
  const out = foldClientMetrics([{ ...event, client: "claude", input_tokens: 49, reported_cost: 0 }], ["claude"]);
  assert.equal(out.totals.cost_usd, null);
  assert.equal(out.totals.cost_partial, true);
});

test("empty enabled clients are represented without invented operational measurements", () => {
  const out = foldClientMetrics([], ["claude", "codex"]);
  assert.equal(out.observed_records, 0);
  assert.equal(out.totals.observed_records, 0);
  assert.equal(out.by_client[0].observed_records, 0);
  assert.equal(out.by_client.length, 2);
  assert.equal(out.totals.tokens, 0);
  assert.equal(out.totals.cost_usd, 0);
  assert.equal(out.totals.cost_partial, false);
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

test("a priced session supplies a subtotal while another session's missing usage stays disclosed", () => {
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
    assert.equal(row.cost_usd, 0.00238425);
    assert.equal(row.cost_partial, true);
    assert.equal(row.unpriced, 1);
  }
});

test("missing Codex usage does not discard a combined Claude reported-cost subtotal", () => {
  const out = foldClientMetrics([
    { ...event, client: "claude", backend: "anthropic", input_tokens: 49, reported_cost: 2 },
    { ...event, kind: "request", count: 1 },
  ], ["claude", "codex"]);
  assert.equal(out.totals.cost_usd, 2);
  assert.equal(out.totals.cost_partial, true);
  assert.equal(out.totals.tokens, null);
  assert.equal(out.by_client.find((r) => r.client === "claude").cost_usd, 2);
  assert.equal(out.by_client.find((r) => r.client === "claude").cost_partial, false);
  assert.equal(out.by_client.find((r) => r.client === "codex").cost_usd, null);
  assert.equal(out.by_client.find((r) => r.client === "codex").cost_partial, true);
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
    assert.equal(out.totals.cost_usd, 0.00238425, JSON.stringify(patch));
    assert.equal(out.totals.cost_partial, true, JSON.stringify(patch));
    assert.equal(out.totals.tokens, null, JSON.stringify(patch));
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

const modelTimeRecords = [
  event,
  { ...event, backend: "bedrock-runtime", model: "global.openai.gpt-6-astra" },
  { ...event, session: "gateway", model: "global.openai.gpt-6-astra" },
  { ...event, session: "new-model", model: "openai.new" },
  { ...event, session: "broken", cache_write_tokens: null },
  { ...event, session: "no-backend", backend: "unknown" },
  { ...event, kind: "request", session: "missing-usage", model: "" },
  { ...event, client: "claude", backend: "anthropic", model: "claude-sonnet-5", session: "c1", input_tokens: 49, reported_cost: 2 },
  { ...event, client: "claude", backend: "anthropic", model: "claude-sonnet-5", session: "c2", input_tokens: 49, reported_cost: 0 },
  { ...event, client: "claude", backend: "anthropic", model: "claude-sonnet-5", session: "c3", input_tokens: 49, reported_cost: 0, cost_observed: 0 },
  { client: "claude", timeline_only: 1, t: "2026-09-14 11:00:00", token_observed: 1, cost_observed: 1,
    token_missing: 0, cost_missing: 0, session: "", user: "", model: "", backend: "", kind: "usage",
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reported_cost: 0 },
];
const modelTimeClients = ["claude", "codex"];

test("modelTime adds by_model_time without changing any other output", () => {
  const without = foldClientMetrics(modelTimeRecords, modelTimeClients);
  const off = foldClientMetrics(modelTimeRecords, modelTimeClients, undefined, { modelTime: false });
  const on = foldClientMetrics(modelTimeRecords, modelTimeClients, undefined, { modelTime: true });
  assert.ok(!("by_model_time" in without));
  assert.deepEqual(off, without);
  const { by_model_time, ...rest } = on;
  assert.deepEqual(rest, without);
  assert.ok(Array.isArray(by_model_time));
  assert.equal(by_model_time.length, 7);
  for (const row of [without.totals, ...without.by_client, ...without.by_model, ...without.by_user,
    ...without.by_project, ...without.timeseries]) {
    assert.ok(!("unpriced_reasons" in row));
  }
  // Accumulator internals such as _reasons must not leak into any row. A leak changes today's
  // output identically with and without the option, so the deep-equal above cannot see it.
  for (const row of [without.totals, ...without.by_client, ...without.by_model, ...without.by_user,
    ...without.by_project, ...without.timeseries, ...by_model_time]) {
    assert.ok(Object.keys(row).every((k) => !k.startsWith("_")), Object.keys(row).join(","));
  }
});

test("by_model_time reason counts weigh grouped responses like unpriced", () => {
  // One Codex SQL group can hold several responses; each counts once in unpriced and its reason.
  const out = foldClientMetrics([{ ...event, model: "openai.new", count: 3 }], ["codex"], undefined, { modelTime: true });
  assert.equal(out.by_model_time[0].unpriced, 3);
  assert.equal(out.by_model_time[0].unpriced_reasons.unknown_model, 3);
});

test("by_model_time rows carry raw models and per-reason unpriced counts", () => {
  const on = foldClientMetrics(modelTimeRecords, modelTimeClients, undefined, { modelTime: true });
  const noCodexReason = { unknown_backend: 0, scope: 0, unknown_model: 0, invalid_usage: 0, missing_usage: 0 };
  const expected = [
    ["claude", "claude-sonnet-5", "anthropic", 2, true, { report_missing: 1, report_zero_with_tokens: 1, missing_usage: 0 }],
    ["codex", "", "bedrock-mantle", null, true, { ...noCodexReason, missing_usage: 1 }],
    ["codex", "global.openai.gpt-6-astra", "bedrock-mantle", null, true, { ...noCodexReason, scope: 1 }],
    ["codex", "global.openai.gpt-6-astra", "bedrock-runtime", 0.0021675, false, { ...noCodexReason }],
    ["codex", "openai.gpt-6-astra", "bedrock-mantle", 0.00238425, true, { ...noCodexReason, invalid_usage: 1 }],
    ["codex", "openai.gpt-6-astra", "unknown", null, true, { ...noCodexReason, unknown_backend: 1 }],
    ["codex", "openai.new", "bedrock-mantle", null, true, { ...noCodexReason, unknown_model: 1 }],
  ];
  assert.deepEqual(on.by_model_time.map((r) => [r.client, r.model, r.backend]),
    expected.map(([client, model, backend]) => [client, model, backend]));
  expected.forEach(([client, model, backend, cost_usd, cost_partial, unpriced_reasons], i) => {
    const row = on.by_model_time[i];
    const message = `${client}/${model}/${backend}`;
    assert.equal(row.t, "2026-09-14 10:00:00", message);
    if (cost_usd === null) assert.equal(row.cost_usd, null, message);
    else assert.ok(Math.abs(row.cost_usd - cost_usd) < 1e-9, message);
    assert.equal(row.cost_partial, cost_partial, message);
    assert.deepEqual(row.unpriced_reasons, unpriced_reasons, message);
    assert.equal(Object.values(row.unpriced_reasons).reduce((s, n) => s + n, 0), row.unpriced, message);
  });
  const emptyModel = on.by_model_time.find((r) => r.client === "codex" && r.model === "");
  assert.equal(emptyModel.requests, 1);
  const recordModels = new Set(modelTimeRecords.map((r) => r.model || ""));
  for (const row of on.by_model_time) assert.ok(recordModels.has(row.model), row.model);
  assert.ok(!on.by_model_time.some((r) => r.t === "2026-09-14 11:00:00"));
  const idle = on.timeseries.find((r) => r.client === "claude" && r.t === "2026-09-14 11:00:00");
  assert.equal(idle.timeline_observed, true);
});

test("by_model_time known costs sum to the timeseries per client and bucket", () => {
  const on = foldClientMetrics(modelTimeRecords, modelTimeClients, undefined, { modelTime: true });
  for (const ts of on.timeseries) {
    const rows = on.by_model_time.filter((r) => r.client === ts.client && r.t === ts.t);
    const message = `${ts.client}/${ts.t}`;
    if (ts.cost_usd === null) {
      for (const row of rows) assert.equal(row.cost_usd, null, message);
    } else {
      const known = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
      assert.ok(Math.abs(known - ts.cost_usd) < 1e-9, message);
    }
  }
  const codex = on.timeseries.find((r) => r.client === "codex" && r.t === "2026-09-14 10:00:00");
  assert.ok(Math.abs(codex.cost_usd - 0.00455175) < 1e-9);
  assert.ok(on.by_model_time.filter((r) => r.client === "codex" && r.t === codex.t).length >= 2);
});

test("Claude by_model_time rows use the claudeUsage rule", () => {
  const valid = foldClientMetrics([
    { ...event, client: "claude", backend: "anthropic", model: "claude-sonnet-5", input_tokens: undefined, reported_cost: "2.5" },
  ], ["claude"], undefined, { modelTime: true });
  assert.equal(valid.by_model_time.length, 1);
  assert.equal(valid.by_model_time[0].cost_usd, 2.5);
  assert.equal(valid.by_model_time[0].cost_partial, false);
  assert.deepEqual(valid.by_model_time[0].unpriced_reasons,
    { report_missing: 0, report_zero_with_tokens: 0, missing_usage: 0 });
  const invalid = foldClientMetrics([
    { ...event, client: "claude", backend: "anthropic", model: "claude-sonnet-5", input_tokens: 49, reported_cost: -1 },
  ], ["claude"], undefined, { modelTime: true });
  assert.equal(invalid.by_model_time.length, 1);
  assert.equal(invalid.by_model_time[0].cost_usd, null);
  assert.equal(invalid.by_model_time[0].unpriced_reasons.report_missing, 1);
});

// by_model_time rows exist only for counter-backed usage or Codex missing-usage scopes.
// Operational rows (request, tool, ttft, stream_error, approval) attach to such a row but never create one.
const opT = "2026-09-14 10:00:00";
const idleNoCost = { client: "claude", timeline_only: 1, t: opT, token_observed: 1, cost_observed: 0,
  token_missing: 0, cost_missing: 0, session: "", user: "", model: "", backend: "", kind: "usage",
  input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reported_cost: 0 };
const claudeOp = { client: "claude", t: opT, session: "idle", user: "person@example.invalid",
  model: "claude-sonnet-5", backend: "anthropic", project: "", count: 1, errors: 0 };

test("Claude operational rows never create a known $0 by_model_time row", () => {
  const out = foldClientMetrics([
    idleNoCost,
    { ...claudeOp, kind: "request", duration_ms: 10, duration_count: 1 },
    { ...claudeOp, kind: "tool", tool: "Bash" },
    { ...claudeOp, kind: "ttft", duration_ms: 5, duration_count: 1 },
  ], ["claude"], undefined, { modelTime: true });
  assert.deepEqual(out.by_model_time, [], "operational rows create no by_model_time row");
  const buckets = out.timeseries.filter((r) => r.t === opT);
  assert.equal(buckets.length, 1, "one timeseries bucket at opT");
  assert.equal(buckets[0].cost_usd, null, "idle bucket cost stays unknown");
  assert.equal(buckets[0].cost_partial, true, "idle bucket cost is partial");
  assert.equal(buckets[0].requests, 1, "request row counted in the timeseries");
  assert.equal(buckets[0].tool_calls, 1, "tool row counted in the timeseries");
});

test("operational rows attach to a counter-backed by_model_time row in either record order", () => {
  const usage = { ...event, client: "claude", backend: "anthropic", model: "claude-sonnet-5", session: "idle",
    input_tokens: 49, reported_cost: 2 };
  const request2 = { ...claudeOp, kind: "request", count: 2, duration_ms: 20, duration_count: 2 };
  const first = foldClientMetrics([request2, usage], ["claude"], undefined, { modelTime: true });
  const second = foldClientMetrics([usage, request2], ["claude"], undefined, { modelTime: true });
  for (const [label, out] of [["request first", first], ["usage first", second]]) {
    assert.equal(out.by_model_time.length, 1, `${label}: one by_model_time row`);
    assert.equal(out.by_model_time[0].cost_usd, 2, `${label}: reported cost`);
    assert.equal(out.by_model_time[0].cost_partial, false, `${label}: cost not partial`);
    assert.equal(out.by_model_time[0].requests, 2, `${label}: requests attached`);
  }
  assert.deepEqual(first.by_model_time, second.by_model_time, "record order does not change by_model_time");
});

test("Codex operational-only buckets and rejected-only models create no by_model_time row", () => {
  const later = "2026-09-14 11:00:00";
  const out = foldClientMetrics([
    event,
    { ...event, kind: "request", t: later },
    { ...event, kind: "tool", t: later, tool: "exec_command" },
    { ...event, kind: "stream_error", t: later },
    { ...event, kind: "request", session: "rejected", model: "openai.gpt-5.6-luna", count: 2, rejected_count: 2, errors: 2 },
  ], ["codex"], undefined, { modelTime: true });
  assert.deepEqual(out.by_model_time.map((r) => [r.t, r.model, r.backend, r.cost_usd]),
    [["2026-09-14 10:00:00", "openai.gpt-6-astra", "bedrock-mantle", 0.00238425]],
    "only the usage-bearing astra bucket has a by_model_time row");
  const ts = out.timeseries.find((r) => r.t === later);
  assert.ok(ts, "operational 11:00 timeseries bucket exists");
  assert.equal(ts.cost_usd, 0, "11:00 timeseries cost");
  assert.equal(ts.requests, 1, "11:00 timeseries requests");
  assert.equal(ts.tool_calls, 1, "11:00 timeseries tool calls");
  assert.equal(ts.api_errors, 1, "11:00 timeseries api errors");
  assert.equal(out.quality.missing_usage, 0, "no missing-usage scope");
});
