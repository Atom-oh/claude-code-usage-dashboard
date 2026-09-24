import { test } from "node:test";
import assert from "node:assert/strict";
import { codexInsights } from "./codexInsights.js";

const from = new Date("2026-09-15T00:00:00Z"), to = new Date("2026-09-15T01:00:00Z");
const row = (family, dimensions, values = {}) => ({ family, dimensions: JSON.stringify(dimensions),
  records: 1, last_seen: "2026-09-15 00:01:00", ...values });
const promptRows = [row("event", ["codex.user_prompt"]),
  row("operations", [], { prompts: 1, prompt_length: 10 })];
const pricedUsage = { input: 100, read: 40, write: 11, output: 30, reasoning: 10,
  tokens: 130, observed_tokens: 130, observed_pairs: 1, priced: 1, unpriced: 0, cost_usd: 0.00238425 };
const usageRows = [
  row("event", ["codex.sse_event"]),
  row("operations", [], { requests: 1 }),
  row("scope", ["priced", "", "bedrock-mantle", "", "openai.gpt-6-astra", ""],
    { has_usage: 1, requires_usage: 1, has_operational: 1 }),
  row("usage", [], pricedUsage),
  row("effort", ["high"], pricedUsage),
];
const diagnostic = sql => sql.includes("codex_metrics_") || sql.includes("FROM claude_code.otel_traces");

test("missing optional signal tables do not hide existing logs or manufacture observations", async () => {
  let logQueries = 0;
  const result = await codexInsights(from, to, {}, async (sql) => {
    if (diagnostic(sql)) throw { code: "60" };
    logQueries++;
    return promptRows;
  });
  assert.equal(logQueries, 1, "counts, usage, and scope evidence share one log query");
  assert.equal(result.coverage.logs.status, "observed");
  assert.equal(result.coverage.metrics.status, "unavailable");
  assert.equal(result.coverage.traces.status, "unavailable");
  assert.equal(result.summary.prompts, 1);
  assert.equal(result.summary.cost_per_request, null);
  assert.equal(result.summary.cost_partial, false);
  assert.equal(result.summary.observed_tokens, null);
  assert.equal(result.summary.tokens_partial, false);
  assert.deepEqual(result.metrics, []);
});

test("empty insights expose no costs and a non-partial empty log summary", async () => {
  const result = await codexInsights(from, to, {}, async () => []);
  assert.equal(result.coverage.logs.status, "empty");
  assert.equal(result.summary.cost_per_request, null);
  assert.equal(result.summary.cost_per_session, null);
  assert.equal(result.summary.cost_partial, false);
  assert.equal(result.summary.observed_tokens, null);
  assert.equal(result.summary.tokens_partial, false);
});

test("stream-only scopes keep available tokens and costs partial", async () => {
  const result = await codexInsights(from, to, {}, async sql => diagnostic(sql) ? [] : [
    ...usageRows,
    row("scope", ["stream-only", "", "bedrock-mantle", "", "openai.gpt-6-astra", ""],
      { has_bulk: 1, requires_usage: 1 }),
  ]);
  assert.equal(result.summary.cost_per_request, 0.00238425);
  assert.equal(result.summary.cost_per_session, 0.001192125);
  assert.equal(result.summary.cost_partial, true);
  assert.equal(result.summary.tokens_per_request, null);
  assert.equal(result.summary.observed_tokens, 130);
  assert.equal(result.summary.tokens_partial, true);
  assert.equal(result.effort[0].cost_partial, false);
  assert.equal(result.effort[0].tokens, 130);
  assert.equal(result.effort[0].tokens_partial, false);
});

test("network/permissions/query failures surface rather than pretending telemetry is unsupported", async () => {
  await assert.rejects(codexInsights(from, to, {}, async () => { throw new Error("transport"); }), /transport/);
  await assert.rejects(codexInsights(from, to, {}, async sql => {
    if (sql.includes("codex_metrics_")) throw { code: "497" };
    return [];
  }), error => error.code === "497");
});

