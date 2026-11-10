import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

test("shared productivity rows honor shared filters, deduplication and counter increases in ClickHouse", {
  skip: !process.env.CLIENT_PRODUCTIVITY_SQL_TEST_URL,
}, async () => {
  process.env.CH_URL = process.env.CLIENT_PRODUCTIVITY_SQL_TEST_URL;
  process.env.CH_USER = "default";
  process.env.CH_PASSWORD = "";
  const { createClient } = await import("@clickhouse/client");
  const db = createClient({ url: process.env.CH_URL, database: "claude_code" });
  const { clientProductivity } = await import("./clientProductivity.js");
  const day = new Date().toISOString().slice(0, 10);
  const from = new Date(`${day}T10:00:00Z`), to = new Date(`${day}T11:00:00Z`);
  const identity = `productivity-${randomUUID()}`;
  const claudeUser = `${identity}-claude@example.test`, codexUser = `${identity}-codex@example.test`;
  const claudeSession = `${identity}-claude-session`, codexSession = `${identity}-codex-session`;
  const counter = (metric, type, clock, value, extra = {}) => ({
    ResourceAttributes: { "user.email": claudeUser },
    Attributes: { "session.id": claudeSession, "organization.id": "fixture", type, ...extra },
    MetricName: metric, StartTimeUnix: `${day} 08:00:00`, TimeUnix: `${day} ${clock}`,
    Value: value, AggregationTemporality: 2, IsMonotonic: true,
  });
  const metrics = [];
  for (const [metric, type, before, after, extra] of [
    ["claude_code.token.usage", "input", 100, 150, { model: "claude-sonnet-5" }],
    ["claude_code.active_time.total", "user", 100, 400],
    ["claude_code.active_time.total", "cli", 0, 60],
    ["claude_code.commit.count", "", 2, 5],
    ["claude_code.pull_request.count", "", 0, 1],
    ["claude_code.lines_of_code.count", "added", 10, 110],
    ["claude_code.lines_of_code.count", "removed", 0, 20],
  ]) {
    metrics.push(counter(metric, type, "09:59:00", before, extra), counter(metric, type, "10:30:00", after, extra));
  }
  let n = 0;
  const claudeLog = (name, attributes = {}, resource = {}) => ({
    Timestamp: `${day} 10:05:00.${String(++n).padStart(9, "0")}`,
    ResourceAttributes: { "user.email": claudeUser, team: "alpha", ...resource },
    LogAttributes: { "event.name": name, "session.id": claudeSession, ...attributes },
  });
  const codexLog = (name, attributes = {}) => ({
    Timestamp: `${day} 10:06:00.${String(++n).padStart(9, "0")}`,
    ResourceAttributes: { "user.email": codexUser, backend: "bedrock-mantle", team: "alpha" },
    LogAttributes: { "event.name": name, "conversation.id": codexSession, ...attributes },
  });
  const prompt = claudeLog("user_prompt");
  const codexModel = { model: "openai.gpt-6-astra" };
  const logs = [
    prompt, prompt, // An exact duplicate delivery counts once.
    claudeLog("claude_code.user_prompt"),
    claudeLog("tool_result", { success: "true" }), claudeLog("tool_result", { success: "true" }),
    claudeLog("tool_result", { success: "false" }), claudeLog("tool_result", { success: "true", error: "boom" }),
    claudeLog("tool_result"),
    claudeLog("tool_decision", { decision: "accept" }), claudeLog("tool_decision", { decision: "accept" }),
    claudeLog("tool_decision", { decision: "reject" }), claudeLog("tool_decision", { decision: "other" }),
    claudeLog("user_prompt", {}, { "user.email": `${identity}-other@example.test` }),
    codexLog("codex.sse_event", { ...codexModel, "event.kind": "response.completed" }),
    codexLog("codex.user_prompt"), codexLog("codex.user_prompt"), codexLog("codex.user_prompt"),
    codexLog("codex.tool_result", { ...codexModel, success: "true" }),
    codexLog("codex.tool_result", { ...codexModel, success: "true" }),
    codexLog("codex.tool_result", { ...codexModel, success: "false" }),
    codexLog("codex.tool_result", codexModel),
    codexLog("codex.tool_decision", { ...codexModel, decision: "approved" }),
    codexLog("codex.tool_decision", { ...codexModel, decision: "approved_for_session" }),
    codexLog("codex.tool_decision", { ...codexModel, decision: "denied" }),
    codexLog("codex.tool_decision", { ...codexModel, decision: "abort" }),
    ...["50", "10", "30", "invalid"].map((ms) => codexLog("codex.turn_ttft", { ...codexModel, duration_ms: ms })),
  ];
  const span = (id, ttft, extra = {}) => ({
    Timestamp: `${day} 10:07:00`, TraceId: `${identity}-trace`, SpanId: id,
    ResourceAttributes: { "user.email": claudeUser },
    SpanAttributes: { "session.id": claudeSession, "span.type": "llm_request", ...(ttft === null ? {} : { ttft_ms: ttft }), ...extra },
    Duration: 1000000,
  });
  const spans = [span("a", "100"), span("b", "300"), span("c", "200"), span("d", "400"), span("d", "400"), span("e", null)];
  try {
    await db.insert({ table: "otel_metrics_sum", values: metrics, format: "JSONEachRow" });
    await db.insert({ table: "otel_logs", values: logs, format: "JSONEachRow" });
    await db.insert({ table: "otel_traces", values: spans, format: "JSONEachRow" });
    const rows = async (raw, start = from, end = to) => {
      const result = await clientProductivity(start, end, { user: identity, ...raw }, ["claude", "codex"]);
      return Object.fromEntries(result.by_client.map((row) => [row.client, row]));
    };
    const { claude, codex } = await rows({});
    assert.deepEqual({ prompts: claude.prompts, tool_calls: claude.tool_calls, tool_successes: claude.tool_successes,
      tool_failures: claude.tool_failures, tool_unknown: claude.tool_unknown, decisions_total: claude.decisions_total,
      decisions_allowed: claude.decisions_allowed, decisions_denied: claude.decisions_denied },
    { prompts: 3, tool_calls: 5, tool_successes: 2, tool_failures: 2, tool_unknown: 1,
      decisions_total: 4, decisions_allowed: 2, decisions_denied: 1 });
    assert.equal(claude.ttft_samples, 4);
    assert.equal(claude.ttft_p50_ms, 200); // Nearest-rank lower median of four spans.
    assert.deepEqual({ active_user_seconds: claude.active_user_seconds, active_cli_seconds: claude.active_cli_seconds,
      commits: claude.commits, prs: claude.prs, loc_added: claude.loc_added, loc_removed: claude.loc_removed },
    { active_user_seconds: 300, active_cli_seconds: 60, commits: 3, prs: 1, loc_added: 100, loc_removed: 20 });
    assert.deepEqual({ prompts: codex.prompts, tool_calls: codex.tool_calls, tool_successes: codex.tool_successes,
      tool_failures: codex.tool_failures, decisions_total: codex.decisions_total,
      decisions_allowed: codex.decisions_allowed, decisions_denied: codex.decisions_denied,
      ttft_samples: codex.ttft_samples, ttft_p50_ms: codex.ttft_p50_ms },
    { prompts: 3, tool_calls: 4, tool_successes: 2, tool_failures: 1, decisions_total: 4,
      decisions_allowed: 2, decisions_denied: 1, ttft_samples: 3, ttft_p50_ms: 30 });
    assert.equal(codex.commits, null);
    assert.equal(codex.unavailable.commits, "not_collected");

    // The hourly rollup path keeps the process-start increase without inventing a baseline.
    const wide = await rows({}, new Date(+from - 5 * 3600000), to);
    assert.equal(wide.claude.active_user_seconds, 400);
    assert.equal(wide.claude.loc_added, 110);

    // Model-less prompts follow their session's model evidence; a non-matching model selects nothing.
    const gpt = await rows({ model: "gpt-6" });
    assert.equal(gpt.codex.prompts, 3);
    assert.equal(gpt.claude.prompts, 0);
    assert.equal(gpt.claude.commits, null);
    const sonnet = await rows({ model: "sonnet", backend: "anthropic" });
    assert.equal(sonnet.claude.prompts, 3);
    assert.equal(sonnet.claude.loc_added, 100);
    assert.equal(sonnet.codex.prompts, 0);
    const runtime = await rows({ backend: "bedrock-runtime" });
    assert.equal(runtime.claude.tool_calls, 0);
    assert.equal(runtime.codex.tool_calls, 0);
    assert.equal((await rows({ backend: "bedrock-mantle" })).codex.tool_calls, 4);
    assert.equal((await rows({ modelExact: "openai.gpt-6-astra" })).codex.prompts, 3);

    assert.equal((await rows({ userExact: claudeUser })).claude.prompts, 2);
    assert.equal((await rows({ user: `${identity}-other` })).claude.prompts, 1);
    const team = await rows({ team: "alpha" });
    assert.equal(team.claude.prompts, 3);
    assert.equal(team.codex.prompts, 3);
    const otherTeam = await rows({ team: "beta" });
    assert.equal(otherTeam.claude.prompts, 0);
    assert.equal(otherTeam.codex.prompts, 0);
    assert.equal(otherTeam.claude.loc_added, null);
    assert.equal(otherTeam.claude.ttft_p50_ms, null);
  } finally {
    await db.close();
  }
});
