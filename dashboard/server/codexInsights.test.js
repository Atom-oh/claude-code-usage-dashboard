import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("configured diagnostic states activate for covered diagnostic and hybrid effort ranges and remain required logs", () => {
  const script = `
    import assert from "node:assert/strict";
    import { codexInsights } from "./codexInsights.js";
    const from = new Date("2026-10-01T00:00:15Z"), to = new Date("2026-10-26T00:00:45Z");
    const selected = [];
    for (const profile of [undefined, "effort", "tools", "performance"]) {
      const queries = [];
      const result = await codexInsights(from, to, { profile }, async sql => { queries.push(sql); return []; });
      selected.push({ profile: profile || "default", queries: queries.length,
        states: queries.some(sql => sql.includes("codex_diagnostic_events_v1")),
        metrics: result.coverage.metrics.status, traces: result.coverage.traces.status });
    }
    let uncovered;
    await codexInsights(new Date(+from - 1), to, { profile: "tools" }, async sql => { uncovered = sql; return []; });
    assert.ok(uncovered.includes("FROM claude_code.otel_logs"));
    const missingState = Object.assign(new Error("missing verified state table"), { code: "60" });
    await assert.rejects(codexInsights(from, to, { profile: "tools" }, async () => { throw missingState; }),
      error => error === missingState);
    console.log(JSON.stringify(selected));`;
  const results = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, CODEX_DIAGNOSTIC_READ_FROM: "2026-10-01T00:00:15Z" },
    encoding: "utf8",
  }));
  assert.deepEqual(results, [
    { profile: "default", queries: 6, states: false, metrics: "empty", traces: "empty" },
    { profile: "effort", queries: 1, states: true, metrics: "not_requested", traces: "not_requested" },
    { profile: "tools", queries: 1, states: true, metrics: "not_requested", traces: "not_requested" },
    { profile: "performance", queries: 5, states: true, metrics: "empty", traces: "not_requested" },
  ]);
});

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

