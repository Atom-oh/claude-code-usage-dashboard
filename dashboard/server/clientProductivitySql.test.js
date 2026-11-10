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
  const identity = `productivity-${randomUUID()}`, many = `tools-${randomUUID()}`;
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
    ["claude_code.session.count", "", 1, 2],
    ["claude_code.code_edit_tool.decision", "", 0, 3, { decision: "accept", tool_name: "Edit" }],
    ["claude_code.code_edit_tool.decision", "", 0, 1, { decision: "reject", tool_name: "Edit" }],
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
    claudeLog("tool_result", { success: "true", tool_name: "Bash", duration_ms: "100" }),
    claudeLog("tool_result", { success: "true", tool_name: "Bash", duration_ms: "300" }),
    claudeLog("tool_result", { success: "false", tool_name: "Edit", duration_ms: "bad" }),
    claudeLog("tool_result", { success: "true", error: "boom", tool_name: "Edit", duration_ms: "50" }),
    claudeLog("tool_result"),
    claudeLog("tool_decision", { decision: "accept", tool_name: "Bash", source: "user_temporary" }),
    claudeLog("tool_decision", { decision: "accept", tool_name: "Bash", source: "config" }),
    claudeLog("tool_decision", { decision: "reject", tool_name: "Bash", source: "user_reject" }),
    claudeLog("tool_decision", { decision: "other", tool_name: "Edit" }),
    // Twelve more tools for another identity: ten keep rows, two fold into the remainder.
    ...Array.from({ length: 12 }, (_, i) => Array.from({ length: 13 - i }, () => claudeLog("tool_result",
      { success: "true", tool_name: `tool-${String(i).padStart(2, "0")}`, duration_ms: String(i) },
      { "user.email": `${many}@example.test` }))).flat(),
    claudeLog("user_prompt", {}, { "user.email": `${identity}-other@example.test` }),
    codexLog("codex.sse_event", { ...codexModel, "event.kind": "response.completed" }),
    codexLog("codex.user_prompt"), codexLog("codex.user_prompt"), codexLog("codex.user_prompt"),
    codexLog("codex.tool_result", { ...codexModel, success: "true", tool_name: "shell", duration_ms: "20" }),
    codexLog("codex.tool_result", { ...codexModel, success: "true", tool_name: "shell", duration_ms: "40" }),
    codexLog("codex.tool_result", { ...codexModel, success: "false", tool_name: "shell", duration_ms: "x" }),
    codexLog("codex.tool_result", { ...codexModel, tool_name: "apply_patch" }),
    codexLog("codex.tool_decision", { ...codexModel, decision: "approved", tool_name: "shell", source: "Config" }),
    codexLog("codex.tool_decision", { ...codexModel, decision: "approved_for_session", tool_name: "shell", source: "User" }),
    codexLog("codex.tool_decision", { ...codexModel, decision: "denied", tool_name: "shell", source: "User" }),
    codexLog("codex.tool_decision", { ...codexModel, decision: "abort", tool_name: "apply_patch" }),
    ...["50", "10", "30", "invalid"].map((ms) => codexLog("codex.turn_ttft", { ...codexModel, duration_ms: ms })),
  ];
  const span = (id, ttft, extra = {}) => ({
    Timestamp: `${day} 10:07:00`, TraceId: `${identity}-trace`, SpanId: id,
    ResourceAttributes: { "user.email": claudeUser },
    SpanAttributes: { "session.id": claudeSession, "span.type": "llm_request", ...(ttft === null ? {} : { ttft_ms: ttft }), ...extra },
    Duration: 1000000,
  });
  const wait = (id, ms) => span(id, null, { "span.type": "tool.blocked_on_user", duration_ms: ms });
  const spans = [span("a", "100"), span("b", "300"), span("c", "200"), span("d", "400"), span("d", "400"), span("e", null),
    wait("w1", "500"), wait("w2", "1500"), wait("w2", "1500"), wait("w3", "x")];
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

    // Per-tool rows use the totals' definitions; the most frequent source wins (ties by name)
    // and a missing source or tool name stays "". Tuples: tool, count, ok/allowed, bad/denied,
    // unknown, then samples and p50 (results) or source and its count (decisions).
    const results = (row) => row.by_tool_results.map((r) => [r.tool, r.calls, r.successes, r.failures, r.unknown, r.duration_samples, r.duration_p50_ms]);
    const decisions = (row) => row.by_tool_decisions.map((r) => [r.tool, r.decisions, r.allowed, r.denied, r.unknown, r.source, r.source_decisions]);
    assert.deepEqual(results(claude), [["Bash", 2, 2, 0, 0, 2, 100], ["Edit", 2, 0, 2, 0, 1, 50], ["", 1, 0, 0, 1, 0, null]]);
    assert.deepEqual(decisions(claude), [["Bash", 3, 2, 1, 0, "config", 1], ["Edit", 1, 0, 0, 1, "", 1]]);
    assert.deepEqual(results(codex), [["shell", 3, 2, 1, 0, 2, 20], ["apply_patch", 1, 0, 0, 1, 0, null]]);
    assert.deepEqual(decisions(codex), [["shell", 3, 2, 1, 0, "User", 2], ["apply_patch", 1, 0, 0, 1, "", 1]]);

    // Latency: nearest-rank lower quantiles; deduplicated wait spans; invalid values are not zero.
    assert.deepEqual([claude.ttft_p90_ms, claude.permission_wait_samples, claude.permission_wait_p50_ms], [400, 2, 500]);
    assert.deepEqual([codex.ttft_p90_ms, codex.permission_wait_p50_ms, codex.unavailable.permission_wait_p50_ms],
      [50, null, "not_aggregated"]);

    // Activity index: userLeaderboard inputs under the shared scope.
    assert.deepEqual(claude.top_users, [{ user: claudeUser, productivity_score: 66.3, accept_rate: 0.75, loc_added: 100,
      commits: 3, sessions: 1, active_days: 1, decisions: 4 }]);
    assert.deepEqual([claude.activity_index_users, claude.activity_index_scored], [1, 1]);
    assert.deepEqual([codex.top_users, codex.unavailable.top_users], [null, "not_derived"]);

    // Ten tools keep rows; the remainder folds two tools with an exact p50 over their calls.
    const tools = (await clientProductivity(from, to, { user: many }, ["claude"])).by_client[0].by_tool_results;
    assert.equal(tools.length, 11);
    assert.deepEqual(tools.slice(0, 10).map((row) => row.tool), Array.from({ length: 10 }, (_, i) => `tool-${String(i).padStart(2, "0")}`));
    assert.deepEqual([tools[10].tool, tools[10].other, tools[10].tools, tools[10].calls, tools[10].duration_p50_ms],
      [null, true, 2, 5, 10]);

    // The hourly rollup path keeps the process-start increase without inventing a baseline.
    const wide = await rows({}, new Date(+from - 5 * 3600000), to);
    assert.equal(wide.claude.active_user_seconds, 400);
    assert.equal(wide.claude.loc_added, 110);
    assert.equal(wide.claude.top_users[0].loc_added, 110);
    assert.equal(wide.claude.top_users[0].active_days, 1);

    // Model-less prompts follow their session's model evidence; a non-matching model selects nothing.
    const gpt = await rows({ model: "gpt-6" });
    assert.equal(gpt.codex.prompts, 3);
    assert.equal(gpt.claude.prompts, 0);
    assert.equal(gpt.claude.commits, null);
    assert.deepEqual([gpt.claude.top_users, gpt.claude.by_tool_results, gpt.claude.permission_wait_samples], [[], [], 0]);
    assert.equal(gpt.codex.by_tool_results[0].calls, 3);
    const sonnet = await rows({ model: "sonnet", backend: "anthropic" });
    assert.equal(sonnet.claude.prompts, 3);
    assert.equal(sonnet.claude.loc_added, 100);
    assert.equal(sonnet.claude.top_users.length, 1);
    assert.equal(sonnet.claude.permission_wait_p50_ms, 500);
    assert.deepEqual(sonnet.codex.by_tool_decisions, []);
    assert.equal(sonnet.codex.prompts, 0);
    const runtime = await rows({ backend: "bedrock-runtime" });
    assert.equal(runtime.claude.tool_calls, 0);
    assert.equal(runtime.codex.tool_calls, 0);
    assert.deepEqual([runtime.claude.by_tool_decisions, runtime.claude.top_users, runtime.codex.by_tool_results], [[], [], []]);
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
    assert.deepEqual([otherTeam.claude.top_users, otherTeam.claude.by_tool_results, otherTeam.codex.by_tool_decisions], [[], [], []]);
    assert.equal(team.claude.top_users[0].user, claudeUser);
    assert.equal((await rows({ userExact: `${identity}-other@example.test` })).claude.top_users.length, 0);
  } finally {
    await db.close();
  }
});
