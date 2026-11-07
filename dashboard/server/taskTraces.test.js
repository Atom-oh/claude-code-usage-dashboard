import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTaskQuery, claudeTaskListSql, claudeCostSql, foldClaudeTasks,
  claudeCallCost, userTasks, TASK_LIMIT } from "./taskTraces.js";
import { computeCost } from "./pricing.js";

const from = new Date("2026-11-05T00:00:00Z");
const to = new Date("2026-11-06T00:00:00Z");
const both = ["claude", "codex"];

// One llm_request call: [request_id, model, input, cache_read, cache_creation, output].
const call = (id, model = "claude-opus-5", input = "10", read = "0", write = "0", output = "5") =>
  [id, model, input, read, write, output];
const task = (overrides = {}) => ({
  trace_id: "t1", started_at: "2026-11-05T01:00:00Z", duration_ms: "1000", grp: "enterprise",
  llm_calls: "1", subagents: "0", calls: [call("r1")], ...overrides,
});

test("validateTaskQuery requires userExact", () => {
  assert.throws(() => validateTaskQuery({}, both), { name: "ValidationError" });
  assert.throws(() => validateTaskQuery({ userExact: "" }, both), { name: "ValidationError" });
  assert.throws(() => validateTaskQuery({ userExact: "x".repeat(257) }, both), { name: "ValidationError" });
  assert.throws(() => validateTaskQuery({ userExact: ["a", "b"] }, both), { name: "ValidationError" });
  const q = validateTaskQuery({ userExact: "kim@x.com" }, both);
  assert.deepEqual(q, { clients: both, userExact: "kim@x.com", backend: "", group: "", sort: "tokens" });
});

test("validateTaskQuery rejects sort=foo", () => {
  assert.throws(() => validateTaskQuery({ userExact: "a", sort: "foo" }, both), { name: "ValidationError" });
  assert.equal(validateTaskQuery({ userExact: "a", sort: "duration" }, both).sort, "duration");
});

test("validateTaskQuery omits disabled codex", () => {
  assert.deepEqual(validateTaskQuery({ userExact: "a" }, ["claude"]).clients, ["claude"]);
  assert.throws(() => validateTaskQuery({ userExact: "a", client: "codex" }, ["claude"]), { name: "ValidationError" });
});

test("validateTaskQuery accepts group only when claude is selected", () => {
  assert.equal(validateTaskQuery({ userExact: "a", group: "bedrock" }, both).group, "bedrock");
  assert.throws(() => validateTaskQuery({ userExact: "a", group: "bedrock", client: "codex" }, both),
    { name: "ValidationError" });
  assert.throws(() => validateTaskQuery({ userExact: "a", group: "bedrock" }, ["codex"]), { name: "ValidationError" });
  assert.throws(() => validateTaskQuery({ userExact: "a", backend: "nope" }, both), { name: "ValidationError" });
  assert.equal(validateTaskQuery({ userExact: "a", backend: "anthropic" }, both).backend, "anthropic");
});

test("claudeTaskListSql binds userExact and uses equality", () => {
  const q = validateTaskQuery({ userExact: "kim@x.com" }, both);
  const { sql, params } = claudeTaskListSql(from, to, q);
  assert.equal(params.userExact, "kim@x.com");
  assert.ok(sql.includes("coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, ''), '') = {userExact:String}"));
  assert.ok(!sql.includes("kim@x.com"));
  assert.ok(!/positionCaseInsensitive/.test(sql));
  assert.ok(!/user_prompt|full_command|file_path/.test(sql));
});

test("claudeTaskListSql widens span window by 24h", () => {
  const q = validateTaskQuery({ userExact: "a" }, both);
  const { sql, params } = claudeTaskListSql(from, to, q);
  assert.equal(params.from, "2026-11-05 00:00:00");
  assert.equal(params.to, "2026-11-06 00:00:00");
  assert.equal(params.spanTo, "2026-11-07 00:00:00");
  assert.ok(sql.includes("Timestamp < {spanTo:DateTime}"));
  assert.ok(sql.includes("SpanType = 'interaction'"));
  assert.ok(sql.includes(`LIMIT ${TASK_LIMIT}`));
});

