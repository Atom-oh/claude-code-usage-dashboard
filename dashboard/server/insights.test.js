import { test } from "node:test";
import assert from "node:assert/strict";
import { createInsightsStore, LEASE_MS, MAX_ATTEMPTS, purgeAt, InsightsStoreError } from "./insightsStore.js";
import { parseInsightsConfig, duePeriod, recentPeriods, validateInsightsQuery, buildAggregates, collectAggregates,
  generateDaily, validateInsight, startInsightsScheduler, createInsightsHandler, createInsightsFeature,
  createBedrockModel, SYSTEM_PROMPT, DEFAULT_MODEL_ID, InsightsError } from "./insights.js";

// In-memory DocumentClient: implements only the two condition expressions the store uses.
function fakeDynamo() {
  const items = new Map();
  const calls = [];
  return { items, calls, async send(command) {
    const input = command.input;
    const name = command.constructor.name;
    calls.push(name);
    if (name === "GetCommand") return { Item: items.has(input.Key.pk) ? structuredClone(items.get(input.Key.pk)) : undefined };
    if (name === "PutCommand") {
      const current = items.get(input.Item.pk);
      const expr = input.ConditionExpression;
      let ok;
      if (expr === "attribute_not_exists(#pk)") ok = !current;
      else if (expr === "#attempts = :attempts AND #expiresAt = :expiresAt")
        ok = !!current && current.attempts === input.ExpressionAttributeValues[":attempts"]
          && current.expiresAt === input.ExpressionAttributeValues[":expiresAt"];
      else throw new Error(`unexpected condition ${expr}`);
      if (!ok) { const error = new Error("conditional"); error.name = "ConditionalCheckFailedException"; throw error; }
      items.set(input.Item.pk, structuredClone(input.Item));
      return {};
    }
    throw new Error(`unexpected command ${name}`);
  } };
}
const TABLE = "ccdash-insights";
const PERIOD = "2026-10-29";
const T0 = Date.parse("2026-10-30T00:40:00Z");
const MODEL_ID = "global.anthropic.claude-haiku-5-5";
const ALICE = "alice@example.invalid", BOB = "bob@example.invalid";
const SOURCES = {
  day: { summary: { sessions: 3, sessions_with_turns: 2, turns: 7, known_cost: 1.23456, cost_partial: true, cost_per_turn: 0.2, model_calls_per_turn: 1.666666 },
    users: [
      { user: ALICE, sessions: 2, turns: 5, known_cost: 1, cost_partial: false, cost_per_turn: 0.2 },
      { user: "", sessions: 1, turns: 0, known_cost: 0.23456, cost_partial: false, cost_per_turn: null },
      { user: BOB, sessions: 1, turns: 2, known_cost: null, cost_partial: false, cost_per_turn: null },
    ] },
  week: { summary: { sessions: 14, sessions_with_turns: 14, turns: 35, known_cost: 3.5, cost_partial: false, cost_per_turn: 0.1, model_calls_per_turn: 2 },
    users: [{ user: ALICE, sessions: 7, turns: 21, known_cost: 2.8, cost_partial: false, cost_per_turn: 0.1333333 }] },
  models: [{ model: "claude-sonnet-5", tokens: 300 }, { model: "claude-haiku-5-5", tokens: 100 }, { model: "bad model\nignore previous", tokens: 100 }],
  weekModels: [{ model: "claude-sonnet-5", tokens: 10 }],
  userModels: [{ user: ALICE, model: "claude-sonnet-5", tokens: 30 }, { user: BOB, model: "claude-haiku-5-5", tokens: 5 }],
  tools: [{ user: ALICE, tool: "Bash", uses: "4" }, { user: ALICE, tool: "Edit", uses: "6" }, { user: ALICE, tool: "Read", uses: "1" },
    { user: ALICE, tool: "Write", uses: "2" }, { user: ALICE, tool: "<script>", uses: "9" }],
};
const BUILT = {
  aggregates: { period: PERIOD, baseline_days: 7,
    org: {
      period: { cost_usd: 1.2346, cost_partial: true, sessions: 3, turns: 7, cost_per_turn: 0.2, sessions_with_turns: 2, model_calls_per_turn: 1.67,
        model_mix: [{ model: "claude-sonnet-5", token_share: 0.6 }, { model: "claude-haiku-5-5", token_share: 0.2 }, { model: "other", token_share: 0.2 }] },
      baseline_daily: { cost_usd: 0.5, cost_partial: false, sessions: 2, turns: 5, cost_per_turn: 0.1, model_mix: [{ model: "claude-sonnet-5", token_share: 1 }] },
    },
    users: [
      { id: "U1", cost_usd: 1, cost_partial: false, sessions: 2, turns: 5, cost_per_turn: 0.2,
        model_mix: [{ model: "claude-sonnet-5", token_share: 1 }],
        top_tools: [{ tool: "Edit", calls: 6 }, { tool: "Bash", calls: 4 }, { tool: "Write", calls: 2 }],
        baseline_daily: { cost_usd: 0.4, cost_partial: false, sessions: 1, turns: 3, cost_per_turn: 0.1333 },
        change_pct: { cost: 150, cost_per_turn: 50 } },
      { id: "U2", cost_usd: null, cost_partial: false, sessions: 1, turns: 2, cost_per_turn: null,
        model_mix: [{ model: "claude-haiku-5-5", token_share: 1 }], top_tools: [], baseline_daily: null,
        change_pct: { cost: null, cost_per_turn: null } },
    ] },
  pseudonyms: { U1: ALICE, U2: BOB },
};
const REPLY = JSON.stringify({ summary: "요약입니다",
  findings: [{ user: "U1", title: "U1 비용 증가", detail: "U1의 비용이 기준 대비 150% 증가했습니다.", metric: "+150%" },
    { user: null, title: "모델 구성", detail: "sonnet 비중이 높습니다.", metric: "" }],
  caveats: ["일부 비용은 확인할 수 없습니다."] });
