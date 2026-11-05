import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

test("team cost reconciles with the cost summary and attributes sessions to teams", {
  skip: !process.env.TEAM_COST_SQL_TEST_URL,
}, async () => {
  process.env.CH_URL = process.env.TEAM_COST_SQL_TEST_URL;
  process.env.CH_USER = "default";
  process.env.CH_PASSWORD = "";
  const { createClient } = await import("@clickhouse/client");
  const db = createClient({ url: process.env.CH_URL, database: "claude_code" });
  const q = await import("./queries.js");
  try {
    const id = randomUUID().slice(0, 8);
    const day = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const from = new Date(`${day}T14:00:00Z`), to = new Date(`${day}T15:00:00Z`);
    const T = (name) => `${id}-${name}`;
    const U = (name) => `${name}-${id}@example.invalid`;
    let n = 0;
    const log = (session, user, clock, team, event = "user_prompt") => ({
      Timestamp: `${day} ${clock}.${String(n++).padStart(9, "0")}`,
      ResourceAttributes: { "user.email": user, ...(team ? { team } : {}) },
      LogAttributes: { "event.name": event, "session.id": session },
    });
    const logs = [
      log(T("sa1"), U("u1"), "14:05:00", T("A")), log(T("sa1"), U("u1"), "14:06:00", T("A"), "api_request"),
      log(T("sa1"), U("u1"), "14:07:00", T("A"), "api_request"),
      log(T("sa2"), U("u2"), "14:08:00", T("A")), log(T("sa2"), U("u2"), "14:09:00", T("A"), "api_request"),
      log(T("sb"), U("u3"), "14:10:00", T("B")), log(T("sb"), U("u3"), "14:11:00", T("B"), "api_request"),
      log(T("snone"), U("u4"), "14:12:00", null),
    ];
    // sa2 carries no model or organization evidence, so its channel is unknown.
    const counter = (session, user, metric, type, clock, value, { org = true, model = "claude-sonnet-5" } = {}) => ({
      ResourceAttributes: { "user.email": user },
      Attributes: { "session.id": session, ...(org ? { "organization.id": "fixture" } : {}), ...(model ? { model } : {}), type },
      MetricName: metric, StartTimeUnix: `${day} 13:00:00`, TimeUnix: `${day} ${clock}`,
      Value: value, AggregationTemporality: 2, IsMonotonic: true,
    });
    const metrics = [];
    for (const [session, user, cost, opts] of [[T("sa1"), U("u1"), 2], [T("sa2"), U("u2"), 1, { org: false, model: "" }],
      [T("sb"), U("u3"), 4], [T("snone"), U("u4"), 8]])
      for (const [metric, type, a, b] of [["claude_code.token.usage", "input", 100, 100 + cost * 10],
        ["claude_code.cost.usage", "", 1, 1 + cost]])
        for (const [clock, value] of [["13:59:00", a], ["14:30:00", b]])
          metrics.push(counter(session, user, metric, type, clock, value, opts));
    // A team active only in the three-day counter lookback is not active in the range.
    const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    logs.push({ Timestamp: `${prev} 09:00:00.000000001`, ResourceAttributes: { "user.email": U("u9"), team: T("OLD") },
      LogAttributes: { "event.name": "user_prompt", "session.id": T("sold") } });
    for (const [clock, value] of [["09:01:00", 1], ["09:30:00", 5]])
      metrics.push({ ...counter(T("sold"), U("u9"), "claude_code.cost.usage", "", clock, value), StartTimeUnix: `${prev} 09:00:00`,
        TimeUnix: `${prev} ${clock}` });
    await db.insert({ table: "otel_logs", values: logs, format: "JSONEachRow" });
    await db.insert({ table: "otel_metrics_sum", values: metrics, format: "JSONEachRow" });

    const filters = { user: id };
    const teams = await q.costByTeam(from, to, filters);
    assert.ok(!teams.some((r) => r.team === T("OLD")), "a lookback-only team has no row");
    const summary = await q.costSummary(from, to, filters);
    const sum = (rows) => rows.reduce((s, r) => s + (r.known_reported_cost ?? 0), 0);
    assert.ok(Math.abs(sum(teams) - sum(summary)) < 1e-9, `team ${sum(teams)} vs summary ${sum(summary)}`);
    assert.deepEqual(teams.map((r) => [r.team, r.known_reported_cost]), [[T("B"), 4], [T("A"), 3], [null, 8]]);
    const a = teams.find((r) => r.team === T("A"));
    assert.deepEqual([a.sessions, a.users, a.requests, a.tokens], [2, 2, 3, 30], "unknown-channel sa2 counts in A");
    const b = teams.find((r) => r.team === T("B"));
    assert.deepEqual([b.sessions, b.users, b.requests], [1, 1, 1]);
    const none = teams.find((r) => r.team === null);
    assert.deepEqual([none.sessions, none.requests], [1, 0]);
    const onlyA = await q.costByTeam(from, to, { ...filters, team: T("A") });
    assert.deepEqual(onlyA.map((r) => r.team), [T("A")]);
  } finally {
    await db.close();
  }
});

