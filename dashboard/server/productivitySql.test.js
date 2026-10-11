import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

test("productivity queries preserve matched scopes, explicit outcomes and trace intervals in ClickHouse", {
  skip: !process.env.PRODUCTIVITY_SQL_TEST_URL,
}, async () => {
  process.env.CH_URL = process.env.PRODUCTIVITY_SQL_TEST_URL;
  process.env.CH_USER = "default";
  process.env.CH_PASSWORD = "";
  const { createClient } = await import("@clickhouse/client");
  const db = createClient({ url: process.env.CH_URL, database: "claude_code" });
  const { activityDensity, toolOutcomes, permissionWaitOccupancy, kpiSummary, activeTimeSummary } = await import("./queries.js");
  const day = new Date().toISOString().slice(0, 10);
  const from = new Date(`${day}T10:00:00Z`);
  const to = new Date(`${day}T11:00:00Z`);
  const metrics = [];
  const identity = `productivity-fixture-${randomUUID()}`;
  const user = `${identity}@example.invalid`;
  const counter = (session, metric, type, clock, value, temporality = 2, email = user) => ({
    ResourceAttributes: { "user.email": email },
    Attributes: { "session.id": session, "organization.id": "fixture", type },
    MetricName: metric, StartTimeUnix: `${day} 08:00:00`, TimeUnix: `${day} ${clock}`,
    Value: value, AggregationTemporality: temporality, IsMonotonic: true,
  });
  const pair = (session, metric, before, after, email = user) => {
    const name = metric === "commits" ? "claude_code.commit.count" : "claude_code.active_time.total";
    const type = metric === "commits" ? "" : "user";
    metrics.push(counter(session, name, type, "09:59:00", before, 2, email));
    if (after != null) metrics.push(counter(session, name, type, "10:30:00", after, 2, email));
  };
  pair("density-matched", "commits", 10, 14);
  pair("density-matched", "time", 100, 7300);
  pair("density-zero", "commits", 5, 5);
  pair("density-zero", "time", 100, 3700);
  pair("density-missing-time", "commits", 1, 100);
  pair("density-missing-commit", "time", 0, 3600);
  pair("density-stale-commit", "commits", 9, null);
  pair("density-stale-commit", "time", 100, 3700);
  pair("density-zero-time", "commits", 0, 5);
  pair("density-zero-time", "time", 100, 100);
  pair("density-mixed-users", "commits", 0, 100);
  pair("density-mixed-users", "time", 0, 3600, `${identity}-other@example.invalid`);
  const modelEvidence = counter("density-matched", "claude_code.token.usage", "input", "10:30:00", 10);
  metrics.push({ ...modelEvidence, Attributes: { ...modelEvidence.Attributes, model: "claude-sonnet-5" } });
  for (const [clock, commits] of [["10:10:00", 2], ["10:20:00", 4]]) {
    metrics.push(counter("density-delta", "claude_code.commit.count", "", clock, commits, 1));
    metrics.push(counter("density-delta", "claude_code.active_time.total", "user", clock, 3600, 1));
  }
  const log = (offset, attributes) => ({
    Timestamp: `${day} 10:01:0${offset}`,
    ResourceAttributes: { "user.email": user },
    LogAttributes: { "event.name": "tool_result", "session.id": "density-matched", tool_name: "Read", ...attributes },
  });
  const trace = (id, type, timestamp, duration) => ({
    Timestamp: `${day} ${timestamp}`, TraceId: "density-trace", SpanId: id,
    ResourceAttributes: { "user.email": user },
    SpanAttributes: { "session.id": "density-matched", "span.type": type },
    Duration: duration * 1000000,
  });
  try {
    await db.insert({ table: "otel_metrics_sum", values: metrics, format: "JSONEachRow" });
    await db.insert({ table: "otel_logs", values: [
      log(0, { success: "true" }), log(1, { success: "false" }),
      log(2, { success: "true", error: "fixture failure" }),
      log(3, {}), log(4, { "event.name": "claude_code.tool_result", success: "unrecognized" }),
    ], format: "JSONEachRow" });
    await db.insert({ table: "otel_traces", values: [
      trace("root", "interaction", "10:10:00", 10000),
      trace("wait-first", "tool.blocked_on_user", "10:10:01", 4000),
      trace("wait-second", "tool.blocked_on_user", "10:10:03", 4000),
      trace("wait-second", "tool.blocked_on_user", "10:10:03", 4000),
    ], format: "JSONEachRow" });
    const filters = { user: identity, group: "enterprise" };
    for (const start of [from, new Date(+from - 5 * 3600000)]) {
      const [density] = await activityDensity(start, to, filters);
      if (+start === +from) {
        assert.equal(Number(density.observed_scopes), 9);
        assert.equal(Number(density.matched_scopes), 3);
        assert.equal(Number(density.matched_commits), 10);
        assert.equal(Number(density.user_hours), 5);
        assert.equal(Number(density.commits_per_user_hour), 2);
      } else {
        assert.ok(Number(density.matched_scopes) >= 3);
        assert.ok(Number.isFinite(Number(density.commits_per_user_hour)));
      }
    }
    const [outcomes] = await toolOutcomes(from, to, filters);
    assert.equal(Number(outcomes.total), 5);
    assert.equal(Number(outcomes.succeeded), 1);
    assert.equal(Number(outcomes.failed), 2);
    assert.equal(Number(outcomes.unknown), 2);
    assert.equal(outcomes.success_rate, 1 / 3);
    const occupancy = await permissionWaitOccupancy(from, to, filters);
    assert.equal(occupancy.rows[0].blocked_share, 0.6);
    assert.equal(occupancy.rows[0].blocked_ms, 6000);
    const [modelDensity] = await activityDensity(from, to, { ...filters, model: "claude-sonnet-5" });
    assert.equal(Number(modelDensity.matched_scopes), 1);
    assert.equal(Number(modelDensity.commits_per_user_hour), 2);
    assert.equal(Number((await toolOutcomes(from, to, { ...filters, model: "claude-sonnet-5" }))[0].total), 5);
    assert.equal((await permissionWaitOccupancy(from, to, { ...filters, model: "claude-sonnet-5" })).rows[0].blocked_share, 0.6);
    assert.deepEqual(await activityDensity(from, to, { ...filters, model: "unmatched-model" }), []);
    assert.deepEqual(await activityDensity(from, to, { user: "' OR 1=1" }), []);
    assert.deepEqual(await toolOutcomes(from, to, { group: "bedrock", user: identity }), []);
    const [missing] = await activityDensity(from, to, { user: `${identity}-other` });
    assert.equal(missing.commits_per_user_hour, null);
    assert.equal(missing.matched_commits, null);
    for (const observed of [false, true]) {
      const email = `${identity}-observation-${observed}@example.invalid`;
      const values = [counter("observation", "claude_code.session.count", "", "10:30:00", 1, 2, email)];
      for (const [metric, type] of [["claude_code.pull_request.count", ""],
        ["claude_code.commit.count", ""], ["claude_code.lines_of_code.count", "added"],
        ["claude_code.active_time.total", "user"]]) {
        values.push(counter("observation", metric, type, "10:01:00", 0, 2, email));
        if (observed) values.push(counter("observation", metric, type, "10:30:00", 0, 2, email));
      }
      await db.insert({ table: "otel_metrics_sum", values, format: "JSONEachRow" });
      for (const end of [to, new Date(`${day}T16:00:00Z`)]) {
        const start = new Date(`${day}T10:15:00Z`);
        const [kpi] = await kpiSummary(start, end, { user: email });
        assert.equal(Number(kpi.prs), 0);
        for (const field of ["prs_observed", "lines_of_code_observed", "commits_observed"])
          assert.equal(Number(kpi[field]), Number(observed), `${field}: ${end}`);
        const [active] = await activeTimeSummary(start, end, { user: email });
        assert.equal(Number(active.user_seconds), 0);
        assert.equal(Number(active.user_seconds_observed), Number(observed));
        assert.equal(Number(active.cli_seconds_observed), 0);
      }
    }
  } finally {
    await db.close();
  }
});