test("Effort profile queries only logs and preserves billing summaries without unrequested diagnostics", async () => {
  const queries = [];
  const run = async sql => { queries.push(sql); return diagnostic(sql) ? [] : usageRows; };
  const full = await codexInsights(from, to, {}, run);
  assert.equal(queries.length, 6);
  queries.length = 0;
  const selected = await codexInsights(from, to, { profile: "effort" }, run);
  assert.equal(queries.length, 1);
  assert.ok(!diagnostic(queries[0]));
  assert.doesNotMatch(queries[0], /quantilesExactWeightedIf|startup_phase:|tuple\('tool'|tuple\('latency'/);
  const { tool_success_rate, ...expected } = full.summary;
  assert.deepEqual(selected.summary, expected);
  assert.deepEqual(selected.effort, full.effort);
  assert.deepEqual(selected.events, full.events);
  assert.equal(selected.coverage.metrics.status, "not_requested");
  assert.equal(selected.coverage.metrics.records, null);
  assert.equal(selected.coverage.traces.status, "not_requested");
  assert.equal(selected.profile, "effort");
  for (const name of ["tools", "approvals", "latency", "runtime"])
    assert.equal(name in selected, false);
});

const diagnosticRows = [
  row("event", ["codex.tool_result"], { records: 4 }),
  row("event", ["codex.api_request"], { records: 2 }),
  row("operations", [], { requests: 2, retries: 1, errors: 1, approved: 3, denied: 1 }),
  row("tool", ["shell"], { records: 4, successes: 3, failures: 1, unknown_outcomes: 0,
    duration_count: 4, average_ms: 25, percentiles: [20, 40] }),
  row("approval", ["shell", "approved", "user"], { records: 3 }),
  row("approval", ["shell", "denied", "user"]),
  row("latency", ["api_request"], { records: 2, duration_count: 2,
    average_ms: 50, percentiles: [40, 60], max_ms: 60 }),
];
const performanceNames = ["codex.turn.e2e_duration_ms", "codex.turn.ttft.duration_ms",
  "codex.turn.tool.call", "codex.turn.token_usage"];

test("tools profile preserves tool durations, decisions and log coverage with one log query", async () => {
  const requests = [];
  const result = await codexInsights(from, to, { profile: "tools" }, async (sql, params) => {
    requests.push({ sql, params });
    return diagnosticRows.filter(r => r.family !== "latency");
  });
  assert.equal(requests.length, 1);
  assert.ok(!diagnostic(requests[0].sql));
  assert.deepEqual(result.summary, { tool_success_rate: 0.75, approval_rate: 0.75 });
  assert.deepEqual(result.tools, [{ tool: "shell", calls: 4, successes: 3, failures: 1, unknown: 0,
    success_rate: 0.75, average_ms: 25, p95_ms: 40 }]);
  assert.deepEqual(result.approvals.map(r => [r.decision, r.count]), [["approved", 3], ["denied", 1]]);
  assert.equal(result.coverage.logs.records, 6);
  assert.deepEqual(result.coverage.logs.omitted_sections, ["usage", "effort", "scope", "latency", "runtime"]);
  assert.equal(result.profile, "tools");
  for (const signal of ["metrics", "traces"])
    assert.deepEqual(result.coverage[signal], { status: "not_requested", records: null, last_seen: null });
  for (const section of ["completion_usage", "completeness", "effort", "latency", "runtime"])
    assert.equal(section in result, false, section);
});

test("performance profile preserves request outcomes and latency while selecting all four metric types", async () => {
  const requests = [];
  const result = await codexInsights(from, to, { profile: "performance", user: "fixture", model: "model" },
    async (sql, params) => {
      requests.push({ sql, params });
      if (sql.includes("codex_metrics_")) return [];
      return diagnosticRows.filter(r => !["tool", "approval"].includes(r.family));
    });
  assert.equal(requests.length, 5);
  assert.equal(requests.some(({ sql }) => sql.includes("otel_traces")), false);
  for (const type of ["sum", "gauge", "histogram", "exponential_histogram"]) {
    const request = requests.find(({ sql }) => sql.includes(`FROM claude_code.codex_metrics_${type}\n`));
    assert.ok(request, type);
    assert.deepEqual(request.params.signalMetricNames, performanceNames);
    assert.match(request.sql, /MetricName IN \{signalMetricNames:Array\(String\)\}/);
    assert.equal(request.params.signalUser, "fixture");
    assert.equal(request.params.signalModel, "model");
    if (type !== "gauge") assert.match(request.sql, /INTERVAL 3 DAY/);
  }
  assert.deepEqual(result.summary, { retry_rate: 0.5, api_error_rate: 0.5 });
  assert.deepEqual(result.latency, [{ name: "api_request", count: 2, average_ms: 50,
    p50_ms: 40, p95_ms: 60, max_ms: 60 }]);
  assert.equal(result.coverage.logs.records, 6);
  assert.deepEqual(result.coverage.logs.omitted_sections, ["usage", "effort", "scope", "tool", "approval", "runtime"]);
  assert.equal(result.coverage.metrics.status, "empty");
  assert.equal(result.coverage.traces.status, "not_requested");
  assert.equal(result.profile, "performance");
  for (const section of ["completion_usage", "completeness", "effort", "tools", "approvals", "runtime"])
    assert.equal(section in result, false, section);
});

test("performance profile preserves missing-table, limited and failed metric distinctions", async () => {
  for (const [response, status] of [[{ code: "60" }, "unavailable"], [[{ result_limited: 1 }], "limited"]]) {
    const result = await codexInsights(from, to, { profile: "performance" }, async sql => {
      if (!sql.includes("codex_metrics_")) return [];
      if (!Array.isArray(response)) throw response;
      return response;
    });
    assert.equal(result.coverage.metrics.status, status);
    assert.equal(result.coverage.traces.status, "not_requested");
    assert.equal(result.summary.retry_rate, null);
    assert.equal(result.summary.api_error_rate, null);
  }
  await assert.rejects(codexInsights(from, to, { profile: "performance" }, async sql => {
    if (sql.includes("codex_metrics_")) throw { code: "497" };
    return [];
  }), error => error.code === "497");
});

test("invalid profiles fail before all signal queries", async () => {
  for (const profile of ["", "full", "Effort", ["effort"], true]) {
    let calls = 0;
    await assert.rejects(codexInsights(from, to, { profile }, async () => { calls++; return []; }),
      /invalid profile/);
    assert.equal(calls, 0);
  }
});

test("Effort profile retains missing-usage coverage instead of treating sparse scopes as free", async () => {
  const result = await codexInsights(from, to, { profile: "effort" }, async () => [
    ...usageRows, row("scope", ["unfinished", "", "bedrock-mantle", "", "model", ""],
      { has_bulk: 1, requires_usage: 1 }),
  ]);
  assert.equal(result.summary.cost_partial, true);
  assert.equal(result.summary.tokens_partial, true);
  assert.equal(result.summary.cost_per_request, 0.00238425);
  assert.equal(result.summary.tokens_per_request, null);
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

test("a metric SQL limit marker preserves log usage and discloses limited diagnostics", async () => {
  const result = await codexInsights(from, to, {}, async sql => {
    if (sql.includes("codex_metrics_")) return [{ result_limited: 1 }];
    if (sql.includes("FROM claude_code.otel_traces")) return [];
    return usageRows;
  });
  assert.equal(result.summary.observed_tokens, 130);
  assert.equal(result.summary.cost_per_request, 0.00238425);
  assert.deepEqual(result.metrics, []);
  assert.equal(result.coverage.metrics.status, "limited");
  assert.equal(result.coverage.metrics.records, null);
  assert.equal(result.coverage.metrics.last_seen, null);
  assert.equal(result.coverage.logs.status, "observed");
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