function recordingModel(reply = REPLY) {
  const requests = [];
  const model = async (input) => { requests.push(JSON.stringify(input)); return { text: reply, stopReason: "end_turn", inputTokens: 2000, outputTokens: 500 }; };
  return { model, requests };
}
const generate = (store, { owner = "pod-a", nowMs = T0, model, collect = async () => structuredClone(BUILT) }) =>
  generateDaily(PERIOD, { store, collect, model, modelId: MODEL_ID, nowMs, owner });

const isCode = (code) => (e) => e instanceof InsightsError && e.code === code;

test("config enables only a valid table and model id", () => {
  assert.deepEqual(parseInsightsConfig({}), { enabled: false });
  assert.deepEqual(parseInsightsConfig({ INSIGHTS_ENABLED: "0", INSIGHTS_TABLE: "abc" }), { enabled: false });
  assert.deepEqual(parseInsightsConfig({ INSIGHTS_ENABLED: "1" }), { enabled: false, misconfigured: true });
  assert.deepEqual(parseInsightsConfig({ INSIGHTS_ENABLED: "1", INSIGHTS_TABLE: "t$x" }), { enabled: false, misconfigured: true });
  assert.deepEqual(parseInsightsConfig({ INSIGHTS_ENABLED: "1", INSIGHTS_TABLE: "abc", INSIGHTS_MODEL_ID: "bad id" }), { enabled: false, misconfigured: true });
  assert.deepEqual(parseInsightsConfig({ INSIGHTS_ENABLED: " TRUE ", INSIGHTS_TABLE: "abc" }),
    { enabled: true, table: "abc", modelId: DEFAULT_MODEL_ID, region: "us-east-1" });
  assert.deepEqual(parseInsightsConfig({ INSIGHTS_ENABLED: "true", INSIGHTS_TABLE: "prod-ccdash-insights", BEDROCK_REGION: "us-west-2", AWS_REGION: "ap-northeast-2" }),
    { enabled: true, table: "prod-ccdash-insights", modelId: DEFAULT_MODEL_ID, region: "us-west-2" });
  assert.deepEqual(parseInsightsConfig({ INSIGHTS_ENABLED: "1", INSIGHTS_TABLE: "abc", AWS_REGION: "ap-northeast-2", INSIGHTS_MODEL_ID: "us.anthropic.claude-haiku-5-5" }),
    { enabled: true, table: "abc", modelId: "us.anthropic.claude-haiku-5-5", region: "ap-northeast-2" });
  assert.equal(DEFAULT_MODEL_ID, "global.anthropic.claude-haiku-5-5");
});

