import { test } from "node:test";
import assert from "node:assert/strict";
import { codexInsights } from "./codexInsights.js";

const from = new Date("2026-09-15T00:00:00Z"), to = new Date("2026-09-15T01:00:00Z");
test("missing optional signal tables do not hide existing logs or manufacture observations", async () => {
  const result = await codexInsights(from, to, {}, async (sql) => {
    if (sql.includes("codex_metrics_") || sql.includes("FROM claude_code.otel_traces")) throw { code: "60" };
    return [{ timestamp: "2026-09-15T00:01:00Z", resource: {},
      attributes: { "event.name": "codex.user_prompt", prompt_length: "10" } }];
  });
  assert.equal(result.coverage.logs.status, "observed");
  assert.equal(result.coverage.metrics.status, "unavailable");
  assert.equal(result.coverage.traces.status, "unavailable");
  assert.equal(result.summary.prompts, 1);
  assert.equal(result.summary.cost_per_request, null);
  assert.deepEqual(result.metrics, []);
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
