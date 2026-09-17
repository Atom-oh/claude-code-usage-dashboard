import { test } from "node:test";
import assert from "node:assert/strict";
import { codexInsights } from "./codexInsights.js";

const from = new Date("2026-09-15T00:00:00Z"), to = new Date("2026-09-15T01:00:00Z");
const promptSummary = [
  { is_total: 1, event: "", records: 1, sessions: 0, last_seen: "2026-09-15T00:01:00Z" },
  { is_total: 0, event: "codex.user_prompt", records: 1, duration_count: 0 },
];
test("missing optional signal tables do not hide existing logs or manufacture observations", async () => {
  const result = await codexInsights(from, to, {}, async (sql) => {
    if (sql.includes("codex_metrics_") || sql.includes("FROM claude_code.otel_traces")) throw { code: "60" };
    if (sql.includes("GROUPING SETS")) return promptSummary;
    return [{ timestamp: "2026-09-15T00:01:00Z", resource: {},
      attributes: { "event.name": "codex.user_prompt", prompt_length: "10" } }];
  });
  assert.equal(result.coverage.logs.status, "observed");
  assert.equal(result.coverage.metrics.status, "unavailable");
  assert.equal(result.coverage.traces.status, "unavailable");
  assert.equal(result.summary.prompts, 1);
  assert.equal(result.summary.cost_per_request, null);
  assert.equal(result.summary.cost_partial, false);
  assert.deepEqual(result.metrics, []);
});

test("empty insights expose no costs and a non-partial empty log summary", async () => {
  const result = await codexInsights(from, to, {}, async () => []);
  assert.equal(result.coverage.logs.status, "empty");
  assert.equal(result.summary.cost_per_request, null);
  assert.equal(result.summary.cost_per_session, null);
  assert.equal(result.summary.cost_partial, false);
});

test("insights expose partial detail costs independently of summary counts and diagnostic feeds", async () => {
  const result = await codexInsights(from, to, {}, async (sql) => {
    if (sql.includes("codex_metrics_") || sql.includes("FROM claude_code.otel_traces")) throw { code: "60" };
    if (sql.includes("GROUPING SETS")) return promptSummary;
    const row = { timestamp: "2026-09-15T00:01:00Z", resource: { backend: "bedrock-mantle" } };
    return [
      { ...row, attributes: { "event.name": "codex.sse_event", "event.kind": "response.completed",
        "conversation.id": "priced", model: "openai.gpt-6-astra", input_token_count: "100",
        cached_token_count: "40", cache_write_token_count: "11", output_token_count: "30",
        reasoning_token_count: "10", model_reasoning_effort: "high" } },
      { ...row, attributes: { "event.name": "codex.api_request", "conversation.id": "priced",
        model: "openai.gpt-6-astra", attempt: "0", "http.response.status_code": "200" } },
      { ...row, is_scope: 1, attributes: { "conversation.id": "stream-only" } },
    ];
  });
  assert.equal(result.coverage.logs.records, 1);
  assert.deepEqual(result.events, [{ event: "codex.user_prompt", count: 1 }]);
  assert.equal(result.summary.cost_per_request, 0.00238425);
  assert.equal(result.summary.cost_per_session, 0.001192125);
  assert.equal(result.summary.cost_partial, true);
  assert.equal(result.summary.tokens_per_request, null);
  assert.equal(result.effort[0].cost_partial, false);
});
test("network/permissions/query failures surface rather than pretending telemetry is unsupported", async () => {
  await assert.rejects(codexInsights(from, to, {}, async () => { throw new Error("transport"); }), /transport/);
  await assert.rejects(codexInsights(from, to, {}, async (sql) => {
    if (sql.includes("codex_metrics_")) throw { code: "497" };
    return [];
  }), (error) => error.code === "497");
});
test("invalid and Claude-only selectors are rejected before any query", async () => {
  for (const raw of [{ client: "claude" }, { group: "enterprise" }, { project: "example" }, { backend: "invalid" }]) {
    let calls = 0;
    await assert.rejects(codexInsights(from, to, raw, async () => { calls++; return []; }));
    assert.equal(calls, 0);
  }
});
test("an oversized log window withholds its totals while preserving metric and trace diagnostics", async () => {
  const result = await codexInsights(from, to, {}, async (sql) => {
    if (sql.includes("codex_metrics_")) return [];
    if (sql.includes("FROM claude_code.otel_traces")) return [{
      timestamp: "2026-09-15 00:01:00", trace_id: "one", span_id: "two", name: "turn", duration_ns: 1000000,
    }];
    return Array.from({ length: 50001 }, () => ({}));
  });
  assert.equal(result.coverage.logs.status, "limited");
  assert.equal(result.coverage.logs.records, null);
  assert(Object.values(result.summary).every((value) => value === null));
  assert.equal(result.summary.cost_partial, null);
  assert.deepEqual(result.effort, []);
  assert.equal(result.traces[0].wall_ms, 1);
  assert.equal(result.coverage.traces.status, "observed");
});
test("oversized metric results do not suppress available log observations", async () => {
  const result = await codexInsights(from, to, {}, async (sql) => {
    if (sql.includes("codex_metrics_sum")) return Array.from({ length: 50001 }, () => ({}));
    if (sql.includes("GROUPING SETS")) return promptSummary;
    if (sql.includes("codex_metrics_") || sql.includes("FROM claude_code.otel_traces")) return [];
    return [{ timestamp: "2026-09-15T00:01:00Z", resource: {},
      attributes: { "event.name": "codex.user_prompt", prompt_length: "10" } }];
  });
  assert.equal(result.coverage.metrics.status, "limited");
  assert.equal(result.coverage.metrics.records, null);
  assert.deepEqual(result.metrics, []);
  assert.equal(result.summary.prompts, 1);
});


test("summary query failures remain visible instead of manufacturing complete log coverage", async () => {
  await assert.rejects(codexInsights(from,to,{},async (sql) => {
    if (sql.includes("GROUPING SETS")) throw new Error("summary transport failure");
    return [];
  }), /summary transport failure/);
});