test("invalid and Claude-only selectors are rejected before any query", async () => {
  for (const raw of [{ client: "claude" }, { group: "enterprise" }, { project: "example" }, { backend: "invalid" }]) {
    let calls = 0;
    await assert.rejects(codexInsights(from, to, raw, async () => { calls++; return []; }));
    assert.equal(calls, 0);
  }
});

test("a limited operational table cannot hide independently aggregated usage or diagnostic feeds", async () => {
  const result = await codexInsights(from, to, {}, async sql => {
    if (sql.includes("codex_metrics_")) return [];
    if (sql.includes("FROM claude_code.otel_traces")) return [{
      timestamp: "2026-09-15 00:01:00", trace_id: "one", span_id: "two", name: "turn", duration_ns: 1000000,
    }];
    return [...usageRows, ...Array.from({ length: 50001 }, (_, n) => row("tool", [`tool${n}`]))];
  });
  assert.equal(result.coverage.logs.status, "observed");
  assert.equal(result.coverage.logs.partial, true);
  assert.deepEqual(result.coverage.logs.limited_sections, ["tool"]);
  assert.equal(result.summary.observed_tokens, 130);
  assert.equal(result.summary.cost_per_request, 0.00238425);
  assert.equal(result.summary.tool_success_rate, null);
  assert.deepEqual(result.tools, []);
  assert.equal(result.traces[0].wall_ms, 1);
});

test("limited scope evidence retains known usage while withholding complete ratios and session units", async () => {
  const result = await codexInsights(from, to, {}, async sql => diagnostic(sql) ? [] : [
    ...usageRows, ...Array.from({ length: 50001 }, (_, n) =>
      row("scope", [`session${n}`, "", "bedrock-mantle", "", "model", ""], { requires_usage: 1 })),
  ]);
  assert.equal(result.summary.observed_tokens, 130);
  assert.equal(result.summary.tokens_partial, true);
  assert.equal(result.summary.tokens_per_request, null);
  assert.equal(result.summary.cache_hit_rate, null);
  assert.equal(result.summary.cost_per_request, 0.00238425);
  assert.equal(result.summary.cost_per_session, null);
  assert.equal(result.summary.cost_partial, true);
});

test("limited usage aggregates never present the truncated subtotal as complete or as measured zero", async () => {
  const result = await codexInsights(from, to, {}, async sql => diagnostic(sql) ? [] : [
    ...usageRows, ...Array.from({ length: 50001 }, (_, n) => row("usage", [`effort${n}`])),
  ]);
  assert.equal(result.summary.observed_tokens, null);
  assert.equal(result.summary.tokens_partial, true);
  assert.equal(result.summary.cost_per_request, null);
  assert.equal(result.summary.cost_partial, true);
  assert.equal(result.effort[0].observed_tokens, 130, "independent effort evidence is retained");
});

test("a capped effort family keeps independently computed totals available", async () => {
  const result = await codexInsights(from, to, {}, async sql => diagnostic(sql) ? [] : [
    ...usageRows.filter(r => r.family !== "effort"),
    row("effort", ["discarded"], { family_limited: 1 }),
  ]);
  assert.equal(result.summary.observed_tokens, 130);
  assert.equal(result.summary.tokens_partial, false);
  assert.equal(result.summary.cost_per_request, 0.00238425);
  assert.deepEqual(result.effort, []);
  assert.deepEqual(result.coverage.logs.limited_sections, ["effort"]);
});

test("oversized metric results do not suppress available log observations", async () => {
  const result = await codexInsights(from, to, {}, async sql => {
    if (sql.includes("codex_metrics_sum")) return Array.from({ length: 50001 }, () => ({}));
    return diagnostic(sql) ? [] : promptRows;
  });
  assert.equal(result.coverage.metrics.status, "limited");
  assert.equal(result.coverage.metrics.records, null);
  assert.deepEqual(result.metrics, []);
  assert.equal(result.summary.prompts, 1);
});

test("aggregate query failures remain visible instead of manufacturing complete log coverage", async () => {
  await assert.rejects(codexInsights(from, to, {}, async sql => {
    if (!diagnostic(sql)) throw new Error("aggregate transport failure");
    return [];
  }), /aggregate transport failure/);
});
