import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTaskQuery, claudeTaskListSql, claudeCostSql, foldClaudeTasks,
  claudeCallCost, userTasks, TASK_LIMIT, codexTurnSql, codexCompletionSql, attachCompletions,
  sortTasks, taskCacheKey, CODEX_TURN_LIMIT } from "./taskTraces.js";
import { computeCost } from "./pricing.js";
import { GROUP_EXPR } from "./grouping.js";
import { DEFAULT_CODEX_PRICING, priceCodexUsage } from "./codexPricing.js";

const from = new Date("2026-11-05T00:00:00Z");
const to = new Date("2026-11-06T00:00:00Z");
const both = ["claude", "codex"];

// One llm_request call: [request_id, model, input, cache_read, cache_creation, output].
const call = (id, model = "claude-opus-5", input = "10", read = "0", write = "0", output = "5") =>
  [id, model, input, read, write, output];
const task = (overrides = {}) => ({
  trace_id: "t1", started_at: "2026-11-05T01:00:00Z", duration_ms: "1000", session_grp: "enterprise",
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

test("userTasks returns Claude tasks with coverage and never queries for disabled codex", async () => {
  const calls = [];
  const run = async (sql, params) => {
    calls.push({ sql, params });
    return sql.includes("otel_traces") ? [task()] : [{ request_id: "r1", cost_usd: 0.3 }];
  };
  const out = await userTasks(from, to, { userExact: "kim@x.com" }, ["claude"], run);
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0].cost_usd, 0.3);
  assert.deepEqual(out.coverage, { claude: "observed", codex: "not_requested" });
  assert.equal(out.unattached_codex, null);
  assert.equal(out.partial, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params.requestIds, ["r1"]);

  const empty = await userTasks(from, to, { userExact: "kim@x.com" }, ["claude"], async () => []);
  assert.deepEqual(empty.coverage, { claude: "empty", codex: "not_requested" });
});

test("claudeTaskListSql aliases the group without shadowing ug.grp", () => {
  const { sql } = claudeTaskListSql(from, to, validateTaskQuery({ userExact: "a" }, both));
  assert.ok(sql.includes(`${GROUP_EXPR} AS session_grp`));
  assert.ok(!sql.includes(`${GROUP_EXPR} AS grp`));
});

test("claudeCostSql ignores NULL duplicate deliveries", () => {
  const { sql } = claudeCostSql(from, to, ["r1"]);
  assert.ok(/anyIf\(reported, reported IS NOT NULL\) AS cost_usd/.test(sql));
  assert.ok(!/\bany\(/.test(sql));
});

test("taskCacheKey isolates users, clients and sorts", () => {
  const base = { from: "2026-11-05T00:00:00Z", to: "2026-11-06T00:00:00Z" };
  const kim = taskCacheKey({ ...base, userExact: "kim@x.com" }, both);
  const joakim = taskCacheKey({ ...base, userExact: "joakim@x.com" }, both);
  const codex = taskCacheKey({ ...base, userExact: "kim@x.com", client: "codex" }, both);
  const slow = taskCacheKey({ ...base, userExact: "kim@x.com", sort: "duration" }, both);
  assert.equal(new Set([kim, joakim, codex, slow]).size, 4);
  // Unread parameters and order do not split the key.
  assert.equal(taskCacheKey({ userExact: "kim@x.com", x: "1", ...base }, both), kim);
  assert.equal(taskCacheKey({ ...base, userExact: "kim@x.com", sort: "tokens" }, both), kim);
});

test("index.js keys the task route through taskCacheKey", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.match(src, /path === "\/api\/users\/tasks"\) return `\$\{path\}\?\$\{taskCacheKey\(query, clientConfig\.enabledClients\)\}`/);
});

