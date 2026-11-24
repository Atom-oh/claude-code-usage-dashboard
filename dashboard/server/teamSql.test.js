import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { emailKey } from "./teamDirectory.js";
import { setDirectorySnapshot } from "./teamDirectoryParams.js";

test("team resolution, lookups and session filters agree in ClickHouse", {
  skip: !process.env.TEAM_SQL_TEST_URL,
}, async () => {
  process.env.CH_URL = process.env.TEAM_SQL_TEST_URL;
  process.env.CH_USER = "default";
  process.env.CH_PASSWORD = "";
  const { createClient } = await import("@clickhouse/client");
  const db = createClient({ url: process.env.CH_URL, database: "claude_code" });
  const q = await import("./queries.js");
  const { clientOverview } = await import("./clientMetrics.js");
  const { query } = await import("./clickhouse.js");
  try {
    const id = randomUUID().slice(0, 8);
    const day = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const from = new Date(`${day}T14:00:00Z`), to = new Date(`${day}T15:00:00Z`);
    const T = (name) => `${id}-${name}`;             // team values and session ids
    const U = (name) => `${name}-${id}@example.invalid`;
    let n = 0;
    const log = (session, user, clock, { team, logTeam, event = "user_prompt", date = day, codex = false, attrs = {} } = {}) => ({
      Timestamp: `${date} ${clock}.${String(n++).padStart(9, "0")}`,
      ResourceAttributes: { "user.email": user, ...(codex ? { backend: "bedrock-mantle" } : {}), ...(team ? { team } : {}) },
      LogAttributes: { "event.name": codex ? `codex.${event}` : event,
        ...(codex ? { "conversation.id": session } : { "session.id": session }),
        ...(logTeam ? { team: logTeam } : {}), ...attrs },
    });
    const usage = (session, clock, team) => log(session, U("cx"), clock, { codex: true, event: "sse_event", team,
      attrs: { "event.kind": "response.completed", model: "openai.gpt-6-astra", input_token_count: "100",
        cached_token_count: "0", cache_write_token_count: "0", output_token_count: "10", reasoning_token_count: "0" } });
    const logs = [
      log(T("s-freq"), U("u1"), "14:05:00", { team: T("A") }), log(T("s-freq"), U("u1"), "14:06:00", { team: T("A") }),
      log(T("s-freq"), U("u1"), "14:07:00", { team: T("A") }), log(T("s-freq"), U("u1"), "14:08:00", { team: T("B") }),
      log(T("s-recent"), U("u1"), "14:40:00", { team: T("B") }),
      log(T("s-tie"), U("u2"), "14:10:00", { team: T("b-team") }), log(T("s-tie"), U("u2"), "14:11:00", { team: T("a-team") }),
      log(T("s-none"), U("u3"), "14:12:00"),
      log(T("s-logonly"), U("u4"), "14:13:00", { logTeam: T("C") }),
      log(T("s-lookback"), U("u5"), "09:00:00", { team: T("A"), date: prev }),
      log(T("c-1"), U("cx"), "14:20:00", { team: T("A"), codex: true, event: "api_request" }),
      log(T("c-2"), U("cx"), "14:21:00", { codex: true, event: "api_request" }),
      usage(T("c-1"), "14:31:00", T("A")), usage(T("c-2"), "14:32:00"),
      // Streaming rows are not team evidence: this conversation's team appears only on them.
      usage(T("c-3"), "14:33:00", T("D")),
      // After a mid-hour range end but inside its hour, which the hourly rollup still includes.
      log(T("s-late"), U("u6"), "16:40:00", { team: T("E") }),
    ];
    const counter = (session, user, metric, type, clock, value) => ({
      ResourceAttributes: { "user.email": user },
      Attributes: { "session.id": session, "organization.id": "fixture", model: "claude-sonnet-5", type },
      MetricName: metric, StartTimeUnix: `${day} 13:00:00`, TimeUnix: `${day} ${clock}`,
      Value: value, AggregationTemporality: 2, IsMonotonic: true,
    });
    const metrics = [];
    for (const [session, user, base] of [[T("s-freq"), U("u1"), 1], [T("s-none"), U("u3"), 10]])
      for (const [metric, type, a, b] of [["claude_code.token.usage", "input", 100, 100 + base * 10],
        ["claude_code.cost.usage", "", 1, 1 + base]])
        for (const [clock, value] of [["13:59:00", a], ["14:30:00", b]]) metrics.push(counter(session, user, metric, type, clock, value));
    await db.insert({ table: "otel_logs", values: logs, format: "JSONEachRow" });
    await db.insert({ table: "otel_metrics_sum", values: metrics, format: "JSONEachRow" });

    const clients = ["claude", "codex"];
    assert.deepEqual((await q.listTeams(from, to, clients)).teams.filter((t) => t.startsWith(id)),
      [T("A"), T("B"), T("C"), T("a-team")]);
    assert.deepEqual((await q.userTeams(from, to, clients)).users.filter((r) => r.user.includes(id)), [
      { user: U("cx"), team: T("A"), teams: [T("A")], sources: ["device"] },
      { user: U("u1"), team: T("B"), teams: [T("B"), T("A")], sources: ["device", "device"] },
      { user: U("u2"), team: T("a-team"), teams: [T("a-team")], sources: ["device"] },
      { user: U("u4"), team: T("C"), teams: [T("C")], sources: ["device"] },
    ]);

    const sessions = async (clients, team) => (await query(
      `SELECT session FROM (${q.sessionTeamsSql(clients)}) WHERE team = {t:String} ORDER BY session`,
      { ...q.range(from, to, true), t: team })).map((r) => r.session);
    assert.deepEqual(await sessions(["claude"], T("A")), [T("s-freq"), T("s-lookback")]);
    assert.deepEqual(await sessions(["claude"], T("B")), [T("s-recent")]);
    assert.deepEqual(await sessions(["claude"], T("a-team")), [T("s-tie")]);
    assert.deepEqual(await sessions(["claude"], T("b-team")), []);
    assert.deepEqual(await sessions(["claude"], T("C")), [T("s-logonly")]);
    assert.deepEqual(await sessions(["codex"], T("A")), [T("c-1")]);
    assert.deepEqual(await sessions(["codex"], T("D")), []);

    // Team evidence runs to the end of the range's last hour, like the rollup reads; an
    // hour-aligned end adds nothing.
    const at = (clock) => new Date(`${day}T${clock}Z`);
    const lateUsers = async (start, end) => (await q.userTeams(start, end, clients)).users.filter((r) => r.user.includes(id));
    assert.deepEqual(await lateUsers(at("16:00:00"), at("16:30:00")),
      [{ user: U("u6"), team: T("E"), teams: [T("E")], sources: ["device"] }]);
    assert.deepEqual((await q.listTeams(at("16:00:00"), at("16:30:00"), clients)).teams.filter((t) => t.startsWith(id)), [T("E")]);
    assert.deepEqual(await lateUsers(at("15:00:00"), at("16:00:00")), []);

    const pick = (o) => o.by_client.map((r) => [r.client, r.sessions, r.observed_tokens]);
    const claudeRow = (o) => o.by_client.find((r) => r.client === "claude");
    const all = await clientOverview(from, to, { user: id }, clients);
    assert.deepEqual(pick(all), [["claude", 2, 110], ["codex", 3, 330]]);
    assert.equal(claudeRow(all).cost_usd, 11);
    const teamA = await clientOverview(from, to, { user: id, team: T("A") }, clients);
    assert.deepEqual(pick(teamA), [["claude", 1, 10], ["codex", 1, 110]]);
    assert.equal(claudeRow(teamA).cost_usd, 1);
    assert.deepEqual(teamA.by_user.map((r) => [r.client, r.user]), [["codex", U("cx")], ["claude", U("u1")]]);

    for (const [filters, cost, input] of [[{ user: id }, 11, 110], [{ user: id, team: T("A") }, 1, 10]]) {
      const summary = await q.costSummary(from, to, filters);
      assert.equal(summary.length, 1);
      assert.equal(summary[0].group, "enterprise");
      assert.equal(Number(summary[0].reported_cost), cost);
      assert.equal(Number(summary[0].input_tokens), input);
    }

    // Directory history: the team valid at each session's start wins over the device value;
    // unmatched users keep the device team. The email digest is computed by ClickHouse itself.
    const issuer = "https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_fixture";
    const change = Date.parse(`${day}T14:30:00Z`), open = 4102444800000;
    const key = (user) => emailKey(issuer, user.toUpperCase());
    setDirectorySnapshot({ issuer, directory: true, labels: {}, historyStart: 0,
      keys: [key(U("u1")), key(U("u1")), key(U("u2"))], teams: [T("dirA"), T("dirB"), T("dir")],
      froms: [0, change, 0], tos: [change, open, open] }, `fixture-${id}`);
    assert.deepEqual(await sessions(["claude"], T("dirA")), [T("s-freq")]);
    assert.deepEqual(await sessions(["claude"], T("dirB")), [T("s-recent")]);
    assert.deepEqual(await sessions(["claude"], T("dir")), [T("s-tie")]);
    assert.deepEqual(await sessions(["claude"], T("a-team")), []);
    assert.deepEqual(await sessions(["claude"], T("C")), [T("s-logonly")]);
    assert.deepEqual((await q.userTeams(from, to, clients)).users.filter((r) => r.user.includes(id)), [
      { user: U("cx"), team: T("A"), teams: [T("A")], sources: ["device"] },
      { user: U("u1"), team: T("dirB"), teams: [T("dirB"), T("dirA")], sources: ["directory", "directory"] },
      { user: U("u2"), team: T("dir"), teams: [T("dir")], sources: ["directory"] },
      { user: U("u4"), team: T("C"), teams: [T("C")], sources: ["device"] },
    ]);
    const listed = await q.listTeams(from, to, clients);
    assert.equal(listed.directory, true);
    assert.equal(listed.sources[T("dirA")], "directory");
    assert.equal(listed.sources[T("C")], "device");
  } finally {
    setDirectorySnapshot(null);
    await db.close();
  }
});