test("claudeTaskListSql filters group and backend through bound params", () => {
  const q = validateTaskQuery({ userExact: "a", group: "bedrock", backend: "bedrock-runtime", sort: "duration" }, both);
  const { sql, params } = claudeTaskListSql(from, to, q);
  assert.equal(params.group, "bedrock");
  assert.equal(params.backend, "bedrock-runtime");
  assert.ok(sql.includes("session_group"));
  assert.ok(sql.includes("= {group:String}"));
  assert.ok(sql.includes("{backend:String}"));
  assert.ok(/ORDER BY t\.duration_ms DESC/.test(sql));
});

test("claudeCostSql binds request ids in the widened log window", () => {
  const { sql, params } = claudeCostSql(from, to, ["r1", "r2"]);
  assert.deepEqual(params.requestIds, ["r1", "r2"]);
  assert.equal(params.logTo, "2026-11-07 00:00:00");
  assert.ok(sql.includes("{requestIds:Array(String)}"));
  assert.ok(sql.includes("'api_request'"));
});

test("foldClaudeTasks sorts by observed tokens and keeps 20", () => {
  const rows = Array.from({ length: 25 }, (_, i) =>
    task({ trace_id: `t${i}`, calls: [call(`r${i}`, "claude-opus-5", String(i * 10))] }));
  const out = foldClaudeTasks(rows, []);
  assert.equal(out.length, 20);
  assert.equal(out[0].id, "claude:t24");
  assert.equal(out[0].tokens.observed_tokens, 245);
  assert.ok(out.every((t, i) => i === 0 || out[i - 1].tokens.observed_tokens >= t.tokens.observed_tokens));
  assert.equal(out[0].client, "claude");
  assert.equal(out[0].duration_basis, "interaction_span");
  assert.ok(!JSON.stringify(out).includes("r24"), "request ids stay server-side");
});

test("sort=duration orders by duration_ms", () => {
  const rows = [task({ trace_id: "a", duration_ms: "5" }), task({ trace_id: "b", duration_ms: "50" }),
    task({ trace_id: "c", duration_ms: "20" })];
  assert.deepEqual(foldClaudeTasks(rows, [], { sort: "duration" }).map(t => t.id),
    ["claude:b", "claude:c", "claude:a"]);
  assert.equal(foldClaudeTasks(rows, [], { sort: "duration" })[0].duration_ms, 50);
});

test("claudeCallCost uses reported cost for claude-opus", () => {
  const tokens = { input: 10, cache_read: 0, cache_write: 0, output: 5 };
  assert.deepEqual(claudeCallCost({ model: "claude-opus-5", backend: "anthropic", tokens, reported: 0.42 }),
    { cost_usd: 0.42, basis: "client_reported" });
  const computed = claudeCallCost({ model: "claude-opus-5", backend: "anthropic", tokens, reported: null });
  assert.equal(computed.basis, "computed");
  assert.equal(computed.cost_usd, computeCost("claude-opus-5", "anthropic",
    { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }));
  assert.deepEqual(claudeCallCost({ model: "claude-opus-5", backend: "anthropic",
    tokens: { input: null, cache_read: 0, cache_write: 0, output: 5 }, reported: null }),
  { cost_usd: null, basis: "computed" });
});

test("claudeCallCost uses AWS list estimate for non-Anthropic model and ignores reported", () => {
  // Same live request as nonAnthropicCost.test.js: reported $1.819543, AWS list $0.099921.
  const result = claudeCallCost({ model: "us.openai.gpt-6-luna", backend: "bedrock-runtime",
    tokens: { input: 2, cache_read: 0, cache_write: 361675, output: 558 }, reported: 1.819543 });
  assert.equal(result.basis, "aws_list_estimate");
  assert.equal(Math.round(result.cost_usd * 1e6), 99921);
});