// Codex fixtures: a turn window and usage-bearing completions.
const ms = (iso) => Date.parse(iso);
const turn = (overrides = {}) => ({
  conversation_id: "c1", turn_id: "u1", started_at: "2026-11-05T01:00:00Z",
  start_ms: String(ms("2026-11-05T01:00:00Z")), end_ms: String(ms("2026-11-05T01:00:10Z")),
  llm_calls: "2", models: ["openai.gpt-6-astra"], ...overrides,
});
let seq = 0;
const completion = (at, overrides = {}) => ({
  identity: `id${seq++}`, conversation_id: "c1", timestamp_ms: String(ms(at) + 50), event_timestamp: at,
  model: "openai.gpt-6-astra", effort: "high", backend_tag: "",
  input_token_count: "100", cached_token_count: "40", cache_write_token_count: "10",
  output_token_count: "20", reasoning_token_count: "5", ...overrides,
});
const opts = { prices: DEFAULT_CODEX_PRICING, from, to };
const unitCost = priceCodexUsage({ input_tokens_total: 100, cache_read_tokens: 40, cache_write_tokens: 10,
  output_tokens: 20, reasoning_tokens: 5, model: "openai.gpt-6-astra", backend: "bedrock-mantle",
  context_tier: "short" }, DEFAULT_CODEX_PRICING).cost_usd;

test("codexTurnSql uses client=codex predicate and exact user", () => {
  const { sql, params } = codexTurnSql(from, to, validateTaskQuery({ userExact: "kim@x.com" }, both));
  assert.ok(sql.includes("ResourceAttributes['client'] = 'codex'"));
  assert.ok(sql.includes("coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, ''), '') = {userExact:String}"));
  assert.ok(sql.includes("coalesce(nullIf(SpanAttributes['turn_id'], ''), SpanAttributes['turn.id'])"));
  assert.ok(sql.includes("SpanAttributes['conversation.id']"));
  assert.ok(sql.includes("SpanName = 'codex.sampling'"));
  assert.equal(params.userExact, "kim@x.com");
  assert.equal(params.spanTo, "2026-11-07 00:00:00");
  assert.ok(!sql.includes("kim@x.com"));
  assert.ok(!/positionCaseInsensitive|user_prompt|full_command|file_path/.test(sql));
});

test("codexCompletionSql selects deduplicated usage-bearing completions of the exact user", () => {
  const { sql, params } = codexCompletionSql(from, to, validateTaskQuery({ userExact: "kim@x.com" }, both));
  assert.ok(sql.includes("SELECT DISTINCT Timestamp, mapSort(ResourceAttributes) AS r, mapSort(LogAttributes) AS a"));
  assert.ok(sql.includes("a['event.name'] IN ('codex.sse_event', 'codex.websocket_event')"));
  assert.ok(sql.includes("a['event.kind'] = 'response.completed'"));
  assert.ok(sql.includes("'input_token_count'") && sql.includes("'reasoning_token_count'"));
  assert.ok(sql.includes("coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, ''), '') = {userExact:String}"));
  assert.ok(sql.includes("a['event.timestamp']") && sql.includes("a['model_reasoning_effort']"));
  assert.equal(params.logTo, "2026-11-07 00:00:00");
  assert.ok(!sql.includes("kim@x.com"));
  assert.ok(!/user_prompt|full_command|file_path/.test(sql));
});

test("attaches completion inside turn window", () => {
  const { tasks, unattached } = attachCompletions([turn()], [completion("2026-11-05T01:00:05Z")], opts);
  assert.equal(tasks.length, 1);
  const [t] = tasks;
  assert.equal(t.id, "codex:c1:u1");
  assert.equal(t.client, "codex");
  assert.equal(t.duration_ms, 10000);
  assert.equal(t.duration_basis, "observed_span_window");
  assert.equal(t.cost_basis, "linked_estimate");
  assert.equal(t.llm_calls, 2);
  assert.equal(t.subagents, null);
  assert.deepEqual(t.models, ["openai.gpt-6-astra"]);
  assert.equal(t.tokens.observed_tokens, 120);
  assert.equal(t.cost_usd, unitCost);
  assert.equal(t.cost_partial, false);
  assert.deepEqual(unattached, { completions: 0, cost_usd: 0, cost_partial: false });
  assert.ok(!JSON.stringify(t).includes("id0"), "completion identities stay server-side");
});

test("completion within slack attaches", () => {
  const out = attachCompletions([turn()], [completion("2026-11-05T01:00:14Z")], opts);
  assert.equal(out.tasks[0].tokens.observed_tokens, 120);
  assert.equal(out.unattached.completions, 0);
  const late = attachCompletions([turn()], [completion("2026-11-05T01:00:16Z")], opts);
  assert.equal(late.tasks[0].tokens.observed_tokens, null);
  assert.equal(late.unattached.completions, 1);
});