test("periods are UTC days and become due at 00:30", () => {
  assert.equal(duePeriod(Date.parse("2026-10-30T00:29:59Z")), null);
  assert.equal(duePeriod(Date.parse("2026-10-30T00:30:00Z")), "2026-10-29");
  assert.deepEqual(recentPeriods(T0),
    ["2026-10-29", "2026-10-28", "2026-10-27", "2026-10-26", "2026-10-25", "2026-10-24", "2026-10-23"]);
  assert.equal(purgeAt(PERIOD), 1801008000);
  assert.doesNotThrow(() => validateInsightsQuery({}));
  assert.doesNotThrow(() => validateInsightsQuery({ period: PERIOD }));
  assert.throws(() => validateInsightsQuery({ period: "2026-1-1" }), { name: "ValidationError", message: "invalid period" });
  assert.throws(() => validateInsightsQuery({ period: [PERIOD] }), { name: "ValidationError", message: "invalid period" });
});

test("aggregates pseudonymize the top users and drop unsafe dimensions", () => {
  // The unidentified user is skipped, unsafe model text becomes "other", the <script> tool is dropped,
  // U2's unavailable cost stays null, and the baseline is a daily average.
  assert.deepEqual(buildAggregates(PERIOD, SOURCES), BUILT);
  const text = JSON.stringify(BUILT.aggregates);
  assert.ok(!text.includes("@"));
  assert.ok(!text.includes("alice"));
  assert.ok(!text.includes("ignore previous"));
});

test("aggregates read the period and the seven preceding days", async () => {
  const calls = [];
  const rec = (name, value) => async (...args) => { calls.push([name, ...args]); return value; };
  const q = { sessionTurns: async (from, to, filters, options) => { calls.push(["sessionTurns", from, to, filters, options]); return from.getTime() === Date.parse("2026-10-29T00:00:00Z") ? SOURCES.day : SOURCES.week; },
    costByModel: async (from, to, filters) => { calls.push(["costByModel", from, to, filters]); return from.getTime() === Date.parse("2026-10-29T00:00:00Z") ? SOURCES.models : SOURCES.weekModels; },
    costByUserModel: rec("costByUserModel", SOURCES.userModels), userToolUsage: rec("userToolUsage", SOURCES.tools) };
  assert.deepEqual(await collectAggregates(PERIOD, q), BUILT);
  assert.deepEqual(calls.map(([name, from, to]) => [name, from.toISOString(), to.toISOString()]), [
    ["sessionTurns", "2026-10-29T00:00:00.000Z", "2026-10-30T00:00:00.000Z"],
    ["sessionTurns", "2026-10-22T00:00:00.000Z", "2026-10-29T00:00:00.000Z"],
    ["costByModel", "2026-10-29T00:00:00.000Z", "2026-10-30T00:00:00.000Z"],
    ["costByModel", "2026-10-22T00:00:00.000Z", "2026-10-29T00:00:00.000Z"],
    ["costByUserModel", "2026-10-29T00:00:00.000Z", "2026-10-30T00:00:00.000Z"],
    ["userToolUsage", "2026-10-29T00:00:00.000Z", "2026-10-30T00:00:00.000Z"],
  ]);
  for (const call of calls) {
    assert.deepEqual(call[3], {});
    if (call[0] === "sessionTurns") assert.deepEqual(call[4], { limit: Infinity });
  }
});

test("two pods generate one result with one model call", async () => {
  const db = fakeDynamo();
  const a = createInsightsStore({ tableName: TABLE, client: db }), b = createInsightsStore({ tableName: TABLE, client: db });
  const { model, requests } = recordingModel();
  const results = await Promise.all([generate(a, { owner: "pod-a", model }), generate(b, { owner: "pod-b", model })]);
  assert.deepEqual(results, ["generated", "lost"]);
  assert.equal(requests.length, 1);
  assert.ok(!requests[0].includes("@"));
  assert.ok(!requests[0].includes("alice"));
  assert.ok(!requests[0].includes("bob"));
  assert.ok(requests[0].includes("\"U1\""));
  assert.deepEqual(db.items.get("lease#2026-10-29"),
    { pk: "lease#2026-10-29", period: PERIOD, owner: "pod-a", attempts: 1, expiresAt: T0 + LEASE_MS, purgeAt: 1801008000 });
  const item = db.items.get("daily#2026-10-29");
  assert.equal(item.generatedAt, "2026-10-30T00:40:00.000Z");
  assert.equal(item.attempt, 1);
  assert.equal(item.empty, false);
  assert.equal(item.model, MODEL_ID);
  assert.equal(item.summary, "요약입니다");
  assert.deepEqual(item.pseudonyms, { U1: ALICE, U2: BOB });
  assert.deepEqual(item.aggregates, BUILT.aggregates);
  assert.deepEqual(item.usage, { inputTokens: 2000, outputTokens: 500, estimatedCostUsd: 0.00045 });
  assert.equal(item.purgeAt, 1801008000);
  assert.deepEqual(item.findings, JSON.parse(REPLY).findings);
  assert.equal(await generate(b, { owner: "pod-b", model }), "exists");
  assert.equal(requests.length, 1);
});