test("claudeCallCost returns null for unpriced non-Anthropic", () => {
  assert.deepEqual(claudeCallCost({ model: "gemma-4-31b-vllm", backend: "unknown",
    tokens: { input: 2, cache_read: 0, cache_write: 0, output: 5 }, reported: 3 }),
  { cost_usd: null, basis: "aws_list_estimate" });
});

test("task cost_basis is mixed when calls differ", () => {
  const rows = [task({ llm_calls: "2", calls: [call("r1"), call("r2")] })];
  const out = foldClaudeTasks(rows, [{ request_id: "r1", cost_usd: 0.5 }]);
  assert.equal(out[0].cost_basis, "mixed");
  assert.equal(out[0].cost_partial, false);
  const expected = 0.5 + computeCost("claude-opus-5", "anthropic", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  assert.ok(Math.abs(out[0].cost_usd - expected) < 1e-12);
  const reportedOnly = foldClaudeTasks(rows, [{ request_id: "r1", cost_usd: 0.5 }, { request_id: "r2", cost_usd: "0.25" }]);
  assert.equal(reportedOnly[0].cost_basis, "client_reported");
  assert.equal(reportedOnly[0].cost_usd, 0.75);
});

test("all-unknown tokens stay null", () => {
  const rows = [task({ calls: [call("r1", "gemma-4-31b-vllm", "", "", "", "")] })];
  const [t] = foldClaudeTasks(rows, []);
  assert.deepEqual(t.tokens, { input: null, cache_read: null, cache_write: null, output: null,
    observed_tokens: null, tokens_partial: true });
  assert.equal(t.cost_usd, null);
  assert.equal(t.cost_partial, true);
  // A task with no observed LLM calls is unavailable, not zero.
  const [empty] = foldClaudeTasks([task({ llm_calls: "0", calls: [] })], []);
  assert.equal(empty.tokens.observed_tokens, null);
  assert.equal(empty.cost_usd, null);
});

test("partial tokens keep known subtotals and flag partial cost", () => {
  const rows = [task({ llm_calls: "2", calls: [call("r1"), call("r2", "claude-opus-5", "", "1", "2", "3")] })];
  const [t] = foldClaudeTasks(rows, [{ request_id: "r1", cost_usd: 0.1 }]);
  assert.equal(t.tokens.input, 10);
  assert.equal(t.tokens.output, 8);
  assert.equal(t.tokens.observed_tokens, 15);
  assert.equal(t.tokens.tokens_partial, true);
  assert.equal(t.cost_usd, 0.1);
  assert.equal(t.cost_partial, true);
  assert.deepEqual(t.models, ["claude-opus-5"]);
});

test("userTasks returns Claude tasks with coverage and never queries for disabled claude", async () => {
  const calls = [];
  const run = async (sql, params) => {
    calls.push({ sql, params });
    return sql.includes("otel_traces") ? [task()] : [{ request_id: "r1", cost_usd: 0.3 }];
  };
  const out = await userTasks(from, to, { userExact: "kim@x.com" }, both, run);
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0].cost_usd, 0.3);
  assert.deepEqual(out.coverage, { claude: "observed", codex: "not_requested" });
  assert.equal(out.unattached_codex, null);
  assert.equal(out.partial, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params.requestIds, ["r1"]);

  const empty = await userTasks(from, to, { userExact: "kim@x.com" }, both, async () => []);
  assert.deepEqual(empty.coverage, { claude: "empty", codex: "not_requested" });

  const none = [];
  const codexOnly = await userTasks(from, to, { userExact: "a" }, ["codex"], async (...a) => { none.push(a); return []; });
  assert.equal(none.length, 0);
  assert.deepEqual(codexOnly, { tasks: [], unattached_codex: null,
    coverage: { claude: "not_requested", codex: "not_requested" }, partial: true });
});