test("completion outside every window is unattached", () => {
  const rows = [completion("2026-11-05T03:00:00Z"), completion("2026-11-05T01:00:05Z", { conversation_id: "other" }),
    completion("2026-11-06T01:00:00Z")]; // the last is after the bucket: read for attachment only
  const { tasks, unattached } = attachCompletions([turn()], rows, opts);
  assert.equal(tasks[0].cost_usd, null);
  assert.equal(tasks[0].cost_partial, false);
  assert.equal(unattached.completions, 2);
  assert.equal(unattached.cost_usd, 2 * unitCost);
  assert.equal(unattached.cost_partial, false);
});

test("duplicate completion identity counts once", () => {
  const c = completion("2026-11-05T01:00:05Z");
  const lost = completion("2026-11-05T05:00:00Z");
  const { tasks, unattached } = attachCompletions([turn()], [c, { ...c }, lost, { ...lost }], opts);
  assert.equal(tasks[0].tokens.observed_tokens, 120);
  assert.equal(tasks[0].cost_usd, unitCost);
  assert.equal(unattached.completions, 1);
});

test("overlapping turns: latest start wins", () => {
  const early = turn({ turn_id: "u1" });
  const later = turn({ turn_id: "u2", started_at: "2026-11-05T01:00:04Z",
    start_ms: String(ms("2026-11-05T01:00:04Z")), end_ms: String(ms("2026-11-05T01:00:08Z")) });
  const { tasks } = attachCompletions([early, later], [completion("2026-11-05T01:00:06Z")], opts);
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
  assert.equal(byId["codex:c1:u2"].tokens.observed_tokens, 120);
  assert.equal(byId["codex:c1:u1"].tokens.observed_tokens, null);
});

test("codex tokens do not add cache or reasoning subsets", () => {
  const { tasks } = attachCompletions([turn()],
    [completion("2026-11-05T01:00:01Z"), completion("2026-11-05T01:00:02Z")], opts);
  assert.deepEqual(tasks[0].tokens, { input: 100, cache_read: 80, cache_write: 20, output: 40,
    observed_tokens: 240, tokens_partial: false });
});

test("unpriced completion makes cost null with cost_partial", () => {
  const unknown = { model: "mystery-model" };
  const { tasks, unattached } = attachCompletions([turn()], [completion("2026-11-05T01:00:01Z", unknown),
    completion("2026-11-05T09:00:00Z", unknown)], opts);
  assert.equal(tasks[0].cost_usd, null);
  assert.equal(tasks[0].cost_partial, true);
  assert.equal(tasks[0].tokens.observed_tokens, 120);
  assert.deepEqual(unattached, { completions: 1, cost_usd: null, cost_partial: true });
  const mixed = attachCompletions([turn()], [completion("2026-11-05T01:00:01Z", unknown),
    completion("2026-11-05T01:00:02Z")], opts);
  assert.equal(mixed.tasks[0].cost_usd, unitCost);
  assert.equal(mixed.tasks[0].cost_partial, true);
});

test("missing token fields stay unknown, not zero", () => {
  const { tasks } = attachCompletions([turn()], [completion("2026-11-05T01:00:01Z",
    { input_token_count: "", cached_token_count: "", cache_write_token_count: "" })], opts);
  assert.equal(tasks[0].tokens.observed_tokens, null);
  assert.equal(tasks[0].tokens.tokens_partial, true);
  assert.equal(tasks[0].tokens.input, null);
  assert.equal(tasks[0].tokens.output, 20);
  assert.equal(tasks[0].cost_usd, null);
  assert.equal(tasks[0].cost_partial, true);
});

test("backend filter keeps turns with matching completion evidence", () => {
  const other = turn({ turn_id: "u2", conversation_id: "c2" });
  const bare = turn({ turn_id: "u3", conversation_id: "c3" });
  const rows = [completion("2026-11-05T01:00:01Z"), completion("2026-11-05T01:00:01Z",
    { conversation_id: "c2", model: "us.openai.gpt-6-astra" }),
  completion("2026-11-05T09:00:00Z", { model: "us.openai.gpt-6-astra" })];
  const mantle = attachCompletions([turn(), other, bare], rows, { ...opts, backend: "bedrock-mantle" });
  assert.deepEqual(mantle.tasks.map(t => t.id), ["codex:c1:u1"]);
  assert.equal(mantle.unattached.completions, 0);
  const unknown = attachCompletions([turn(), other, bare], rows, { ...opts, backend: "unknown" });
  assert.deepEqual(unknown.tasks.map(t => t.id), ["codex:c3:u3"]);
});