test("team cost trend keeps the top 8 teams, folds the rest and never folds 팀 없음", {
  skip: !process.env.TEAM_COST_SQL_TEST_URL,
}, async () => {
  process.env.CH_URL = process.env.TEAM_COST_SQL_TEST_URL;
  process.env.CH_USER = "default";
  process.env.CH_PASSWORD = "";
  const { createClient } = await import("@clickhouse/client");
  const db = createClient({ url: process.env.CH_URL, database: "claude_code" });
  const q = await import("./queries.js");
  try {
    const id = randomUUID().slice(0, 8);
    const day = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const from = new Date(`${day}T14:00:00Z`), to = new Date(`${day}T15:00:00Z`);
    const logs = [], metrics = [];
    for (let i = 0; i <= 10; i++) {
      const session = `${id}-s${i}`, user = `u${i}-${id}@example.invalid`;
      const team = i < 10 ? `${id}-t${String(i).padStart(2, "0")}` : null;
      logs.push({ Timestamp: `${day} 14:0${i % 10}:00.${String(i).padStart(9, "0")}`,
        ResourceAttributes: { "user.email": user, ...(team ? { team } : {}) },
        LogAttributes: { "event.name": "user_prompt", "session.id": session } });
      for (const [clock, value] of [["13:59:00", 1], ["14:30:00", 1 + (i + 1)]])
        metrics.push({ ResourceAttributes: { "user.email": user },
          Attributes: { "session.id": session, "organization.id": "fixture", model: "claude-sonnet-5" },
          MetricName: "claude_code.cost.usage", StartTimeUnix: `${day} 13:00:00`, TimeUnix: `${day} ${clock}`,
          Value: value, AggregationTemporality: 2, IsMonotonic: true });
    }
    await db.insert({ table: "otel_logs", values: logs, format: "JSONEachRow" });
    await db.insert({ table: "otel_metrics_sum", values: metrics, format: "JSONEachRow" });
    const filters = { user: id };
    const cells = await q.costByTeamDaily(from, to, 24, filters);
    const named = cells.filter((c) => typeof c.team === "string" && c.team !== "");
    assert.deepEqual(named.map((c) => c.team).sort(), [9, 8, 7, 6, 5, 4, 3, 2].map((i) => `${id}-t0${i}`).sort());
    const rest = cells.filter((c) => c.team === null);
    assert.deepEqual(rest.map((c) => [c.rest_teams, c.reported_cost]), [[2, 3]], "t00 ($1) + t01 ($2) fold");
    assert.deepEqual(cells.filter((c) => c.team === "").map((c) => c.reported_cost), [11]);
    const total = cells.reduce((s, c) => s + (c.reported_cost ?? 0), 0);
    const table = (await q.costByTeam(from, to, filters)).reduce((s, r) => s + (r.known_reported_cost ?? 0), 0);
    assert.ok(Math.abs(total - table) < 1e-9, `trend ${total} vs table ${table}`);
  } finally {
    await db.close();
  }
});