test("failed attempts retry after lease expiry and stop at three", async () => {
  const db = fakeDynamo(); const store = createInsightsStore({ tableName: TABLE, client: db });
  let calls = 0;
  const model = async () => { calls += 1; return { text: "not json", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 }; };
  const attempt = (nowMs) => generate(store, { owner: "p", nowMs, model });
  await assert.rejects(attempt(T0), isCode("invalid_output"));
  assert.equal(await attempt(T0 + LEASE_MS - 1), "held");
  await assert.rejects(attempt(T0 + LEASE_MS + 1), isCode("invalid_output"));
  await assert.rejects(attempt(T0 + 2 * LEASE_MS + 2), isCode("invalid_output"));
  assert.equal(await attempt(T0 + 3 * LEASE_MS + 3), "exhausted");
  assert.equal(calls, MAX_ATTEMPTS);
  assert.equal(MAX_ATTEMPTS, 3);
  assert.equal(db.items.get("lease#2026-10-29").attempts, 3);
  assert.equal(db.items.has("daily#2026-10-29"), false);
  assert.deepEqual(await createInsightsHandler({ store, now: () => T0 + 4 * LEASE_MS })({}),
    { enabled: true, period: PERIOD, status: "failed", available: [] });
});

test("a later attempt can succeed after a failure", async () => {
  const db = fakeDynamo(); const store = createInsightsStore({ tableName: TABLE, client: db });
  let calls = 0;
  const model = async () => {
    calls += 1;
    return calls === 1
      ? { text: "{", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 }
      : { text: REPLY, stopReason: "end_turn", inputTokens: 1, outputTokens: 1 };
  };
  await assert.rejects(generate(store, { owner: "p", nowMs: T0, model }), isCode("invalid_output"));
  assert.equal(await generate(store, { owner: "p", nowMs: T0 + LEASE_MS + 1, model }), "generated");
  assert.equal(db.items.get("daily#2026-10-29").attempt, 2);
});

test("served results map pseudonyms back and report status", async () => {
  const db = fakeDynamo();
  const a = createInsightsStore({ tableName: TABLE, client: db });
  const { model } = recordingModel();
  await generate(a, { model });
  const handler = createInsightsHandler({ store: a, now: () => T0 });
  const served = await handler({});
  assert.equal(served.status, "ready");
  assert.equal(served.period, PERIOD);
  assert.equal(served.empty, false);
  assert.equal(served.model, MODEL_ID);
  assert.equal(served.summary, "요약입니다");
  assert.deepEqual(served.available, [PERIOD]);
  assert.deepEqual(served.findings, [
    { user: ALICE, pseudonym: "U1", title: "U1 비용 증가", detail: "U1의 비용이 기준 대비 150% 증가했습니다.", metric: "+150%" },
    { user: null, pseudonym: null, title: "모델 구성", detail: "sonnet 비중이 높습니다.", metric: "" },
  ]);
  assert.deepEqual(served.users.map((u) => [u.pseudonym, u.user, u.cost_usd]), [["U1", ALICE, 1], ["U2", BOB, null]]);
  assert.deepEqual(served.org, BUILT.aggregates.org);
  assert.deepEqual(served.usage, { inputTokens: 2000, outputTokens: 500, estimatedCostUsd: 0.00045 });
  assert.deepEqual(await handler({ period: "2026-10-28" }),
    { enabled: true, period: "2026-10-28", status: "failed", available: [PERIOD] });
  await assert.rejects(handler({ period: "2026-10-01" }), { name: "ValidationError", message: "invalid period" });
  assert.deepEqual(await createInsightsHandler({ store: createInsightsStore({ tableName: TABLE, client: fakeDynamo() }), now: () => T0 })({}),
    { enabled: true, period: PERIOD, status: "pending", available: [] });
});