test("merged list mixes clients sorted by tokens", () => {
  const claude = foldClaudeTasks([task({ trace_id: "big", calls: [call("r1", "claude-opus-5", "500")] }),
    task({ trace_id: "small", calls: [call("r2", "claude-opus-5", "1")] })], []);
  const { tasks: codex } = attachCompletions([turn()], [completion("2026-11-05T01:00:01Z")], opts);
  assert.deepEqual(sortTasks([...claude, ...codex], "tokens").map(t => t.id),
    ["claude:big", "codex:c1:u1", "claude:small"]);
  assert.deepEqual(sortTasks([...claude, ...codex], "duration").map(t => t.id)[0], "codex:c1:u1");
});

test("userTasks merges Codex turns, counts skipped turns and keeps 20", async () => {
  const calls = [];
  const turns = [...Array.from({ length: 25 }, (_, i) => turn({ turn_id: `u${i}`,
    start_ms: String(ms("2026-11-05T01:00:00Z") + i * 60000), end_ms: String(ms("2026-11-05T01:00:10Z") + i * 60000) })),
  turn({ turn_id: "orphan", conversation_id: "" })];
  const run = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("otel_traces") && sql.includes("'codex'")) return turns;
    if (sql.includes("otel_traces")) return [task({ calls: [call("r1", "claude-opus-5", "100000")] })];
    if (sql.includes("codex.sse_event")) return [completion("2026-11-05T01:00:01Z"), completion("2026-11-05T09:00:00Z")];
    return [{ request_id: "r1", cost_usd: 0.3 }];
  };
  const out = await userTasks(from, to, { userExact: "kim@x.com" }, both, run);
  assert.equal(out.tasks.length, 20);
  assert.equal(out.tasks[0].id, "claude:t1");
  assert.equal(out.tasks[1].id, "codex:c1:u0");
  assert.deepEqual(out.coverage, { claude: "observed", codex: "observed" });
  assert.equal(out.unattached_codex.completions, 1);
  assert.equal(out.unattached_codex.turns_without_conversation, 1);
  assert.ok(!out.tasks.some(t => t.id.includes("orphan")));

  const claudeOnly = [];
  const res = await userTasks(from, to, { userExact: "a", client: "claude" }, both,
    async (sql, p) => { claudeOnly.push(sql); return []; });
  assert.ok(claudeOnly.every(sql => !sql.includes("'codex'") && !sql.includes("codex.sse_event")));
  assert.equal(res.unattached_codex, null);
  assert.equal(res.coverage.codex, "not_requested");

  const codexOnly = [];
  const res2 = await userTasks(from, to, { userExact: "a" }, ["codex"], async (sql) => { codexOnly.push(sql); return []; });
  assert.equal(codexOnly.length, 2);
  assert.ok(codexOnly.every(sql => !sql.includes("SpanType = 'interaction'")));
  assert.deepEqual(res2.coverage, { claude: "not_requested", codex: "empty" });
  assert.deepEqual(res2.unattached_codex, { completions: 0, cost_usd: 0, cost_partial: false,
    turns_without_conversation: 0 });

  // Group filters Claude tasks only; Codex rows are still returned.
  const grouped = [];
  await userTasks(from, to, { userExact: "a", group: "bedrock" }, both, async (sql, p) => { grouped.push({ sql, p }); return []; });
  assert.ok(grouped.filter(g => g.sql.includes("'codex'") || g.sql.includes("codex.sse_event"))
    .every(g => !g.sql.includes("{group:String}") && g.p.group === undefined));
});

test("userTasks marks Codex coverage limited when a row guard is hit", async () => {
  const many = Array.from({ length: CODEX_TURN_LIMIT + 1 }, (_, i) => turn({ turn_id: `u${i}` }));
  const out = await userTasks(from, to, { userExact: "a", client: "codex" }, both,
    async (sql) => (sql.includes("otel_traces") ? many : []));
  assert.equal(out.coverage.codex, "limited");
  assert.equal(out.unattached_codex.cost_partial, true);
  assert.equal(out.tasks.length, TASK_LIMIT);
});
