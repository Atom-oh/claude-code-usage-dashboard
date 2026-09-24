import { test } from "node:test";
import assert from "node:assert/strict";

function assertFields(actual, expected) {
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, key);
}

test("real ClickHouse client aggregation preserves transport identity and counter boundaries", {
  skip: !process.env.CLIENT_SQL_TEST_URL,
}, async (t) => {
  process.env.CH_URL = process.env.CLIENT_SQL_TEST_URL;
  process.env.CH_USER = "default";
  process.env.CH_PASSWORD = "";
  const { createClient } = await import("@clickhouse/client");
  const db = createClient({ url: process.env.CH_URL, database: "claude_code" });
  const { clientOverview, buildCodexQuery } = await import("./clientMetrics.js");
  const day = new Date().toISOString().slice(0, 10);
  const from = new Date(`${day}T10:00:00Z`), to = new Date(`${day}T11:00:00Z`);
  const insertLogs = (values) => db.insert({ table: "otel_logs", values, format: "JSONEachRow" });
  const insertMetrics = (values) => db.insert({ table: "otel_metrics_sum", values, format: "JSONEachRow" });
  const overview = (filters = {}, clients = ["codex"], start = from, end = to) =>
    clientOverview(start, end, filters, clients);
  const log = (n, name, attributes = {}, resource = {}) => ({
    Timestamp: `${day} 10:01:00.${String(n).padStart(9, "0")}`,
    ResourceAttributes: { "user.email": "codex@example.invalid", backend: "bedrock-mantle", ...resource },
    LogAttributes: { "event.name": name, "conversation.id": "codex-session",
      model: "openai.gpt-6-astra", ...attributes },
  });
  const usage1 = log(1, "codex.sse_event", { "event.kind": "response.completed",
    input_token_count: "100", cached_token_count: "40", cache_write_token_count: "11",
    output_token_count: "30", reasoning_token_count: "10" });
  const zeroUsage = { ...usage1.LogAttributes, input_token_count: "0", cached_token_count: "0",
    cache_write_token_count: "0", output_token_count: "0", reasoning_token_count: "0" };
  const counter = (MetricName, type, clock, Value) => ({
    ResourceAttributes: { "user.email": "claude@example.invalid" },
    Attributes: { "session.id": "claude-session", "organization.id": "fixture", model: "claude-sonnet-5", type },
    MetricName, StartTimeUnix: `${day} 09:00:00`, TimeUnix: `${day} ${clock}`,
    Value, AggregationTemporality: 2, IsMonotonic: true,
  });
  const logs = [
    log(0, "codex.sse_event", { "event.kind": "response.completed" }),
    usage1, usage1, // The exact same exported record delivered twice.
    { ...usage1, LogAttributes: Object.fromEntries(Object.entries(usage1.LogAttributes).reverse()) },
    log(2, "codex.sse_event", { "event.kind": "response.completed",
      input_token_count: "120", cached_token_count: "60", cache_write_token_count: "11",
      output_token_count: "20", reasoning_token_count: "5" }),
    log(3, "codex.api_request", { "http.response.status_code": "200", duration_ms: "10" }),
    log(4, "codex.api_request", { "http.response.status_code": "200", duration_ms: "30" }),
    log(5, "codex.tool_result", { tool_name: "exec_command", success: "true", duration_ms: "12" }),
    log(6, "codex.turn_ttft", { duration_ms: "25" }),
  ];
  const metrics = [];
  for (const [metric, type, before, after] of [
    ["claude_code.token.usage", "input", 100, 115],
    ["claude_code.token.usage", "cacheRead", 200, 240],
    ["claude_code.token.usage", "cacheCreation", 30, 35],
    ["claude_code.token.usage", "output", 50, 60],
    ["claude_code.cost.usage", "", 2, 2.2],
  ]) {
    for (const [clock, value] of [["09:59:00", before], ["10:01:00", after]]) {
      metrics.push(counter(metric, type, clock, value));
    }
  }
  try {
    await insertLogs(logs);
    await insertMetrics(metrics);
    const codex = await overview({ client: "codex" }, ["claude", "codex"]);
    assertFields(codex.totals, { tokens: 270, cost_usd: 0.0042405, requests: 2, tool_calls: 1 });
    assertFields(codex.by_client[0], { request_duration_ms: 20, ttft_ms: 25 });
    assert.equal(codex.totals.sessions, 1);
    const both = await overview({}, ["claude", "codex"]);
    assertFields(both.totals, { tokens: 340, sessions: 2, cost_usd: 0.2042405 });
    assert.equal(both.by_client.find((r) => r.client === "claude").cost_usd, 0.2);
    const edges = [];
    for (const [metric, type, before, after] of [
      ["claude_code.token.usage", "input", 100, 110],
      ["claude_code.cost.usage", "", 2, 2.1],
    ]) {
      for (const [clock, value] of [["10:00:10", before], ["10:00:35", after]]) {
        edges.push(counter(metric, type, clock, value));
      }
    }
    await insertMetrics(edges);
    const edge = await overview({ client: "claude" }, ["claude", "codex"],
      new Date(`${day}T10:00:30Z`), new Date(`${day}T10:00:40Z`));
    assertFields(edge.totals, { tokens: 10, cost_usd: 0.1 });
    const filtered = await overview({ client: "codex", user: "' OR 1=1" }, ["claude", "codex"]);
    assert.equal(filtered.totals.tokens, 0);
    const tierRows = [8, 9, 10].map((n) => log(n, "codex.sse_event",
      { ...zeroUsage, input_token_count: "100000" }, { "user.email": "tiers@example.invalid" }));
    const long = log(11, "codex.sse_event", { ...zeroUsage, input_token_count: "272001", output_token_count: "100" },
      { "user.email": "tiers@example.invalid" });
    const global = log(12, "codex.sse_event", { ...usage1.LogAttributes, model: "global.openai.gpt-6-astra" },
      { backend: "bedrock-runtime" });
    await insertLogs([...tierRows, long, global]);
    assert.equal((await overview({ client: "codex", user: "tiers" })).totals.cost_usd, 9.292272);
    assert.equal((await overview({ client: "codex", backend: "bedrock-runtime" })).totals.cost_usd, 0.0021675);
    await insertLogs([log(7, "codex.sse_event", {
      ...usage1.LogAttributes, model: "openai.unpriced",
    })]);
    const unpriced = await overview({ client: "codex" });
    assert.equal(unpriced.totals.cost_usd, 9.29868);
    assert.equal(unpriced.totals.cost_partial, true);
    assert.equal(unpriced.quality.unpriced, 1);
    const partial = log(13, "codex.sse_event", { "event.kind": "response.completed",
      output_token_count: "10", cached_token_count: "0", cache_write_token_count: "0", reasoning_token_count: "1" },
      { "user.email": "partial@example.invalid" });
    await insertLogs([partial]);
    const broken = await overview({ client: "codex", user: "partial" });
    assert.equal(broken.quality.invalid, 1);
    assertFields(broken.totals, { cost_usd: null, tokens: null });

    await t.test("Luna pricing restores mixed-model costs with per-response context boundaries", async () => {
      const resource = { "user.email": "luna-pricing@example.invalid" };
      await insertLogs([
        log(90, "codex.sse_event", {
          ...zeroUsage, model: "openai.gpt-5.6-luna",
          input_token_count: "272000", output_token_count: "100",
        }, resource),
        log(91, "codex.sse_event", {
          ...zeroUsage, model: "openai.gpt-5.6-luna",
          input_token_count: "272001", output_token_count: "100",
        }, resource),
        log(92, "codex.sse_event", usage1.LogAttributes, resource),
      ]);
      const actual = await overview({ client: "codex", user: "luna-pricing@" });
      assertFields(actual.totals, { tokens: 544331, cost_usd: 0.18223469, unpriced: 0 });
      assertFields(actual.quality, { unpriced: 0, invalid: 0, missing_usage: 0 });
      assert.equal(actual.by_client[0].cost_usd, 0.18223469);
      assert.equal(actual.timeseries[0].cost_usd, 0.18223469);
      assert.equal(actual.by_model.find(row => row.model === "openai.gpt-5.6-luna").cost_usd, 0.17985044);
      assert.equal(actual.by_model.find(row => row.model === "openai.gpt-6-astra").cost_usd, 0.00238425);
    });

    await t.test("Claude actual event names and prefixed aliases supply operational measurements", async () => {
      const claudeLogs = [];
      for (const prefix of ["", "claude_code."]) {
        for (const [name, attributes] of [
          ["api_request", { duration_ms: "100" }],
          ["api_error", { status_code: "503", duration_ms: "40" }],
          ["tool_result", { tool_name: "Bash", success: "true", duration_ms: "12" }],
          ["tool_decision", { tool_name: "Bash", decision: "accept" }],
          ["turn_ttft", { duration_ms: "50" }],
        ]) {
          const row = log(100 + claudeLogs.length, prefix + name, {
            ...attributes, model: "claude-sonnet-5", "session.id": "claude-session",
          });
          if (name.startsWith("tool_")) delete row.LogAttributes.model;
          row.ResourceAttributes = { "user.email": "claude@example.invalid" };
          claudeLogs.push(row);
        }
      }
      await insertLogs([...claudeLogs, claudeLogs[0]]);
      const actual = await overview({ client: "claude" }, ["claude", "codex"]);
      assertFields(actual.totals, {
        requests: 4,
        api_errors: 2,
        tool_calls: 2,
        request_duration_ms: 70,
        ttft_ms: 50,
      });
      assertFields(actual.tools[0], { calls: 2, duration_ms: 24 });
      const filtered = await overview({ client: "claude", model: "global.anthropic.claude-sonnet-5" }, ["claude", "codex"]);
      assert.deepEqual(filtered, actual);
    });

    await t.test("missing usage preserves known mixed-session and mixed-client cost subtotals", async () => {
      const scoped = (n, name, session, attributes = {}) => log(n, name,
        { ...attributes, "conversation.id": session }, { "user.email": "coverage@example.invalid" });
      const generic = scoped(202, "codex.sse_event", "missing", { "event.kind": "response.completed" });
      await insertLogs([
        scoped(200, "codex.sse_event", "priced", usage1.LogAttributes),
        scoped(201, "codex.api_request", "missing", { "http.response.status_code": "200" }),
        generic, generic,
      ]);
      const mixed = await overview({ client: "codex", user: "coverage" });
      assert.equal(mixed.observed_records, 3);
      assert.equal(mixed.totals.requests, 1);
      assertFields(mixed.quality, { missing_usage: 1, unpriced: 1 });
      for (const row of [mixed.totals, ...mixed.by_client, ...mixed.by_user, ...mixed.by_model,
        ...mixed.by_project, ...mixed.timeseries]) {
        assertFields(row, { cost_usd: 0.00238425, cost_partial: true, tokens: null });
      }
      const combined = await overview({}, ["claude", "codex"]);
      assert(Number.isFinite(combined.totals.cost_usd));
      assert.equal(combined.totals.cost_partial, true);
      assert(Math.abs(combined.totals.cost_usd
        - combined.by_client.reduce((sum, row) => sum + row.cost_usd, 0)) < 1e-9);
      assert.equal(combined.quality.missing_usage, 1);
      assert.equal(combined.by_client.find((r) => r.client === "claude").cost_usd, 0.2);
    });

    await t.test("generic completions without usage are observed while explicit zero and no records differ", async () => {
      const generic = log(300, "codex.sse_event", { "event.kind": "response.completed" },
        { "user.email": "generic@example.invalid" });
      const zero = log(301, "codex.sse_event", zeroUsage, { "user.email": "zero@example.invalid" });
      await insertLogs([generic, generic, zero]);
      const missing = await overview({ client: "codex", user: "generic" });
      assert.equal(missing.observed_records, 1);
      assert.equal(missing.totals.cost_usd, null);
      assert.equal(missing.quality.missing_usage, 1);
      const measured = await overview({ client: "codex", user: "zero" });
      assert.equal(measured.observed_records, 1);
      assertFields(measured.totals, { tokens: 0, cost_usd: 0 });
      assert.equal(measured.quality.missing_usage, 0);
      const empty = await overview({ client: "codex", user: "no-matching-user" });
      assert.equal(empty.observed_records, 0);
      assert.equal(empty.by_client[0].observed_records, 0);
    });

    await t.test("component missingness and invalid values survive aggregation with valid usage", async (components) => {
      for (const [i, key, value, field] of [
        [0, "input_token_count", undefined, "input_tokens"],
        [1, "cached_token_count", undefined, "cache_read_tokens"],
        [2, "cache_write_token_count", "garbage", "cache_write_tokens"],
        [3, "output_token_count", "-1", "output_tokens"],
        [4, "reasoning_token_count", "0.5", "reasoning_tokens"],
        [5, "cached_token_count", "101", "cache_read_tokens"],
        [6, "reasoning_token_count", "31", "reasoning_tokens"],
      ]) {
        await components.test(`${key}: ${value ?? "missing"}`, async () => {
          const bad = log(400 + i * 2, "codex.sse_event", { ...usage1.LogAttributes });
          if (value === undefined) delete bad.LogAttributes[key];
          else bad.LogAttributes[key] = value;
          const good = log(401 + i * 2, "codex.sse_event", { ...usage1.LogAttributes });
          for (const row of [bad, good]) row.ResourceAttributes["user.email"] = `components-${i}@example.invalid`;
          await insertLogs([bad, good]);
          const actual = await overview({ client: "codex", user: `components-${i}@` });
          assert.equal(actual.totals[field], null, key);
          assert.equal(actual.totals.tokens, null, key);
          assert.equal(actual.totals.cost_usd, 0.00238425, key);
          assert.equal(actual.totals.cost_partial, true, key);
          assert.equal(actual.quality.unpriced, 1, key);
          assert.equal(actual.quality.invalid, 1, key);
          assert.equal(actual.quality.missing_usage, 0, key);
        });
      }
    });

    await t.test("pair-valid malformed rows retain observed tokens beside pair-unknown rows", async () => {
      const resource = { "user.email": "observed-pairs@example.invalid" };
      const good = log(450, "codex.sse_event", { ...usage1.LogAttributes }, resource);
      const noCache = log(451, "codex.sse_event", { ...usage1.LogAttributes }, resource);
      delete noCache.LogAttributes.cache_write_token_count;
      const noInput = log(452, "codex.sse_event", { ...usage1.LogAttributes }, resource);
      delete noInput.LogAttributes.input_token_count;
      await insertLogs([good, noCache, noInput]);
      const result = await overview({ client: "codex", user: "observed-pairs@" });
      assertFields(result.totals, {
        tokens: null, observed_tokens: 260, tokens_partial: true,
        cost_usd: 0.00238425, unpriced: 2,
      });
      assertFields(result.quality, { invalid: 2, missing_usage: 0 });
      for (const rows of [result.by_client, result.by_model, result.by_user,
        result.by_project, result.timeseries]) {
        assert.equal(rows.reduce((sum, row) => sum + (row.observed_tokens ?? 0), 0), 260);
        assert.equal(rows[0].tokens, null);
        assert.equal(rows[0].tokens_partial, true);
      }
    });

    await t.test("overflow inside a SQL group invalidates the aggregate rather than exposing a small remainder", async () => {
      const resource = { "user.email": "observed-overflow@example.invalid" };
      const large = { ...zeroUsage, input_token_count: "4503599627370496" };
      await insertLogs([
        log(460, "codex.sse_event", large, resource),
        log(461, "codex.sse_event", large, resource),
        log(462, "codex.sse_event", { ...zeroUsage, input_token_count: "5",
          "conversation.id": "small-group" }, resource),
      ]);
      const result = await overview({ client: "codex", user: "observed-overflow@" });
      for (const row of [result.totals, ...result.by_client, ...result.by_model,
        ...result.by_user, ...result.by_project, ...result.timeseries]) {
        assertFields(row, { observed_tokens: null, tokens_partial: true });
      }
      assert.equal(result.totals.cost_usd, 0.000055);
    });

    for (const [resolution, start, end, before, after, bucketHours, bucketTimes] of [
      ["minute", "10:00:00", "11:00:00", "10:00:59.900000000", "10:01:00.100000000",
        1 / 60, ["10:00:00", "10:01:00"]],
      ["hour", "08:00:00", "14:00:00", "10:59:59.900000000", "11:00:00.100000000",
        1, ["10:00:00", "11:00:00"]],
    ]) {
      await t.test(`usage across a ${resolution} boundary covers only its own session`, async () => {
        const make = (clock, name, session, attributes = {}) => {
          const row = log(500, name, { ...attributes, "conversation.id": session });
          row.Timestamp = `${day} ${clock}`;
          row.ResourceAttributes["user.email"] = `boundary-${resolution}@example.invalid`;
          row.ResourceAttributes["project.name"] = "boundary-fixture";
          return row;
        };
        const rangeFrom = new Date(`${day}T${start}Z`);
        const rangeTo = new Date(`${day}T${end}Z`);
        const filters = { client: "codex", user: `boundary-${resolution}@` };
        await insertLogs([
          make(before, "codex.api_request", "covered", { "http.response.status_code": "200" }),
          make(before, "codex.sse_event", "covered", { "event.kind": "response.completed" }),
          make(after, "codex.sse_event", "covered", usage1.LogAttributes),
        ]);
        const covered = await overview(filters, ["codex"], rangeFrom, rangeTo);
        assertFields(covered, { bucket_hours: bucketHours, observed_records: 3 });
        assertFields(covered.quality, { missing_usage: 0, unpriced: 0 });
        assertFields(covered.totals, { requests: 1, tokens: 130, cost_usd: 0.00238425 });
        assert.deepEqual(covered.timeseries.map((r) => r.t), bucketTimes.map((clock) => `${day}T${clock}Z`));
        assert.deepEqual(covered.timeseries.map((r) => r.cost_usd), [0, 0.00238425]);

        // Coverage does not look outside the selected range.
        const cropped = await overview(filters, ["codex"], rangeFrom, new Date(`${day}T${bucketTimes[1]}Z`));
        assert.equal(cropped.observed_records, 2);
        assert.equal(cropped.quality.missing_usage, 1);
        assert.equal(cropped.totals.cost_usd, null);

        // A generic completion remains evidence even with no API-request record.
        await insertLogs([
          make(after, "codex.sse_event", "unreported", { "event.kind": "response.completed" }),
        ]);
        const mixed = await overview(filters, ["codex"], rangeFrom, rangeTo);
        assert.equal(mixed.observed_records, 4);
        assert.equal(mixed.totals.requests, 1);
        assertFields(mixed.quality, { missing_usage: 1, unpriced: 1 });
        for (const row of [mixed.totals, ...mixed.by_client, ...mixed.by_model, ...mixed.by_user, ...mixed.by_project]) {
          assertFields(row, { cost_usd: 0.00238425, cost_partial: true, tokens: null });
        }
        assert.deepEqual(mixed.timeseries.map((r) => r.cost_usd), [0, 0.00238425]);
        assert.deepEqual(mixed.timeseries.map((r) => r.cost_partial), [false, true]);
      });
    }
    for (const client of ["claude", "codex"]) {
      await t.test(`${client}: model-less tools require scoped evidence`, async () => {
        const model = client === "claude" ? "global.anthropic.claude-sonnet-5" : "openai.gpt-6-astra";
        const user = `model-${client}@example.invalid`;
        const make = (session, name, modelValue, resource = {}, clock = "10:01:00") => {
          const id = session ? `${client}-${session}` : "";
          const row = log(600, (client === "codex" ? "codex." : "") + name, {
            "session.id": id, "conversation.id": id, tool_name: session,
          });
          if (modelValue === undefined) delete row.LogAttributes.model;
          else row.LogAttributes.model = modelValue;
          row.Timestamp = `${day} ${clock}`;
          row.ResourceAttributes = { "user.email": user, backend: "bedrock-mantle", "project.name": "fixture", ...resource };
          return row;
        };
        const rows = [
          make("matched", "api_request", model), make("matched", "tool_result", "nonmatching"),
          make("direct", "tool_result", model), make("miss", "api_request", "nonmatching"),
          make("early", "api_request", model, {}, "09:59:59"),
          make("late", "api_request", model, {}, "11:00:00"),
          make("", "api_request", model),
          ...["matched", "miss", "counter", "foreign", "early", "late", ""].flatMap((session) =>
            ["tool_result", "tool_decision"].map((name) => make(session, name))),
          ...[{ "user.email": "model-other@example.invalid" }, { "project.name": "other" },
            ...(client === "codex" ? [{ backend: "bedrock-runtime" }] : [])]
            .map((resource) => make("matched", "tool_result", undefined, resource)),
        ];
        // Both client ID keys collide deliberately.
        const foreign = make("foreign", "api_request", model);
        foreign.LogAttributes["event.name"] = client === "claude" ? "codex.api_request" : "api_request";
        await insertLogs([...rows, foreign]);
        await insertMetrics([{
          ...metrics[0], ResourceAttributes: make("counter", "tool_result").ResourceAttributes,
          Attributes: { "session.id": `${client}-counter`, model, type: "input" },
          TimeUnix: `${day} 10:01:00`, Value: 0,
        }]);
        const select = async (filters) => {
          const { sql, params } = buildCodexQuery(from, to, filters, {}, client);
          return (await db.query({ query: sql, query_params: params, format: "JSONEachRow" })).json();
        };
        const selected = await select({ model, user: "model-" });
        assert.deepEqual(selected.filter((r) => r.kind === "tool").map((r) => r.tool).sort(),
          client === "claude" ? ["counter", "direct", "matched"] : ["direct", "matched"]);
        assert.equal(selected.filter((r) => r.kind === "approval").length, client === "claude" ? 2 : 1);
        assert.ok(selected.every((r) => !r.model || !r.model.includes("nonmatching")));
        assert.deepEqual(await select({ model: "absent-model", user }), []);
        assert.deepEqual(await select({ model, user, backend: "anthropic" }), []);
      });
    }
    for (const grain of ["minute", "hour"]) {
      await t.test(`Claude ${grain} timeline retains measured zero without inventing missing buckets or active users`, async () => {
        const user = `idle-${grain}@example.invalid`;
        const clocks = grain === "minute"
          ? ["09:59:00", "10:01:00", "10:02:00", "10:04:00"]
          : ["09:59:00", "10:01:00", "11:01:00", "13:01:00"];
        const values = [];
        for (const [metric, type, samples] of [
          ["claude_code.token.usage", "input", [100, 110, 110, 120]],
          ["claude_code.cost.usage", "", [2, 2.1, 2.1, 2.2]],
        ]) {
          for (const [i, clock] of clocks.entries()) {
            const row = counter(metric, type, clock, samples[i]);
            row.ResourceAttributes = { "user.email": user };
            row.Attributes["session.id"] = `active-${grain}`;
            values.push(row);
            // Idle sessions must not increase the active population or breakdowns.
            values.push({ ...row, Value: samples[0],
              Attributes: { ...row.Attributes, "session.id": `idle-${grain}` } });
          }
        }
        await insertMetrics(values);
        const result = await overview({ client: "claude", user }, ["claude", "codex"],
          from, new Date(`${day}T${grain === "minute" ? "10:06" : "16:00"}:00Z`));
        assertFields(result.totals, { tokens: 20, cost_usd: 0.2, users: 1, sessions: 1 });
        assert.equal(result.by_user.length, 1);
        assert.equal(result.by_model.length, 1);
        assert.equal(result.observed_records, 2);
        assert.deepEqual(result.timeseries.map(row => row.t), grain === "minute"
          ? [`${day}T10:01:00Z`, `${day}T10:02:00Z`, `${day}T10:04:00Z`]
          : [`${day}T10:00:00Z`, `${day}T11:00:00Z`, `${day}T13:00:00Z`]);
        assert.deepEqual(result.timeseries.map(row => row.observed_tokens), [10, 0, 10]);
        assert.deepEqual(result.timeseries.map(row => row.cost_usd), [0.1, 0, 0.1]);
        assert.equal(result.timeseries[1].timeline_observed, true);
      });
    }
    await t.test("idle counters preserve independent token/cost availability within each scope", async () => {
      for (const mode of ["tokens", "cost", "split"]) {
        const user = `availability-${mode}@example.invalid`;
        const values = [];
        for (const metric of mode === "tokens" ? ["claude_code.token.usage"]
          : mode === "cost" ? ["claude_code.cost.usage"]
            : ["claude_code.token.usage", "claude_code.cost.usage"]) {
          for (const clock of ["09:59:00", "10:01:00"]) {
            const row = counter(metric, metric.includes("token") ? "input" : "", clock, 10);
            row.ResourceAttributes = { "user.email": user };
            row.Attributes["session.id"] = mode === "split" ? metric : mode;
            values.push(row);
          }
        }
        await insertMetrics(values);
        const result = await overview({ client: "claude", user }, ["claude"], from, to);
        assert.equal(result.observed_records, 0);
        assert.equal(result.timeseries.length, 1);
        const zero = result.timeseries[0];
        assert.equal(zero.observed_tokens, mode === "cost" ? null : 0);
        assert.equal(zero.cost_usd, mode === "tokens" ? null : 0);
        assert.equal(zero.tokens_partial, mode !== "tokens");
        assert.equal(zero.cost_partial, mode !== "cost");
      }
    });
    await t.test("first partial hour requires actual in-window counter observations", async () => {
      for (const observed of [false, true]) {
        const user = `partial-idle-${observed}@example.invalid`;
        const values = [];
        for (const metric of ["claude_code.token.usage", "claude_code.cost.usage"]) {
          for (const clock of observed ? ["10:01:00", "10:30:00", "11:01:00"] : ["10:01:00", "11:01:00"]) {
            const row = counter(metric, metric.includes("token") ? "input" : "", clock, 10);
            row.ResourceAttributes = { "user.email": user };
            row.Attributes["session.id"] = user;
            values.push(row);
          }
        }
        await insertMetrics(values);
        const result = await overview({ client: "claude", user }, ["claude"],
          new Date(`${day}T10:15:00Z`), new Date(`${day}T16:00:00Z`));
        assert.deepEqual(result.timeseries.map(row => row.t),
          observed ? [`${day}T10:15:00Z`, `${day}T11:00:00Z`] : [`${day}T11:00:00Z`]);
        assert(result.timeseries.every(row => row.observed_tokens === 0 && row.cost_usd === 0));
      }
    });
    // Baseline-only first-bucket sessions are no data; the pre-fold query returned them as $0 rows.
    await t.test("model cost cells classify sessions in ClickHouse and omit baseline-only first buckets at 1h, 24h and 168h", async () => {
      const { costByModelDaily } = await import("./queries.js");
      const user = "model-cost-partial@example.invalid";
      const values = [];
      for (const [session, model, metric, type, samples] of [
        ["mc-observed", "claude-sonnet-5", "claude_code.cost.usage", "", [["10:05:00", 1], ["10:30:00", 1.5], ["11:30:00", 2.5]]],
        ["mc-observed", "claude-sonnet-5", "claude_code.token.usage", "input", [["10:05:00", 100], ["10:30:00", 150], ["11:30:00", 250]]],
        ["mc-baseline", "claude-haiku-4-5", "claude_code.cost.usage", "", [["10:05:00", 1], ["10:10:00", 1.25]]],
        ["mc-baseline", "claude-haiku-4-5", "claude_code.token.usage", "input", [["10:05:00", 10], ["10:10:00", 12]]],
        ["mc-late", "claude-opus-5", "claude_code.cost.usage", "", [["10:05:00", 1], ["11:30:00", 1.25]]],
        ["mc-late", "claude-opus-5", "claude_code.token.usage", "input", [["10:05:00", 10], ["11:30:00", 14]]],
        ["mc-token-only", "claude-fable-5", "claude_code.token.usage", "input", [["10:30:00", 10], ["11:30:00", 30]]],
        ["mc-observed-missing", "claude-sonnet-5", "claude_code.token.usage", "input", [["10:30:00", 5], ["11:30:00", 8]]],
        ["mc-zero-known", "claude-opus-4-8", "claude_code.cost.usage", "", [["10:30:00", 0], ["11:30:00", 0]]],
        ["mc-zero-known", "claude-opus-4-8", "claude_code.token.usage", "input", [["10:30:00", 0], ["11:30:00", 0]]],
        ["mc-zero-tokens", "claude-opus-4-8", "claude_code.cost.usage", "", [["10:30:00", 0], ["11:30:00", 0]]],
        ["mc-zero-tokens", "claude-opus-4-8", "claude_code.token.usage", "input", [["10:30:00", 20], ["11:30:00", 40]]],
        ["mc-report-only", "claude-sonnet-4-5", "claude_code.cost.usage", "", [["10:30:00", 0.75], ["11:30:00", 1]]],
      ]) {
        for (const [clock, value] of samples) {
          const row = counter(metric, type, clock, value);
          row.ResourceAttributes = { "user.email": user };
          row.Attributes["session.id"] = session;
          row.Attributes.model = model;
          values.push(row);
        }
      }
      await insertMetrics(values);
      const start = new Date(`${day}T10:15:00Z`), end = new Date(`${day}T16:00:00Z`);
      const filter = { user: "model-cost-partial@" };
      const shape = (rows) => rows.map((r) => [r.day, r.model, r.reported_cost, r.reported_partial, r.reported_all_unavailable, r.reported_unavailable, r.reported_reasons.report_missing, r.reported_reasons.report_zero_with_tokens, r.input_tokens, r.observed_tokens, r.tokens_partial]);
      const week = new Date(Math.floor(Date.parse(`${day}T00:00:00Z`) / (7 * 86400000)) * 7 * 86400000).toISOString().slice(0, 19).replace("T", " ");
      const hourly = await costByModelDaily(start, end, 1, filter);
      assert.deepEqual(shape(hourly), [
        [`${day} 10:00:00`, "claude-fable-5", null, true, true, 1, 1, 0, 10, 10, false],
        [`${day} 10:00:00`, "claude-opus-4-8", 0, true, false, 1, 0, 1, 20, 20, false],
        [`${day} 10:00:00`, "claude-sonnet-4-5", 0.75, false, false, 0, 0, 0, 0, null, true],
        [`${day} 10:00:00`, "claude-sonnet-5", 0.5, true, false, 1, 1, 0, 55, 55, false],
        [`${day} 11:00:00`, "claude-fable-5", null, true, true, 1, 1, 0, 20, 20, false],
        [`${day} 11:00:00`, "claude-opus-4-8", 0, true, false, 1, 0, 1, 20, 20, false],
        [`${day} 11:00:00`, "claude-opus-5", 0.25, false, false, 0, 0, 0, 4, 4, false],
        [`${day} 11:00:00`, "claude-sonnet-4-5", 0.25, false, false, 0, 0, 0, 0, null, true],
        [`${day} 11:00:00`, "claude-sonnet-5", 1, true, false, 1, 1, 0, 103, 103, false],
      ], "1h");
      const grains = [hourly];
      for (const [hours, label] of [[24, `${day} 00:00:00`], [168, week]]) {
        const rows = await costByModelDaily(start, end, hours, filter);
        assert.deepEqual(shape(rows), [
          [label, "claude-fable-5", null, true, true, 1, 1, 0, 30, 30, false],
          [label, "claude-opus-4-8", 0, true, false, 1, 0, 1, 40, 40, false],
          [label, "claude-opus-5", 0.25, false, false, 0, 0, 0, 4, 4, false],
          [label, "claude-sonnet-4-5", 1, false, false, 0, 0, 0, 0, null, true],
          [label, "claude-sonnet-5", 1.5, true, false, 1, 1, 0, 158, 158, false],
        ], `${hours}h`);
        grains.push(rows);
      }
      for (const row of grains.flat()) {
        assert.equal(row.group, "enterprise");
        assert.notEqual(row.model, "claude-haiku-4-5");
      }
      // Sessions never fan out: claude-sonnet-5 (mc-observed, mc-observed-missing) and
      // claude-opus-4-8 (mc-zero-known, mc-zero-tokens) each have two sessions in every bucket,
      // yet each grain returns exactly one row per (day, group, model).
      for (const rows of grains) {
        assert.equal(new Set(rows.map((r) => JSON.stringify([r.day, r.group, r.model]))).size, rows.length);
      }
      // The raw ClickHouse result is already one row per (day, group, model), so the row guard
      // counts cells: per-session rows (53,896 for 30 days at 1h on prod) never leave the database.
      const { costByModelDailySql, range } = await import("./queries.js");
      const { query } = await import("./clickhouse.js");
      for (const [hours, cells] of [[1, 9], [24, 5], [168, 5]]) {
        const { sql, params, raw } = costByModelDailySql(hours, filter);
        const rows = await query(sql, { ...range(start, end, raw), ...params });
        assert.equal(rows.length, cells, `${hours}h raw ClickHouse rows`);
      }
    });
    // Pins current detail behavior: an increment inside the partial first minute is dropped.
    await t.test("minute buckets drop an unaligned first minute on the detail endpoint (pre-existing boundary)", async () => {
      const { costByModelDaily } = await import("./queries.js");
      const user = "partial-minute@example.invalid";
      const values = [];
      for (const [metric, type, samples] of [
        ["claude_code.cost.usage", "", [["10:00:10", 1], ["10:00:35", 1.5], ["10:01:30", 2]]],
        ["claude_code.token.usage", "input", [["10:00:10", 10], ["10:00:35", 15], ["10:01:30", 20]]],
      ]) {
        for (const [clock, value] of samples) {
          const row = counter(metric, type, clock, value);
          row.ResourceAttributes = { "user.email": user };
          row.Attributes["session.id"] = "pm-session";
          row.Attributes.model = "claude-sonnet-5";
          values.push(row);
        }
      }
      await insertMetrics(values);
      const filter = { user: "partial-minute@" };
      const shape = (rows) => rows.map((r) => [r.day, r.model, r.reported_cost, r.reported_partial, r.input_tokens]);
      const end = new Date(`${day}T10:03:00Z`);
      const unaligned = await costByModelDaily(new Date(`${day}T10:00:30Z`), end, 1 / 60, filter);
      // The 0.5 reported at 10:00:35 is in neither bucket.
      assert.deepEqual(shape(unaligned), [[`${day} 10:01:00`, "claude-sonnet-5", 0.5, false, 5]]);
      const aligned = await costByModelDaily(new Date(`${day}T10:00:00Z`), end, 1 / 60, filter);
      assert.deepEqual(shape(aligned), [
        [`${day} 10:00:00`, "claude-sonnet-5", 1.5, false, 15],
        [`${day} 10:01:00`, "claude-sonnet-5", 0.5, false, 5],
      ]);
    });
    await t.test("idle buckets before the active-row boundary cannot truncate later usage", async () => {
      const user = "capacity@example.invalid";
      await db.command({ query: `INSERT INTO otel_metrics_sum
        (ResourceAttributes, Attributes, MetricName, TimeUnix, Value, AggregationTemporality, IsMonotonic)
        SELECT map('user.email', {user:String}),
          map('session.id', concat('capacity-', toString(number)), 'model', 'claude-sonnet-5', 'type', 'input'),
          'claude_code.token.usage', {time:DateTime}, 1, 1, true FROM numbers(50000)`,
        query_params: { user, time: `${day} 12:01:00` } });
      const idle = [];
      for (const metric of ["claude_code.token.usage", "claude_code.cost.usage"]) {
        for (const clock of ["09:59:00", "10:01:00", "11:01:00"]) {
          const row = counter(metric, metric.includes("token") ? "input" : "", clock, 10);
          row.ResourceAttributes = { "user.email": user };
          row.Attributes["session.id"] = "idle-capacity";
          idle.push(row);
        }
      }
      await insertMetrics(idle);
      const end = new Date(`${day}T16:00:00Z`);
      const result = await overview({ client: "claude", user }, ["claude"], from, end);
      assertFields(result.totals, { observed_tokens: 50000, sessions: 50000, users: 1 });
      assert.equal(result.observed_records, 50000);
      assert.deepEqual(result.timeseries.map(row => row.observed_tokens), [0, 0, 50000]);
      await insertMetrics([{ ...counter("claude_code.token.usage", "input", "12:01:00", 1),
        ResourceAttributes: { "user.email": user },
        Attributes: { "session.id": "capacity-overflow", model: "claude-sonnet-5", type: "input" },
        AggregationTemporality: 1 }]);
      await assert.rejects(overview({ client: "claude", user }, ["claude"], from, end), /too much client data/);
    });
    await t.test("rejected HTTP attempts do not create Codex token gaps or hide uncertain responses", async () => {
      for (const status of ["400", " 400 ", "401", "403", "404", "413", "415", "422", "429", "200", "408", "499", "500", "4e2"]) {
        const user = `rejection-${status}@example.invalid`;
        await insertLogs([log(700, "codex.api_request", { "http.response.status_code": status },
          { "user.email": user })]);
        const result = await overview({ client: "codex", user }, ["codex"]);
        const rejected = ["400", "401", "403", "404", "413", "415", "422", "429"].includes(status.trim());
        assertFields(result.totals, { observed_tokens: rejected ? 0 : null,
          cost_usd: rejected ? 0 : null, rejected_requests: rejected ? 1 : 0 });
        assert.equal(result.quality.missing_usage, rejected ? 0 : 1);
        if (rejected) assert.equal(result.totals.api_errors, 1);
      }
      const resource = { "user.email": "rejection-mixed@example.invalid" };
      await insertLogs([log(701, "codex.api_request", { "http.response.status_code": "400" }, resource),
        log(702, "codex.api_request", { "http.response.status_code": "200" }, resource)]);
      const mixed = await overview({ client: "codex", user: resource["user.email"] }, ["codex"]);
      assertFields(mixed.totals, { observed_tokens: null, cost_usd: null, requests: 2, rejected_requests: 1 });
      for (const key of ["input_token_count", "tool_token_count"]) {
        const user = `rejection-${key}@example.invalid`;
        await insertLogs([log(703, "codex.api_request",
          { "http.response.status_code": "400", [key]: "0" }, { "user.email": user })]);
        assertFields((await overview({ client: "codex", user }, ["codex"])).totals,
          { observed_tokens: null, cost_usd: null, rejected_requests: 0 });
        const { buildCodexInsightsLogQuery, foldCodexInsightsLogs } = await import("./codexInsightsLogs.js");
        const query = buildCodexInsightsLogQuery(from, to, { user }, { detailsOnly: true });
        const rows = await (await db.query({ query: query.sql, query_params: query.params, format: "JSONEachRow" })).json();
        assert.equal(rows[0].attributes[key], "0");
        assertFields(foldCodexInsightsLogs(rows, undefined, { deduplicated: true }).summary,
          { observed_tokens: null, cost_per_request: null, rejected_requests: 0 });
      }
      const { buildCodexInsightsLogQuery, foldCodexInsightsLogs } = await import("./codexInsightsLogs.js");
      for (const transport of ["sse_event", "websocket_event"]) {
        for (const modelled of [true, false]) {
          const user = `rejection-stream-${transport}-${modelled}@example.invalid`;
          const stream = log(705, `codex.${transport}`, { "event.kind": "response.output_text.delta" }, { "user.email": user });
          if (!modelled) delete stream.LogAttributes.model;
          await insertLogs([log(704, "codex.api_request", { "http.response.status_code": "400" },
            { "user.email": user }), stream]);
          const result = await overview({ client: "codex", user }, ["codex"]);
          assertFields(result.totals, { observed_tokens: null, cost_usd: null, rejected_requests: 1, requests: 1 });
          assert.equal(result.timeseries[0].request_rejections_only, false);
          for (const detailsOnly of [false, true]) {
            const q = buildCodexInsightsLogQuery(from, to, { user }, { detailsOnly });
            const rows = await (await db.query({ query: q.sql, query_params: q.params, format: "JSONEachRow" })).json();
            assertFields(foldCodexInsightsLogs(rows, undefined, { deduplicated: detailsOnly }).summary,
              { observed_tokens: null, cost_per_request: null, cost_partial: true });
          }
        }
      }
      const user = "rejection-model-isolation@example.invalid";
      await insertLogs([
        log(706, "codex.api_request", { "http.response.status_code": "400" }, { "user.email": user }),
        log(707, "codex.sse_event", { ...usage1.LogAttributes, model: "openai.gpt-5.6-luna" }, { "user.email": user }),
        log(708, "codex.sse_event", { "event.kind": "response.output_text.delta",
          model: "openai.gpt-5.6-luna" }, { "user.email": user }),
      ]);
      const isolated = await overview({ client: "codex", user }, ["codex"]);
      assert.equal(isolated.quality.missing_usage, 0);
      for (const detailsOnly of [false, true]) {
        const q = buildCodexInsightsLogQuery(from, to, { user }, { detailsOnly });
        const rows = await (await db.query({ query: q.sql, query_params: q.params, format: "JSONEachRow" })).json();
        assert.equal(foldCodexInsightsLogs(rows, undefined, { deduplicated: detailsOnly }).summary.cost_partial, false);
      }
      await insertLogs([log(709, "codex.sse_event",
        { "event.kind": "response.output_text.delta" }, { "user.email": user })]);
      assert.equal((await overview({ client: "codex", user }, ["codex"])).quality.missing_usage, 1);
      for (const detailsOnly of [false, true]) {
        const q = buildCodexInsightsLogQuery(from, to, { user }, { detailsOnly });
        const rows = await (await db.query({ query: q.sql, query_params: q.params, format: "JSONEachRow" })).json();
        assert.equal(foldCodexInsightsLogs(rows, undefined, { deduplicated: detailsOnly }).summary.cost_partial, true);
        if (detailsOnly) {
          const markers = rows.filter(row => Number(row.is_scope) === 1);
          assert.equal(markers.length, 1);
          assert.deepEqual(JSON.parse(markers[0].attributes["stream.models"]).sort(),
            ["openai.gpt-5.6-luna", "openai.gpt-6-astra"]);
        }
      }
      for (const [eventName, attributes] of [
        ["codex.websocket_request", {}],
        ["codex.user_prompt", { input_token_count: "1" }],
        ["codex.future_usage_event", {}],
      ]) {
        for (const modelled of [true, false]) {
          const user = `nonstream-${eventName}-${modelled}@example.invalid`;
          const evidence = log(711, eventName, attributes, { "user.email": user });
          if (!modelled) delete evidence.LogAttributes.model;
          await insertLogs([log(710, "codex.api_request", { "http.response.status_code": "400" },
            { "user.email": user }), evidence]);
          const result = await overview({ client: "codex", user }, ["codex"]);
          assertFields(result.totals, { observed_tokens: null, cost_usd: null, rejected_requests: 1 });
          for (const detailsOnly of [false, true]) {
            const q = buildCodexInsightsLogQuery(from, to, { user }, { detailsOnly });
            const rows = await (await db.query({ query: q.sql, query_params: q.params, format: "JSONEachRow" })).json();
            assertFields(foldCodexInsightsLogs(rows, undefined, { deduplicated: detailsOnly }).summary,
              { observed_tokens: null, cost_partial: true });
          }
        }
      }
      const startupUser = "startup-model-filter@example.invalid";
      const modelLessTool = log(713, "codex.tool_result", { tool_name: "fixture" }, { "user.email": startupUser });
      delete modelLessTool.LogAttributes.model;
      await insertLogs([log(712, "codex.conversation_starts", {}, { "user.email": startupUser }), modelLessTool]);
      const selected = await overview({ client: "codex", user: startupUser, model: "openai.gpt-6-astra" }, ["codex"]);
      assert.equal(selected.observed_records, 0, "startup settings cannot establish model-less tool attribution");
      for (const [name, attributes] of [
        ["codex.sse_event", { "event.kind": "response.output_text.delta" }],
        ["codex.websocket_event", { "event.kind": "response.output_text.delta" }],
        ["codex.tool_result", { tool_name: "fixture" }],
      ]) {
        const user = `modelless-rejection-${name}@example.invalid`;
        const rejection = log(714, "codex.api_request", { "http.response.status_code": "400" }, { "user.email": user });
        delete rejection.LogAttributes.model;
        await insertLogs([rejection, log(715, name, attributes, { "user.email": user })]);
        const result = await overview({ client: "codex", user }, ["codex"]);
        assertFields(result.totals, { observed_tokens: null, cost_usd: null, rejected_requests: 1 });
        assert.equal(result.timeseries[0].request_rejections_only, false);
        for (const detailsOnly of [false, true]) {
          const q = buildCodexInsightsLogQuery(from, to, { user }, { detailsOnly });
          const rows = await (await db.query({ query: q.sql, query_params: q.params, format: "JSONEachRow" })).json();
          assertFields(foldCodexInsightsLogs(rows, undefined, { deduplicated: detailsOnly }).summary,
            { observed_tokens: null, cost_partial: true });
        }
      }
    });
  } finally {
    await db.close();
  }
});