test("results are memoized; missing periods re-read only the lease", async () => {
  const db = fakeDynamo();
  const store = createInsightsStore({ tableName: TABLE, client: db });
  const handler = createInsightsHandler({ store, now: () => T0 });
  await handler({});
  const first = db.calls.length;
  await handler({});
  assert.equal(first, 8); // seven result reads plus one lease read
  assert.equal(db.calls.length, first + 1);
});

test("a day without sessions stores an empty result without a model call", async () => {
  const store = createInsightsStore({ tableName: TABLE, client: fakeDynamo() });
  const { model, requests } = recordingModel();
  const collect = async () => ({ aggregates: { ...structuredClone(BUILT.aggregates),
    org: { ...BUILT.aggregates.org, period: { ...BUILT.aggregates.org.period, sessions: 0 } } }, pseudonyms: {} });
  assert.equal(await generate(store, { model, collect }), "empty");
  assert.equal(requests.length, 0);
  const item = await store.getResult(PERIOD);
  assert.equal(item.empty, true);
  assert.equal(item.model, null);
  assert.equal(item.summary, "");
  assert.deepEqual(item.findings, []);
  assert.deepEqual(item.caveats, []);
  assert.equal(item.usage, null);
  assert.equal((await createInsightsHandler({ store, now: () => T0 })({})).empty, true);
});

test("truncated output and identities in the input are failed attempts", async () => {
  const truncated = async () => ({ text: REPLY, stopReason: "max_tokens", inputTokens: 1, outputTokens: 1200 });
  await assert.rejects(generate(createInsightsStore({ tableName: TABLE, client: fakeDynamo() }), { model: truncated }),
    isCode("invalid_output"));
  const store = createInsightsStore({ tableName: TABLE, client: fakeDynamo() });
  const { model, requests } = recordingModel();
  const collect = async () => ({ aggregates: { ...structuredClone(BUILT.aggregates), period: "x@example.invalid" }, pseudonyms: {} });
  await assert.rejects(generate(store, { model, collect }), isCode("identity_in_input"));
  assert.equal(requests.length, 0);
});

test("validation accepts only the strict contract", () => {
  const allowed = new Set(["U1", "U2"]);
  const ok = { summary: "s", findings: [{ user: "U1", title: "t", detail: "d", metric: "" }], caveats: [] };
  const expected = { summary: "s", caveats: [], findings: [{ user: "U1", title: "t", detail: "d", metric: "" }] };
  assert.deepEqual(validateInsight(JSON.stringify(ok), allowed), expected);
  assert.deepEqual(validateInsight("```json\n" + JSON.stringify(ok) + "\n```", allowed), expected);
  assert.notEqual(validateInsight(JSON.stringify({ ...ok, summary: "x".repeat(600) }), allowed), null);
  const v = (value) => validateInsight(JSON.stringify(value), allowed);
  assert.equal(validateInsight("nope", allowed), null); // not JSON
  assert.equal(v({ ...ok, extra: 1 }), null); // extra key
  assert.equal(v({ ...ok, findings: [{ ...ok.findings[0], user: "U3" }] }), null); // unknown pseudonym
  assert.equal(v({ ...ok, summary: "U3 늘었다" }), null); // unknown pseudonym in text
  assert.equal(v({ ...ok, summary: "x".repeat(601) }), null); // oversize
  assert.equal(v({ ...ok, findings: Array(7).fill(ok.findings[0]) }), null); // too many findings
  assert.equal(v({ ...ok, caveats: ["a@b.c"] }), null); // address
  assert.equal(v({ ...ok, summary: "a\u202Eb" }), null); // bidi control
  assert.equal(v({ ...ok, findings: [{ user: "U1", title: "t", detail: "d" }] }), null); // missing key
  assert.equal(v({ ...ok, summary: "" }), null); // empty
  assert.equal(v([ok]), null); // array
});

test("scheduler checks only due periods, never overlaps and logs codes only", async () => {
  let now = T0, release;
  const warns = [];
  const log = { warn: (m) => warns.push(m) };
  const pending = (period) => new Promise((resolve) => { release = () => resolve(`generated:${period}`); });
  const scheduler = startInsightsScheduler({ generate: pending, now: () => now, intervalMs: 1e9, firstMs: 1e9, log });
  const first = scheduler.tick();
  assert.equal(await scheduler.tick(), "busy");
  release();
  assert.equal(await first, "generated:2026-10-29");
  now = Date.parse("2026-10-30T00:10:00Z");
  assert.equal(await scheduler.tick(), "not_due");
  scheduler.stop();
  const failing = startInsightsScheduler({ generate: async () => { throw new InsightsError("invalid_output"); },
    now: () => T0, intervalMs: 1e9, firstMs: 1e9, log });
  assert.equal(await failing.tick(), "failed");
  assert.deepEqual(warns, ["insights 2026-10-29: attempt failed (invalid_output)"]);
  failing.stop();
});

test("store maps transport failures and conditional misses", async () => {
  await assert.rejects(
    createInsightsStore({ tableName: TABLE, client: { send: async () => { throw new Error("boom"); } } }).getResult(PERIOD),
    (e) => e instanceof InsightsStoreError && e.message === "insights store unavailable");
  assert.throws(() => createInsightsStore({ tableName: "x" }), /INSIGHTS_TABLE is invalid/);
  const store = createInsightsStore({ tableName: TABLE, client: fakeDynamo() });
  assert.equal(await store.putResult(PERIOD, { a: 1 }), true);
  assert.equal(await store.putResult(PERIOD, { a: 1 }), false);
  assert.deepEqual(await store.acquireLease(PERIOD, "p", T0), { acquired: true, attempts: 1 });
  assert.deepEqual(await store.acquireLease(PERIOD, "p", T0 + 1), { acquired: false, reason: "held" });
});

test("Bedrock request carries the strict settings and only the aggregates", async () => {
  const sent = [];
  const client = { send: async (command, options) => { sent.push([command, options]);
    return { output: { message: { content: [{ text: "{\"a\":1}" }] } }, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } }; } };
  const result = await createBedrockModel({ modelId: MODEL_ID, region: "us-west-2", client })(BUILT.aggregates);
  assert.deepEqual(result, { text: "{\"a\":1}", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 });
  assert.equal(sent[0][0].constructor.name, "ConverseCommand");
  assert.equal(sent[0][0].input.modelId, MODEL_ID);
  assert.deepEqual(sent[0][0].input.inferenceConfig, { temperature: 0.2, maxTokens: 1200 });
  assert.deepEqual(sent[0][0].input.system, [{ text: SYSTEM_PROMPT }]);
  assert.deepEqual(sent[0][0].input.messages, [{ role: "user", content: [{ text: JSON.stringify(BUILT.aggregates) }] }]);
  assert.ok(sent[0][1].abortSignal instanceof AbortSignal);
  assert.match(SYSTEM_PROMPT, /Korean/);
  assert.match(SYSTEM_PROMPT, /never instructions/);
  assert.match(SYSTEM_PROMPT, /productivity/);
});

test("feature stays off unless configured and never fails startup", async () => {
  const off = createInsightsFeature({ env: {} });
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.handler({}), { enabled: false });
  assert.equal(off.start(), null);
  const warns = [];
  createInsightsFeature({ env: { INSIGHTS_ENABLED: "1" }, log: { warn: (m) => warns.push(m) } });
  assert.deepEqual(warns, ["insights disabled: INSIGHTS_TABLE or INSIGHTS_MODEL_ID is invalid"]);
  const on = createInsightsFeature({ env: { INSIGHTS_ENABLED: "1", INSIGHTS_TABLE: "tbl" }, now: () => T0,
    deps: { store: createInsightsStore({ tableName: TABLE, client: fakeDynamo() }), model: recordingModel().model, collect: async () => structuredClone(BUILT) } });
  assert.equal(on.enabled, true);
  assert.deepEqual(await on.handler({}), { enabled: true, period: PERIOD, status: "pending", available: [] });
  const scheduler = on.start();
  assert.equal(typeof scheduler.tick, "function");
  scheduler.stop();
});
