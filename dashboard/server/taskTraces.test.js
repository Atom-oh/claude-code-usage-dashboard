import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTaskQuery, claudeTaskListSql, claudeCostSql, foldClaudeTasks,
  claudeCallCost, userTasks, TASK_LIMIT, codexTurnSql, codexCompletionSql, attachCompletions,
  sortTasks, taskCacheKey, CODEX_TURN_LIMIT, linkCompletions, isUniqueTurnId, COST_CANDIDATES,
  workflowPairs, WORKFLOW_RUN_ID, claudeCostRows, COST_ID_PARAM_BYTES, codexRetries, namesTurnOnTools, emitsTurnCompactions, foldCodexTask } from "./taskTraces.js";
import { computeCost } from "./pricing.js";
import { GROUP_EXPR } from "./grouping.js";
import { DEFAULT_CODEX_PRICING, priceCodexUsage } from "./codexPricing.js";

const from = new Date("2026-11-05T00:00:00Z");
const to = new Date("2026-11-06T00:00:00Z");
const both = ["claude", "codex"];

// One llm_request call: [request_id, model, input, cache_read, cache_creation, output, org?].
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

test("validateTaskQuery accepts the four sorts and names them in the error", () => {
  for (const sort of ["tokens", "cost", "subagents", "duration"])
    assert.equal(validateTaskQuery({ userExact: "a", sort }, both).sort, sort);
  assert.throws(() => validateTaskQuery({ userExact: "a", sort: "subagent" }, both),
    (err) => err.name === "ValidationError" && /tokens, cost, subagents or duration/.test(err.detail ?? err.message));
});

test("claudeTaskListSql orders and limits per sort", () => {
  const sqlFor = (sort) => claudeTaskListSql(from, to, validateTaskQuery({ userExact: "a", sort }, both)).sql;
  const tail = (sql) => sql.slice(sql.lastIndexOf("ORDER BY"));
  assert.match(tail(sqlFor("tokens")), /^ORDER BY s\.sort_tokens DESC, t\.duration_ms DESC, t\.TraceId\s+LIMIT 20$/);
  assert.match(tail(sqlFor("duration")), /^ORDER BY t\.duration_ms DESC, s\.sort_tokens DESC, t\.TraceId\s+LIMIT 20$/);
  assert.match(tail(sqlFor("subagents")), /^ORDER BY s\.subagents DESC, s\.sort_tokens DESC, t\.TraceId\s+LIMIT 20$/);
  // Cost is priced in JS: SQL selects the token-ordered candidate pool.
  assert.equal(COST_CANDIDATES, 100);
  assert.match(tail(sqlFor("cost")), /^ORDER BY s\.sort_tokens DESC, t\.duration_ms DESC, t\.TraceId\s+LIMIT 100$/);
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

test("validateTaskQuery accepts workflowRunId only as a wf_ id for Claude alone", () => {
  const id = "wf_abc-123_X";
  assert.equal(validateTaskQuery({ userExact: "a", workflowRunId: id, client: "claude" }, both).workflowRunId, id);
  assert.equal(validateTaskQuery({ userExact: "a", workflowRunId: id }, ["claude"]).workflowRunId, id);
  assert.equal(validateTaskQuery({ userExact: "a", workflowRunId: "" }, both).workflowRunId, undefined);
  for (const bad of ["abc", "wf_", "wf_a b", "wf_a'b", "wf_" + "a".repeat(129), ["wf_a", "wf_b"], 7])
    assert.throws(() => validateTaskQuery({ userExact: "a", workflowRunId: bad, client: "claude" }, both),
      { name: "ValidationError", message: "invalid filter" });
  // Codex has no workflow runs: both clients (the default) or Codex alone is rejected.
  for (const client of [undefined, "codex"])
    assert.throws(() => validateTaskQuery({ userExact: "a", workflowRunId: id, client }, both),
      { name: "ValidationError", message: "unsupported filter" });
});

test("claudeTaskListSql filters workflow runs through a bound param over every span", () => {
  const plain = claudeTaskListSql(from, to, validateTaskQuery({ userExact: "a" }, both));
  assert.ok(!plain.sql.includes("{workflowRunId:String}"));
  assert.equal(plain.params.workflowRunId, undefined);
  const q = validateTaskQuery({ userExact: "a", workflowRunId: "wf_run1", client: "claude" }, both);
  const { sql, params } = claudeTaskListSql(from, to, q);
  assert.equal(params.workflowRunId, "wf_run1");
  assert.ok(!sql.includes("wf_run1"));
  assert.ok(sql.includes("SpanAttributes['workflow.run_id'] AS workflow_run_id"));
  assert.ok(sql.includes("SpanAttributes['workflow.name'] AS workflow_name"));
  // Collected over all spans of the trace (agent spans), not only llm_request spans.
  assert.ok(sql.includes("groupUniqArrayIf([workflow_run_id, workflow_name], match(workflow_run_id, '^wf_[A-Za-z0-9_-]{1,128}$')) AS workflows"));
  // SQL and fold agree on the run id shape, so a name match never reports an empty workflows list.
  for (const id of ["wf_a", "wf_a-B_9", "wf_" + "a".repeat(128)]) assert.ok(WORKFLOW_RUN_ID.test(id));
  for (const id of ["wf_", "x_a", "wf_a b", "wf_" + "a".repeat(129)]) assert.ok(!WORKFLOW_RUN_ID.test(id));
  assert.ok(sql.includes("AND arrayExists(w -> w[1] = {workflowRunId:String}, s.workflows)"));
  assert.ok(!sql.includes("{workflowName:String}"));
  const named = claudeTaskListSql(from, to,
    validateTaskQuery({ userExact: "a", workflowName: "review-changes", client: "claude" }, both));
  assert.equal(named.params.workflowName, "review-changes");
  assert.ok(!named.sql.includes("review-changes"));
  assert.ok(named.sql.includes("AND arrayExists(w -> w[2] = {workflowName:String}, s.workflows)"));
});

test("validateTaskQuery accepts workflowName only as a label for Claude alone", () => {
  for (const name of ["review-changes", "a", "v1.2:nightly_x"])
    assert.equal(validateTaskQuery({ userExact: "a", workflowName: name, client: "claude" }, both).workflowName, name);
  assert.equal(validateTaskQuery({ userExact: "a", workflowName: "" }, both).workflowName, undefined);
  for (const bad of ["-x", "a b", "a/b", "a'b", "x".repeat(129), ["a"], 7])
    assert.throws(() => validateTaskQuery({ userExact: "a", workflowName: bad, client: "claude" }, both),
      { name: "ValidationError", message: "invalid filter" });
  assert.throws(() => validateTaskQuery({ userExact: "a", workflowName: "x" }, both),
    { name: "ValidationError", message: "unsupported filter" });
});

test("workflowPairs keeps valid run ids once, sorted, with labelled names or null", () => {
  assert.deepEqual(workflowPairs(undefined), []);
  assert.deepEqual(workflowPairs([
    ["wf_b", "build"], ["wf_a", "free text name"], ["not-a-run", "x"], ["wf_b", "alpha"],
    ["wf_c", ""], "junk", ["wf_a", null],
  ]), [{ run_id: "wf_a", name: null }, { run_id: "wf_b", name: "alpha" }, { run_id: "wf_c", name: null }]);
});

test("foldTask reports the task's workflow runs", () => {
  const [folded] = foldClaudeTasks([task({ workflows: [["wf_run1", "review-changes"]] })], []);
  assert.deepEqual(folded.workflows, [{ run_id: "wf_run1", name: "review-changes" }]);
  assert.deepEqual(foldClaudeTasks([task()], [])[0].workflows, []);
});

test("userTasks with workflowRunId queries only Claude", async () => {
  const seen = [];
  const run = async (sql, params) => { seen.push({ sql, params }); return []; };
  const out = await userTasks(from, to, { userExact: "a", workflowRunId: "wf_run1", client: "claude" }, both, run);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].params.workflowRunId, "wf_run1");
  assert.deepEqual(out.coverage, { claude: "empty", codex: "not_requested" });
});

test("claudeCostSql binds request ids in the widened log window", () => {
  const { sql, params } = claudeCostSql(from, to, ["r1", "r2"]);
  assert.deepEqual(params.requestIds, ["r1", "r2"]);
  assert.equal(params.logTo, "2026-11-07 00:00:00");
  assert.ok(sql.includes("{requestIds:Array(String)}"));
  assert.ok(sql.includes("'api_request'"));
});

test("claudeCostRows splits request ids into parameters below the HTTP form field limit", async () => {
  // sort=cost over 100 interactions measured 7,716 ids (239 KB as JSON) in production; one
  // parameter that size fails ClickHouse's 128 KiB form-field limit with HTTP 500.
  const ids = Array.from({ length: 7716 }, (_, i) => `req_${String(i).padStart(24, "0")}`);
  const calls = [];
  const rows = await claudeCostRows(from, to, ids, async (sql, params) => {
    calls.push(params);
    return params.requestIds.map((request_id) => ({ request_id, cost_usd: 0.01 }));
  });
  assert.ok(COST_ID_PARAM_BYTES < 128 * 1024);
  assert.ok(calls.length > 1);
  // Budget the encoded size: the form body percent-encodes quotes, commas and brackets.
  for (const p of calls) assert.ok(encodeURIComponent(JSON.stringify(p.requestIds)).length <= COST_ID_PARAM_BYTES);
  assert.deepEqual(calls.flatMap((p) => p.requestIds), ids);
  assert.equal(rows.length, ids.length);
  assert.deepEqual(await claudeCostRows(from, to, [], async () => { throw new Error("no query"); }), []);
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

test("sortTasks by cost and subagents keeps unknown values last", () => {
  const t = (id, cost_usd, subagents, observed_tokens) => ({ id, cost_usd, subagents, duration_ms: 1,
    tokens: { observed_tokens } });
  const tasks = [t("claude:a", 0.5, 1, 10), t("claude:b", null, 3, 999), t("claude:c", 2, 0, 5),
    t("claude:d", 0.5, 1, 50), t("codex:x:1", 0.1, null, 2000), t("claude:e", 0, 3, 1)];
  assert.deepEqual(sortTasks(tasks, "cost").map(x => x.id),
    ["claude:c", "claude:d", "claude:a", "codex:x:1", "claude:e", "claude:b"]);
  assert.deepEqual(sortTasks(tasks, "subagents").map(x => x.id),
    ["claude:b", "claude:e", "claude:d", "claude:a", "claude:c", "codex:x:1"]);
  // Full ties fall back to the id.
  assert.deepEqual(sortTasks([t("claude:z", 1, 1, 1), t("claude:y", 1, 1, 1)], "cost").map(x => x.id),
    ["claude:y", "claude:z"]);
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

test("a login call in a Bedrock-channel session is priced as Anthropic", () => {
  // Resumed session: Bedrock call first, then a bare-id call whose span carried organization.id.
  const rows = [task({ session_grp: "bedrock", llm_calls: "2", calls: [
    call("r1", "global.anthropic.claude-opus-5"), [...call("r2"), "1"]] })];
  const [t] = foldClaudeTasks(rows, []);
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
  const expected = computeCost("claude-opus-5", "bedrock-runtime", usage) + computeCost("claude-opus-5", "anthropic", usage);
  assert.ok(Math.abs(t.cost_usd - expected) < 1e-12);
  assert.equal(t.cost_partial, false);
});

test("claudeTaskListSql keeps the call org flag out of returned columns", () => {
  const { sql } = claudeTaskListSql(from, to, validateTaskQuery({ userExact: "a", backend: "anthropic" }, both));
  assert.match(sql, /groupUniqArrayIf\(\[Model, org\]/);
  assert.match(sql, /startsWith\(m\[1\], 'claude-'\)/);
  assert.match(sql, /if\(SpanAttributes\['organization\.id'\] != '', '1', ''\) AS org/);
  assert.doesNotMatch(sql, /SpanAttributes\['organization\.id'\] AS/);
  // The trace backend filter never applies the session provider rule.
  assert.doesNotMatch(sql, /ug\.provider_bedrock = 1/);
});

test("a scrubbed login call in a provider-reported Bedrock session is not priced as Bedrock runtime", () => {
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
  const [t] = foldClaudeTasks([task({ session_grp: "bedrock", session_provider_bedrock: "1", calls: [call("r1")] })], []);
  assert.equal(t.cost_usd, computeCost("claude-opus-5", "unknown", usage));
  assert.equal(t.cost_partial, false);
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
  const costly = taskCacheKey({ ...base, userExact: "kim@x.com", sort: "cost" }, both);
  const agents = taskCacheKey({ ...base, userExact: "kim@x.com", sort: "subagents" }, both);
  assert.equal(new Set([kim, joakim, codex, slow, costly, agents]).size, 6);
  // Unread parameters and order do not split the key.
  assert.equal(taskCacheKey({ userExact: "kim@x.com", x: "1", ...base }, both), kim);
  assert.equal(taskCacheKey({ ...base, userExact: "kim@x.com", sort: "tokens" }, both), kim);
  const run1 = taskCacheKey({ ...base, userExact: "kim@x.com", client: "claude", workflowRunId: "wf_1" }, both);
  const run2 = taskCacheKey({ ...base, userExact: "kim@x.com", client: "claude", workflowRunId: "wf_2" }, both);
  const claudeOnly = taskCacheKey({ ...base, userExact: "kim@x.com", client: "claude" }, both);
  assert.equal(new Set([run1, run2, claudeOnly]).size, 3);
  assert.equal(taskCacheKey({ ...base, userExact: "kim@x.com", client: "claude", workflowRunId: "" }, both), claudeOnly);
  const named = taskCacheKey({ ...base, userExact: "kim@x.com", client: "claude", workflowName: "review" }, both);
  assert.equal(new Set([named, run1, claudeOnly]).size, 3);
});

test("index.js keys the task route through taskCacheKey", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.match(src, /path === "\/api\/users\/tasks"\) return `\$\{path\}\?\$\{taskCacheKey\(query, clientConfig\.enabledClients\)\}`/);
});

// Codex fixtures: a turn window and usage-bearing completions. Turn ids are UUID-shaped,
// as Codex emits them; a synthetic id (auto-compact-N) is unlinkable.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const U1 = uuid(1), U2 = uuid(2), U3 = uuid(3);
const ms = (iso) => Date.parse(iso);
const turn = (overrides = {}) => ({
  conversation_id: "c1", turn_id: U1, started_at: "2026-11-05T01:00:00Z",
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
  // Legacy turns fall back to run_sampling_request; one span kind per turn, never both.
  assert.ok(sql.includes("if(sampling_calls > 0, sampling_calls, legacy_calls) AS llm_calls"));
  assert.ok(sql.includes("if(sampling_calls > 0, 'codex.sampling', 'run_sampling_request') AS sampling_span"));
  // Turn-id spans only, filtered in the inner query before the per-span dedupe.
  const inner = sql.slice(sql.indexOf("FROM claude_code.otel_traces"), sql.indexOf("LIMIT 1 BY TraceId, SpanId"));
  assert.ok(inner.includes("(SpanAttributes['turn_id'] != '' OR SpanAttributes['turn.id'] != '')"));
  // PREWHERE reads promoted columns only: the span window and the exact user.
  const prewhere = inner.slice(inner.indexOf("PREWHERE"), inner.indexOf("WHERE ResourceAttributes"));
  assert.match(prewhere, /^PREWHERE Timestamp >= \{spanFrom:DateTime\} AND Timestamp < \{spanTo:DateTime\}\s+AND coalesce\(nullIf\(UserEmail, ''\), nullIf\(EndUserId, ''\), ''\) = \{userExact:String\}\s*$/);
  assert.equal(params.userExact, "kim@x.com");
  assert.equal(params.spanTo, "2026-11-07 00:00:00");
  assert.ok(!sql.includes("kim@x.com"));
  assert.ok(!/positionCaseInsensitive|user_prompt|full_command|file_path/.test(sql));
});

test("codexCompletionSql selects deduplicated usage-bearing completions of the exact user", () => {
  const { sql, params } = codexCompletionSql(from, to, validateTaskQuery({ userExact: "kim@x.com" }, both));
  // One-pass hash identity over the full sorted maps; no DISTINCT or stringified maps.
  assert.ok(sql.includes("cityHash64(Timestamp, mapSort(ResourceAttributes), mapSort(LogAttributes)) AS identity_hash"));
  assert.match(sql, /LIMIT 1 BY identity_hash\s+LIMIT 50001\b/);
  assert.doesNotMatch(sql, /DISTINCT|toString\((r|a|ResourceAttributes|LogAttributes|mapSort)\b/);
  // PREWHERE reads promoted columns only: time, stream event names and the exact user.
  const prewhere = sql.slice(sql.indexOf("PREWHERE"), sql.indexOf("\n    WHERE"));
  assert.ok(prewhere.startsWith("PREWHERE Timestamp >= {logFrom:DateTime} AND Timestamp < {logTo:DateTime}"));
  assert.ok(prewhere.includes("EventName IN ('codex.sse_event', 'codex.websocket_event')"));
  assert.ok(prewhere.includes("coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, ''), '') = {userExact:String}"));
  assert.doesNotMatch(prewhere, /Attributes\[/);
  assert.ok(sql.includes("LogAttributes['event.name'] IN ('codex.sse_event', 'codex.websocket_event')"));
  assert.ok(sql.includes("LogAttributes['event.kind'] = 'response.completed'"));
  assert.ok(sql.includes("'input_token_count'") && sql.includes("'reasoning_token_count'"));
  assert.ok(sql.includes("coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, ''), '') = {userExact:String}"));
  assert.ok(sql.includes("LogAttributes['event.timestamp']") && sql.includes("LogAttributes['model_reasoning_effort']"));
  assert.equal(params.logTo, "2026-11-07 00:00:00");
  assert.ok(!sql.includes("kim@x.com"));
  assert.ok(!/user_prompt|full_command|file_path/.test(sql));
});

test("attaches completion inside turn window", () => {
  const { tasks, unattached } = attachCompletions([turn()], [completion("2026-11-05T01:00:05Z")], opts);
  assert.equal(tasks.length, 1);
  const [t] = tasks;
  assert.equal(t.id, `codex:c1:${U1}`);
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
  const early = turn({ turn_id: U1 });
  const later = turn({ turn_id: U2, started_at: "2026-11-05T01:00:04Z",
    start_ms: String(ms("2026-11-05T01:00:04Z")), end_ms: String(ms("2026-11-05T01:00:08Z")) });
  const { tasks } = attachCompletions([early, later], [completion("2026-11-05T01:00:06Z")], opts);
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
  assert.equal(byId[`codex:c1:${U2}`].tokens.observed_tokens, 120);
  assert.equal(byId[`codex:c1:${U1}`].tokens.observed_tokens, null);
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
  const other = turn({ turn_id: U2, conversation_id: "c2" });
  const bare = turn({ turn_id: U3, conversation_id: "c3" });
  const rows = [completion("2026-11-05T01:00:01Z"), completion("2026-11-05T01:00:01Z",
    { conversation_id: "c2", model: "us.openai.gpt-6-astra" }),
  completion("2026-11-05T09:00:00Z", { model: "us.openai.gpt-6-astra" })];
  const mantle = attachCompletions([turn(), other, bare], rows, { ...opts, backend: "bedrock-mantle" });
  assert.deepEqual(mantle.tasks.map(t => t.id), [`codex:c1:${U1}`]);
  assert.equal(mantle.unattached.completions, 0);
  const unknown = attachCompletions([turn(), other, bare], rows, { ...opts, backend: "unknown" });
  assert.deepEqual(unknown.tasks.map(t => t.id), [`codex:c3:${U3}`]);
});

test("a synthetic turn id is unlinkable: not listed, counted, its completions unattached", () => {
  // auto-compact-1 repeats across conversations: GROUP BY turn id merges both into one row.
  const merged = turn({ turn_id: "auto-compact-1", conversation_id: "c2",
    start_ms: String(ms("2026-11-05T02:00:00Z")), end_ms: String(ms("2026-11-05T02:00:10Z")) });
  const context = turn({ turn_id: "auto-compact-2", in_bucket: "0" });
  const rows = [completion("2026-11-05T01:00:05Z"), completion("2026-11-05T02:00:05Z", { conversation_id: "c2" })];
  const out = attachCompletions([turn(), merged, context], rows, opts);
  assert.deepEqual(out.tasks.map(t => t.id), [`codex:c1:${U1}`]);
  assert.equal(out.non_unique_turns, 1, "context turns are not counted");
  assert.equal(out.skipped_turns, 0);
  assert.equal(out.unattached.completions, 1);
  assert.equal(out.unattached.cost_usd, unitCost);
  // A synthetic turn never wins a completion over a UUID turn of the same window.
  const overlap = turn({ turn_id: "auto-compact-3", start_ms: String(ms("2026-11-05T01:00:04Z")) });
  const won = attachCompletions([turn(), overlap], [completion("2026-11-05T01:00:06Z")], opts);
  assert.equal(won.tasks[0].tokens.observed_tokens, 120);
  assert.ok(!linkCompletions([overlap], [], { prices: DEFAULT_CODEX_PRICING }).entries.length);
  for (const id of ["auto-compact-1", "turn-2", "", `${U1}x`, U1.replaceAll("-", "")]) assert.equal(isUniqueTurnId(id), false, id);
  assert.equal(isUniqueTurnId(U1.toUpperCase()), true);
});

test("userTasks reports turns without a unique id beside turns without a conversation", async () => {
  const turns = [turn(), turn({ turn_id: "auto-compact-1" }), turn({ turn_id: "auto-compact-2", conversation_id: "" })];
  const out = await userTasks(from, to, { userExact: "a", client: "codex" }, both,
    async (sql) => (sql.includes("otel_traces") ? turns : []));
  assert.deepEqual(out.tasks.map(t => t.id), [`codex:c1:${U1}`]);
  assert.equal(out.unattached_codex.turns_without_conversation, 1);
  assert.equal(out.unattached_codex.turns_without_unique_id, 1);
});

test("merged list mixes clients sorted by tokens", () => {
  const claude = foldClaudeTasks([task({ trace_id: "big", calls: [call("r1", "claude-opus-5", "500")] }),
    task({ trace_id: "small", calls: [call("r2", "claude-opus-5", "1")] })], []);
  const { tasks: codex } = attachCompletions([turn()], [completion("2026-11-05T01:00:01Z")], opts);
  assert.deepEqual(sortTasks([...claude, ...codex], "tokens").map(t => t.id),
    ["claude:big", `codex:c1:${U1}`, "claude:small"]);
  assert.deepEqual(sortTasks([...claude, ...codex], "duration").map(t => t.id)[0], `codex:c1:${U1}`);
});

test("merged list puts Codex after known Claude subagent counts and ranks cost across clients", () => {
  const claude = foldClaudeTasks([task({ trace_id: "few", subagents: "0", calls: [call("r1", "claude-opus-5", "500")] }),
    task({ trace_id: "many", subagents: "4", calls: [call("r2", "claude-opus-5", "1")] })],
  [{ request_id: "r1", cost_usd: 0.01 }, { request_id: "r2", cost_usd: 9 }]);
  const { tasks: codex } = attachCompletions([turn()], [completion("2026-11-05T01:00:01Z")], opts);
  assert.deepEqual(sortTasks([...codex, ...claude], "subagents").map(t => t.id),
    ["claude:many", "claude:few", `codex:c1:${U1}`]);
  const byCost = sortTasks([...codex, ...claude], "cost").map(t => t.id);
  assert.equal(byCost[0], "claude:many");
  assert.deepEqual([...byCost].sort(), ["claude:few", "claude:many", `codex:c1:${U1}`]);
  assert.equal(byCost.indexOf("claude:few") > byCost.indexOf(`codex:c1:${U1}`), unitCost > 0.01);
});

test("userTasks sort=cost folds a 100-row pool, orders by cost and reports the pool", async () => {
  // 100 candidate rows: the cheapest by tokens has the highest reported cost.
  const rows = Array.from({ length: COST_CANDIDATES }, (_, i) =>
    task({ trace_id: `t${i}`, calls: [call(`r${i}`, "claude-opus-5", String(1000 - i))] }));
  const costRows = rows.map((_, i) => ({ request_id: `r${i}`, cost_usd: i / 100 }));
  const sqls = [];
  const run = async (sql) => { sqls.push(sql); return sql.includes("otel_traces") ? rows : costRows; };
  const out = await userTasks(from, to, { userExact: "a", client: "claude", sort: "cost" }, both, run);
  assert.match(sqls[0], /LIMIT 100$/);
  assert.equal(out.tasks.length, 20);
  assert.deepEqual(out.tasks.slice(0, 3).map(t => t.id), ["claude:t99", "claude:t98", "claude:t97"]);
  assert.deepEqual(out.sort_candidates, { claude: 100, claude_limit: 100, limited: true });

  const small = await userTasks(from, to, { userExact: "a", client: "claude", sort: "cost" }, both,
    async (sql) => (sql.includes("otel_traces") ? rows.slice(0, 3) : costRows));
  assert.deepEqual(small.sort_candidates, { claude: 3, claude_limit: 100, limited: false });
  // Other sorts and Codex-only cost sorts carry no candidate report.
  const tokens = await userTasks(from, to, { userExact: "a", client: "claude" }, both, async () => []);
  assert.equal("sort_candidates" in tokens, false);
  const codexCost = await userTasks(from, to, { userExact: "a", client: "codex", sort: "cost" }, both, async () => []);
  assert.equal("sort_candidates" in codexCost, false);
});

test("userTasks merges Codex turns, counts skipped turns and keeps 20", async () => {
  const calls = [];
  const turns = [...Array.from({ length: 25 }, (_, i) => turn({ turn_id: uuid(i),
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
  assert.equal(out.tasks[1].id, `codex:c1:${uuid(0)}`);
  assert.deepEqual(out.coverage, { claude: "observed", codex: "observed" });
  assert.equal(out.unattached_codex.completions, 1);
  assert.equal(out.unattached_codex.turns_without_conversation, 1);
  assert.equal(out.unattached_codex.turns_without_unique_id, 0);
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
    turns_without_conversation: 0, turns_without_unique_id: 0 });

  // Group filters Claude tasks only; Codex rows are still returned.
  const grouped = [];
  await userTasks(from, to, { userExact: "a", group: "bedrock" }, both, async (sql, p) => { grouped.push({ sql, p }); return []; });
  assert.ok(grouped.filter(g => g.sql.includes("'codex'") || g.sql.includes("codex.sse_event"))
    .every(g => !g.sql.includes("{group:String}") && g.p.group === undefined));
});

test("userTasks marks Codex coverage limited when a row guard is hit", async () => {
  const many = Array.from({ length: CODEX_TURN_LIMIT + 1 }, (_, i) => turn({ turn_id: uuid(i) }));
  const out = await userTasks(from, to, { userExact: "a", client: "codex" }, both,
    async (sql) => (sql.includes("otel_traces") ? many : []));
  assert.equal(out.coverage.codex, "limited");
  assert.equal(out.unattached_codex.cost_partial, true);
  assert.equal(out.tasks.length, TASK_LIMIT);
});

test("codexTurnSql reads spans from a 24h lookback and orders bucket turns first", () => {
  const { sql, params } = codexTurnSql(from, to, validateTaskQuery({ userExact: "a" }, both));
  assert.equal(params.spanFrom, "2026-11-04 00:00:00");
  assert.ok(params.spanFrom < params.from);
  assert.ok(sql.includes("Timestamp >= {spanFrom:DateTime} AND Timestamp < {spanTo:DateTime}"));
  assert.ok(sql.includes("toUInt8(min(Timestamp) >= {from:DateTime} AND min(Timestamp) < {to:DateTime}) AS in_bucket"));
  assert.ok(!/HAVING/.test(sql), "context turns are returned, flagged rather than dropped");
  assert.ok(/ORDER BY in_bucket DESC, start_ms ASC, turn_id ASC\s+LIMIT/.test(sql));
});

test("a turn spanning the bucket start is listed once, by its starting bucket", () => {
  // Turn started 23:59:50 the day before and ran to 00:00:30.
  const boundary = (inBucket) => turn({ turn_id: uuid(900), in_bucket: inBucket,
    started_at: "2026-11-04T23:59:50Z", start_ms: String(ms("2026-11-04T23:59:50Z")),
    end_ms: String(ms("2026-11-05T00:00:30Z")) });
  const inside = completion("2026-11-05T00:00:20Z");
  const prevFrom = new Date("2026-11-04T00:00:00Z");
  const prev = attachCompletions([boundary("1")], [inside], { ...opts, from: prevFrom, to: from });
  assert.equal(prev.tasks.length, 1);
  assert.equal(prev.tasks[0].tokens.observed_tokens, 120);
  // This bucket sees the same turn as context: not listed, and its completion is not unattached.
  const cur = attachCompletions([boundary("0")], [inside], opts);
  assert.deepEqual(cur.tasks, []);
  assert.equal(cur.unattached.completions, 0);
  // A context turn without a conversation id is not counted as skipped here either.
  assert.equal(attachCompletions([turn({ conversation_id: "", in_bucket: "0" })], [], opts).skipped_turns, 0);
  // A later context turn (next bucket) still wins its completion over an earlier bucket turn.
  const next = turn({ turn_id: uuid(901), in_bucket: "0", start_ms: String(ms("2026-11-05T01:00:04Z")) });
  const won = attachCompletions([turn(), next], [completion("2026-11-05T01:00:06Z")], opts);
  assert.equal(won.tasks.length, 1);
  assert.equal(won.tasks[0].tokens.observed_tokens, null);
  assert.equal(won.unattached.completions, 0);
});

// ── Task detail (taskTraceDetail.js) ─────────────────────────────────────
const detail = await import("./taskTraceDetail.js");
const { parseTaskId, claudeDetailSql, codexDetailSql, foldTaskDetail, userTaskDetail, taskDetailCacheKey,
  validateTaskDetailQuery, SPAN_ATTRIBUTE_ALLOWLIST, SPAN_BOUND, claudeCompactionSql, codexLimitsSql,
  foldCompactions, foldLimits, COMPACTION_LIMIT, claudeEnvironmentSql, foldEnvironment, ENVIRONMENT_LOOKBACK_DAYS } = detail;
const { NotFoundError } = await import("./http.js");

const TRACE = "0123456789abcdef0123456789abcdef";
const t0 = ms("2026-11-05T01:00:00Z");
const header = (overrides = {}) => ({ trace_id: TRACE, started_at: "2026-11-05T01:00:00Z",
  start_ms: String(t0), duration_ms: "60000", session_grp: "enterprise", ...overrides });
const span = (id, type, at, overrides = {}) => ({ span_id: id, parent_id: "", span_type: type,
  span_name: `claude_code.${type}`, start_ms: String(t0 + at), duration_ms: "1000", agent_id: "",
  request_id: "", total_spans: "0", ...overrides });
const llm = (id, at, overrides = {}) => span(id, "llm_request", at, { request_id: `r-${id}`, a_model: "claude-opus-5",
  a_input_tokens: "10", a_cache_read_tokens: "100", a_cache_creation_tokens: "0", a_output_tokens: "5", ...overrides });

test("SPAN_BOUND and allowlist are pinned", () => {
  assert.equal(SPAN_BOUND, 5000);
  assert.deepEqual(SPAN_ATTRIBUTE_ALLOWLIST.wait, ["decision", "source"]);
  assert.deepEqual(SPAN_ATTRIBUTE_ALLOWLIST.codex, ["model", "tool_name", "aborted"]);
  assert.equal(SPAN_ATTRIBUTE_ALLOWLIST.llm.length, 13);
  assert.equal(SPAN_ATTRIBUTE_ALLOWLIST.tool.length, 7);
});

test("parseTaskId rejects injection-shaped ids", () => {
  assert.deepEqual(parseTaskId(`claude:${TRACE}`), { client: "claude", traceId: TRACE });
  const turnId = "019a5f3e-7c2b-7d41-9a3e-0f1e2d3c4b5a";
  assert.deepEqual(parseTaskId(`codex:019a-conv_1:${turnId}`),
    { client: "codex", conversationId: "019a-conv_1", turnId });
  assert.equal(parseTaskId(`codex:c1:${turnId.toUpperCase()}`).turnId, turnId.toUpperCase());
  for (const bad of [undefined, "", ["claude:" + TRACE], `claude:${TRACE}' OR 1=1 --`, `claude:${TRACE.slice(1)}`,
    `claude:${TRACE.toUpperCase()}`, "claude:", "codex:c1", "codex::t1", "codex:c1:", "codex:c 1:t1",
    "codex:c1:t1;DROP", "codex:c1:t1'", "codex:c1:t1\n", "gemini:abc", `codex:${"a".repeat(200)}:t1`,
    // Synthetic turn ids are not listed, so they are not task ids either.
    "codex:c1:auto-compact-1", "codex:c1:turn-2", `codex:c1:${turnId}x`, `codex:c1:${turnId};DROP`])
    assert.throws(() => parseTaskId(bad), { name: "ValidationError" }, String(bad));
});

test("validateTaskDetailQuery rejects a disabled client; userExact is optional but validated", () => {
  assert.throws(() => validateTaskDetailQuery({ id: `codex:c1:${U1}`, userExact: "a" }, ["claude"]), { name: "ValidationError" });
  assert.equal(validateTaskDetailQuery({ id: `claude:${TRACE}` }, both).userExact, null);
  for (const bad of ["", ["a"], "x".repeat(257)])
    assert.throws(() => validateTaskDetailQuery({ id: `claude:${TRACE}`, userExact: bad }, both), { name: "ValidationError" });
  assert.equal(validateTaskDetailQuery({ id: `claude:${TRACE}`, userExact: "a" }, both).task.traceId, TRACE);
});

test("detail SQL never selects whole SpanAttributes or forbidden keys", () => {
  const q = { userExact: "kim@x.com" };
  const claude = claudeDetailSql(from, to, TRACE, q);
  const codex = codexDetailSql(from, to, q, "c1", U1);
  for (const { sql, params } of [claude.header, claude.spans, codex.turns, codex.completions, codex.spans]) {
    assert.ok(!/user_prompt|full_command|file_path|bash_argv0/.test(sql));
    // Every SpanAttributes/LogAttributes use is a single-key lookup (or the logSelection map sort).
    assert.ok(!/SpanAttributes(?!\[')/.test(sql), sql);
    assert.ok(!sql.includes("kim@x.com") && !sql.includes(TRACE));
    assert.ok(!/\bSELECT \*/.test(sql));
    for (const v of Object.values(params)) assert.notEqual(typeof v, "object");
  }
  assert.ok(claude.spans.sql.includes(`LIMIT ${SPAN_BOUND}`) && claude.spans.sql.includes("count() OVER ()"));
  assert.ok(codex.spans.sql.includes(`LIMIT ${SPAN_BOUND}`) && codex.spans.sql.includes("count() OVER ()"));
  assert.equal(claude.spans.params.traceId, TRACE);
  assert.equal(claude.header.params.userExact, "kim@x.com");
  assert.equal(codex.spans.params.turnId, U1);
  assert.match(codex.spans.sql, /PREWHERE Timestamp >= \{spanFrom:DateTime\} AND Timestamp < \{spanTo:DateTime\}\s+AND coalesce\(nullIf\(UserEmail, ''\), nullIf\(EndUserId, ''\), ''\) = \{userExact:String\}\s+WHERE ResourceAttributes\['client'\] = 'codex'/);
  assert.match(codex.turns.sql, /HAVING conversation_id = \{conversationId:String\}/);
  // Spans naming another conversation are not this turn's spans.
  assert.ok(codex.spans.sql.includes("AND SpanAttributes['conversation.id'] IN ('', {conversationId:String})"));
  assert.equal(codex.spans.params.conversationId, "c1");
  assert.ok(!codex.turns.sql.includes("SpanAttributes['conversation.id'] = "), "conversation stays a turn-level HAVING");
  assert.equal(codex.turns.params.conversationId, "c1");
  assert.equal(codex.completions.params.conversationId, "c1");
  assert.ok(codex.spans.sql.includes("{userExact:String}") && codex.spans.sql.includes("ResourceAttributes['client'] = 'codex'"));
});

test("detail reports the list's workflow pairs from every span of the trace", () => {
  const { header: sql } = claudeDetailSql(from, to, TRACE, { userExact: "a" });
  assert.equal(sql.params.spanTo, "2026-11-07 00:00:00");
  assert.ok(sql.sql.includes("groupUniqArrayIf([SpanAttributes['workflow.run_id'], SpanAttributes['workflow.name']]"));
  const out = foldTaskDetail({ client: "claude", ...header({ workflows: [["wf_run1", "review-changes"]] }) },
    [llm("a", 0)], []);
  assert.deepEqual(out.task.workflows, [{ run_id: "wf_run1", name: "review-changes" }]);
});

test("subagent spans after the bucket end are included", () => {
  const { spans } = claudeDetailSql(from, to, TRACE, { userExact: "a" });
  assert.equal(spans.params.from, "2026-11-05 00:00:00");
  assert.equal(spans.params.spanTo, "2026-11-07 00:00:00");
  // A subagent call at to + 2h is inside the window and folds into its lane.
  const late = Date.parse("2026-11-06T02:00:00Z") - t0;
  const out = foldTaskDetail({ client: "claude", ...header() },
    [llm("a", 0), llm("b", late, { agent_id: "ag1", parent_id: "x" }),
      span("x", "tool.execution", late - 10, { a_subagent_type: "Explore" })], []);
  assert.equal(out.spans.find(s => s.id === "b").start_ms, late);
  assert.equal(out.lanes.find(l => l.id === "ag1").llm_calls, 1);
  const codex = codexDetailSql(from, to, { userExact: "a" }, "c1", U1);
  assert.equal(codex.spans.params.spanFrom, "2026-11-04 00:00:00");
  assert.equal(codex.spans.params.spanTo, "2026-11-07 00:00:00");
});

test("subagent lanes without subagent_type fall back to the log agent.name, then the query source", () => {
  const rows = [
    llm("m1", 0),
    span("tool1", "tool", 100, { a_tool_name: "Agent" }),
    span("exec1", "tool.execution", 110, { parent_id: "tool1" }),
    llm("s1", 200, { agent_id: "agA", parent_id: "exec1" }),
    llm("c1", 300, { agent_id: "agB", parent_id: "missing", a_query_source_safe: "agent.builtin.Explore" }),
    llm("x1", 400, { agent_id: "agC", parent_id: "missing", a_query_source_safe: "agent.custom" }),
  ];
  const costs = [{ request_id: "r-s1", cost_usd: 0.1, agent_name: "co-agent:pr-autofix-implementer" },
    { request_id: "r-x1", cost_usd: 0.1, agent_name: "has space" }];
  const lanes = Object.fromEntries(foldTaskDetail({ client: "claude", ...header() }, rows, costs).lanes.map(l => [l.id, l]));
  assert.deepEqual([lanes.agA.kind, lanes.agA.label, lanes.agA.spawned_by], ["custom", "co-agent:pr-autofix-implementer", "tool1"]);
  assert.deepEqual([lanes.agB.kind, lanes.agB.label], ["Explore", "Explore"]);
  // Free text never becomes a label; agent.custom has no type of its own.
  assert.deepEqual([lanes.agC.kind, lanes.agC.label], ["custom", null]);
});

test("claudeCostSql also returns the request's agent name", () => {
  assert.match(claudeCostSql(from, to, ["r1"]).sql, /LogAttributes\['agent\.name'\]/);
});

test("foldTaskDetail builds lanes from AgentId with subagent_type labels", () => {
  const rows = [
    llm("m1", 0),
    span("tool1", "tool", 100, { a_tool_name: "Agent", a_subagent_type: "general-purpose" }),
    span("exec1", "tool.execution", 110, { parent_id: "tool1" }),
    llm("s1", 200, { agent_id: "agA", parent_id: "exec1" }),
    llm("s2", 300, { agent_id: "agA", parent_id: "exec1" }),
    span("tool2", "tool", 400, { a_tool_name: "Agent", a_subagent_type: "co-agent:pr-autofix-implementer" }),
    span("exec2", "tool.execution", 410, { parent_id: "tool2" }),
    llm("c1", 500, { agent_id: "agB", parent_id: "exec2" }),
    span("w1", "tool.blocked_on_user", 600, { a_decision: "accept", a_source: "config", duration_ms: "250" }),
    llm("o1", 700, { agent_id: "agC", parent_id: "missing" }),
  ];
  const out = foldTaskDetail({ client: "claude", ...header() }, rows, [{ request_id: "r-m1", cost_usd: 0.5 }]);
  const lanes = Object.fromEntries(out.lanes.map(l => [l.id, l]));
  assert.deepEqual(out.lanes.map(l => l.id), ["main", "agA", "agB", "agC"]);
  assert.equal(lanes.main.kind, "main");
  assert.equal(lanes.main.spawned_by, null);
  assert.deepEqual([lanes.agA.kind, lanes.agA.label, lanes.agA.spawned_by], ["general-purpose", "general-purpose", "tool1"]);
  assert.equal(lanes.agB.spawned_by, "tool2");
  assert.deepEqual([lanes.agB.kind, lanes.agB.label], ["custom", "co-agent:pr-autofix-implementer"]);
  assert.deepEqual([lanes.agC.kind, lanes.agC.label, lanes.agC.spawned_by], ["custom", null, null]);
  assert.equal(lanes.agA.llm_calls, 2);
  assert.equal(lanes.main.cost_usd, 0.5);
  const s1 = out.spans.find(s => s.id === "s1");
  assert.deepEqual([s1.kind, s1.lane, s1.parent, s1.start_ms], ["llm", "agA", "tool1", 200]);
  // One bar per tool call: each tool.execution folds into its tool span.
  assert.ok(!out.spans.some(s => s.id === "exec1" || s.id === "exec2"));
  assert.equal(out.spans.filter(s => s.kind === "tool").length, 2);
  assert.equal(out.spans.find(s => s.id === "tool1").execution_ms, 1000);
  assert.deepEqual(s1.tokens, { input: 10, cache_read: 100, cache_write: 0, output: 5 });
  assert.equal(out.spans.find(s => s.id === "o1").parent, null);
  assert.deepEqual(out.spans.find(s => s.id === "w1").attrs, { decision: "accept", source: "config" });
  assert.equal(out.spans.find(s => s.id === "w1").kind, "wait");
  assert.equal(out.spans.find(s => s.id === "tool1").attrs.tool_name, "Agent");
  assert.equal(out.spans.find(s => s.id === "m1").cost_basis, "client_reported");
  assert.equal(out.truncated, false);
  assert.equal(out.task.llm_calls, 5);
  assert.equal(out.task.subagents, 3);
  assert.equal(out.task.id, `claude:${TRACE}`);
});

test("a tool.execution span folds into its tool bar, or is drawn when the tool span is absent", () => {
  const out = foldTaskDetail({ client: "claude", ...header() }, [
    span("t", "tool", 0, { a_tool_name: "Bash", a_bash_command_class: "read_only", duration_ms: "3000" }),
    span("w", "tool.blocked_on_user", 10, { parent_id: "t", a_decision: "accept", duration_ms: "500" }),
    span("x", "tool.execution", 600, { parent_id: "t", a_success: "false", a_error_class: "timeout",
      a_tool_name: "Other", duration_ms: "2000" }),
    span("lone", "tool.execution", 5000, { parent_id: "gone", a_tool_name: "Read", a_success: "true" }),
  ], []);
  const tools = out.spans.filter(s => s.kind === "tool");
  assert.deepEqual(tools.map(s => s.id), ["t", "lone"]);
  const bar = tools[0];
  // The tool span's own attrs win; execution attrs fill the rest.
  assert.deepEqual(bar.attrs, { tool_name: "Bash", bash_command_class: "read_only", success: false, error_class: "timeout" });
  assert.equal(bar.duration_ms, 3000);
  assert.equal(bar.execution_ms, 2000);
  assert.equal(out.spans.find(s => s.id === "w").parent, "t");
  assert.equal(tools[1].execution_ms, undefined);
  assert.equal(tools[1].parent, null);
});

test("detail totals equal the list fold for the same task", () => {
  const rows = [llm("a", 0), llm("b", 10, { agent_id: "x", a_model: "openai.gpt-6-astra" }), span("t", "tool", 20)];
  const costRows = [{ request_id: "r-a", cost_usd: 0.25 }];
  const out = foldTaskDetail({ client: "claude", ...header() }, rows, costRows);
  const [listed] = foldClaudeTasks([task({ trace_id: TRACE, duration_ms: "60000", llm_calls: "2", subagents: "1",
    calls: [call("r-a", "claude-opus-5", "10", "100", "0", "5"), call("r-b", "openai.gpt-6-astra", "10", "100", "0", "5")] })],
  costRows);
  for (const k of ["id", "llm_calls", "subagents", "tokens", "cost_partial", "cost_basis", "models", "duration_ms"])
    assert.deepEqual(out.task[k], listed[k], k);
  assert.ok(Math.abs(out.task.cost_usd - listed.cost_usd) < 1e-12);
});

test("span attributes outside the allowlist never reach the payload", () => {
  const out = foldTaskDetail({ client: "claude", ...header() }, [
    span("t", "tool", 0, { a_tool_name: "Bash", a_bash_command_class: "read_only", a_success: "true",
      user_prompt: "secret", full_command: "rm -rf /", file_path: "/etc/x", a_decision: "accept",
      a_skill_name: "has space", request_id: "r-x" }),
    llm("l", 1, { a_stop_reason: "end_turn", a_attempt: "2", a_tool_name: "Bash" }),
  ], []);
  const text = JSON.stringify(out);
  assert.ok(!/secret|rm -rf|\/etc\/x|has space|r-x|r-l/.test(text), text);
  assert.deepEqual(out.spans.find(s => s.id === "t").attrs, { tool_name: "Bash", bash_command_class: "read_only", success: true });
  assert.deepEqual(out.spans.find(s => s.id === "l").attrs,
    { model: "claude-opus-5", input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_creation_tokens: 0,
      attempt: 2, stop_reason: "end_turn" });
});

test("truncated detail withholds totals", () => {
  const rows = [llm("a", 0, { total_spans: String(SPAN_BOUND + 7) }), llm("b", 5, { agent_id: "x", total_spans: String(SPAN_BOUND + 7) })];
  const out = foldTaskDetail({ client: "claude", ...header() }, rows, []);
  assert.equal(out.truncated, true);
  for (const k of ["llm_calls", "cost_usd", "tokens", "subagents"]) assert.equal(out.task[k], null, k);
  assert.equal(out.task.cost_partial, true);
  for (const lane of out.lanes) { assert.equal(lane.llm_calls, null); assert.equal(lane.cost_usd, null); }
  assert.deepEqual(out.why, []);
  assert.equal(out.spans.length, 2);
  assert.equal(out.task.duration_ms, 60000);
  // Models of the newest spans are not the task's models.
  assert.equal(out.task.models, null);
});

const ruleMap = (out) => Object.fromEntries(out.why.map(r => [r.rule, r.value]));

test("why omits rules with missing inputs", () => {
  // One unknown-token call, no attempt attribute, a single lane, an unmatched non-Anthropic
  // unpriced model: no cache share, context growth, lane share, top call or retries.
  const out = foldTaskDetail({ client: "claude", ...header() },
    [llm("a", 0, { a_cache_read_tokens: null, a_model: "openai.unknown-x", request_id: "" })], []);
  const rules = ruleMap(out);
  for (const r of ["cache_read_share", "context_growth", "top_lane_share", "most_expensive_call", "retries"])
    assert.ok(!(r in rules), r);
  // A Claude trace without wait spans has a known zero permission wait.
  assert.equal(rules.permission_wait, 0);
  const codex = foldTaskDetail({ client: "codex", turn: turn({ llm_calls: "0", models: [] }), linked: [] }, [], []);
  assert.deepEqual(codex.why, []);
});

test("retries are unavailable when any call lacks attempt", () => {
  const rows = [llm("a", 0, { a_attempt: "2" }), llm("b", 10)];
  assert.ok(!("retries" in ruleMap(foldTaskDetail({ client: "claude", ...header() }, rows, []))));
  // Order does not matter: a missing attempt before a known one is still partial evidence.
  const reversed = [llm("a", 0), llm("b", 10, { a_attempt: "3" })];
  assert.ok(!("retries" in ruleMap(foldTaskDetail({ client: "claude", ...header() }, reversed, []))));
  const complete = [llm("a", 0, { a_attempt: "1" }), llm("b", 10, { a_attempt: "1" })];
  assert.equal(ruleMap(foldTaskDetail({ client: "claude", ...header() }, complete, [])).retries, 0);
});

test("why context_growth reports first and last call context", () => {
  const out = foldTaskDetail({ client: "claude", ...header() }, [
    llm("a", 0, { a_input_tokens: "5", a_cache_read_tokens: "1000", a_cache_creation_tokens: "200", a_attempt: "1" }),
    llm("sub", 50, { agent_id: "x", a_input_tokens: "1", a_cache_read_tokens: "1", a_attempt: "3" }),
    llm("b", 100, { a_input_tokens: "7", a_cache_read_tokens: "9000", a_cache_creation_tokens: "300", a_attempt: "2" }),
    span("w", "tool.blocked_on_user", 20, { duration_ms: "1500" }),
  ], [{ request_id: "r-a", cost_usd: 0.1 }, { request_id: "r-sub", cost_usd: 0.05 }, { request_id: "r-b", cost_usd: 0.6 }]);
  const rules = ruleMap(out);
  assert.deepEqual(rules.context_growth, { first: 1205, last: 9307, calls: 2 });
  assert.equal(rules.retries, 2);
  assert.equal(rules.permission_wait, 1500);
  assert.deepEqual(rules.most_expensive_call, { span: "b", cost_usd: 0.6 });
  assert.equal(rules.top_lane_share.lane, "main");
  assert.ok(Math.abs(rules.top_lane_share.share - 0.7 / 0.75) < 1e-12);
  const tokens = out.task.tokens;
  const total = tokens.input + tokens.cache_read + tokens.cache_write + tokens.output;
  assert.ok(Math.abs(rules.cache_read_share - tokens.cache_read / total) < 1e-12);
});

test("codex detail links completions to sampling spans and keeps the list totals", () => {
  const turnRow = turn({ in_bucket: 1 });
  const c1 = completion("2026-11-05T01:00:02Z", { ttft_ms: "120", duration_ms: "900" });
  const c2 = completion("2026-11-05T01:00:08Z");
  const c3 = completion("2026-11-05T01:00:00.500Z");
  const cspan = (id, name, at, dur, overrides = {}) => ({ span_id: id, parent_id: "", span_name: name,
    start_ms: String(ms(at)), duration_ms: String(dur), a_model: "", a_tool_name: "", a_aborted: "", total_spans: "3", ...overrides });
  const rows = [cspan("s1", "codex.sampling", "2026-11-05T01:00:01Z", 1500, { a_model: "openai.gpt-6-astra" }),
    cspan("s2", "codex.sampling", "2026-11-05T01:00:07Z", 1500),
    cspan("e1", "exec_command", "2026-11-05T01:00:04Z", 200, { a_tool_name: "shell", a_aborted: "false" })];
  const { entries } = linkCompletions([turnRow], [c1, c2, c3], { prices: DEFAULT_CODEX_PRICING });
  const out = foldTaskDetail({ client: "codex", turn: entries[0].turn, linked: entries[0].linked }, rows, []);
  const { tasks } = attachCompletions([turnRow], [c1, c2, c3], opts);
  for (const k of ["id", "llm_calls", "tokens", "cost_usd", "cost_partial", "cost_basis", "duration_ms"])
    assert.deepEqual(out.task[k], tasks[0][k], k);
  assert.deepEqual(out.lanes.map(l => [l.id, l.kind]), [["main", "main"]]);
  const s1 = out.spans.find(s => s.id === "s1"), s2 = out.spans.find(s => s.id === "s2");
  assert.equal(s1.kind, "llm");
  assert.equal(s1.cost_basis, "linked_estimate");
  assert.deepEqual(s1.tokens, { input: 50, cache_read: 40, cache_write: 10, output: 20 });
  assert.deepEqual(s1.completion, { model: "openai.gpt-6-astra", effort: "high", ttft_ms: 120, duration_ms: 900, count: 1 });
  assert.equal(s2.completion.count, 1);
  assert.equal(out.task.completions_without_span, 1);
  assert.deepEqual(out.spans.find(s => s.id === "e1").attrs, { tool_name: "shell", aborted: false });
  assert.equal(out.spans.find(s => s.id === "e1").kind, "tool");
  assert.equal(s1.start_ms, 1000);
  assert.deepEqual(ruleMap(out).context_growth, { first: 100, last: 100, calls: 3 });
});

// Older Codex (observed: 0.159.3) emits no codex.sampling span; its model calls are run_sampling_request
// spans (one per call, as codex.sampling in later versions). The turn row names the span kind.
test("codex detail treats run_sampling_request as the model call of a legacy turn", () => {
  const turnRow = turn({ in_bucket: 1, sampling_span: "run_sampling_request" });
  const c1 = completion("2026-11-05T01:00:02Z");
  const cspan = (id, name, at, dur) => ({ span_id: id, parent_id: "", span_name: name,
    start_ms: String(ms(at)), duration_ms: String(dur), a_model: "", a_tool_name: "", a_aborted: "", total_spans: "2" });
  const rows = [cspan("r1", "run_sampling_request", "2026-11-05T01:00:01Z", 1500),
    cspan("t1", "try_run_sampling_request", "2026-11-05T01:00:01Z", 1500)];
  const { entries } = linkCompletions([turnRow], [c1], { prices: DEFAULT_CODEX_PRICING });
  const out = foldTaskDetail({ client: "codex", turn: entries[0].turn, linked: entries[0].linked }, rows, []);
  assert.equal(out.spans.find(s => s.id === "r1").kind, "llm");
  assert.equal(out.spans.find(s => s.id === "r1").completion.count, 1);
  assert.equal(out.spans.find(s => s.id === "t1").kind, "tool", "the retry wrapper is not another call");
  assert.equal(out.task.completions_without_span, 0);
  // A turn without the field keeps the codex.sampling rule.
  const modern = foldTaskDetail({ client: "codex", turn: turn({ in_bucket: 1 }), linked: [] }, rows, []);
  assert.ok(modern.spans.every(s => s.kind === "tool"));
});

const fakeRun = (tables) => async (sql, params) => {
  if (sql.includes("SpanType = 'interaction'"))
    return (params.userExact === undefined || tables.owner === params.userExact) && params.traceId === TRACE
      ? [header({ owner: tables.owner })] : [];
  if (sql.includes("GROUP BY owner"))
    return params.turnId === U1 && params.conversationId === "c1" ? [{ owner: tables.owner }] : [];
  // Subagent lineage (codexAgents.js): no linked turns unless a table supplies them.
  if (sql.includes("op.dispatch.inter_agent_communication")) return tables.agents?.(params) ?? [];
  // Claude spans are gated by the header; Codex spans carry the exact user.
  if (sql.includes("count() OVER ()"))
    return params.userExact === undefined || tables.owner === params.userExact ? [llm("a", 0, { total_spans: "1" })] : [];
  if (sql.includes("otel_logs") && sql.includes("request_id")) return [{ request_id: "r-a", cost_usd: 0.3 }];
  if (sql.includes("GROUP BY turn_id")) return tables.owner === params.userExact ? [turn({ in_bucket: 1 })] : [];
  if (sql.includes("otel_logs")) return [];
  throw new Error(`unexpected SQL ${sql.slice(0, 40)}`);
};

test("detail for another user's task returns 404", async () => {
  const run = fakeRun({ owner: "kim@x.com" });
  const ok = await userTaskDetail(from, to, { id: `claude:${TRACE}`, userExact: "kim@x.com" }, both, run);
  assert.equal(ok.task.cost_usd, 0.3);
  const errors = [];
  for (const raw of [{ id: `claude:${TRACE}`, userExact: "lee@x.com" },
    { id: `claude:${"f".repeat(32)}`, userExact: "kim@x.com" },
    { id: `codex:c1:${U1}`, userExact: "lee@x.com" }, { id: `codex:c1:${uuid(99)}`, userExact: "kim@x.com" },
    { id: `codex:c2:${U1}`, userExact: "kim@x.com" }]) {
    const err = await userTaskDetail(from, to, raw, both, run, DEFAULT_CODEX_PRICING).then(() => null, e => e);
    assert.ok(err instanceof NotFoundError, JSON.stringify(raw));
    errors.push(err.message);
  }
  // Same message whether the id exists for another user or not at all.
  assert.equal(new Set(errors).size, 1);
  // Ownership is checked before any span query runs.
  const seen = [];
  const spy = async (sql, params) => { seen.push(sql); return run(sql, params); };
  await userTaskDetail(from, to, { id: `claude:${TRACE}`, userExact: "lee@x.com" }, both, spy).catch(() => {});
  assert.equal(seen.length, 1);
  const codex = await userTaskDetail(from, to, { id: `codex:c1:${U1}`, userExact: "kim@x.com" }, both, run, DEFAULT_CODEX_PRICING);
  assert.equal(codex.task.id, `codex:c1:${U1}`);
});

test("the Codex detail links subagent turns through the trace and never returns trace ids", async () => {
  const child = uuid(7);
  const lineage = [
    { trace_id: "tr1", span_id: "g", parent_id: "x", name: "collaborationspawn_agent", conversation: "c1", turn: U1, start_ms: "0" },
    { trace_id: "tr1", span_id: "d", parent_id: "g", name: "dispatch_tool_call_with_state", conversation: "", turn: "", start_ms: "0" },
    { trace_id: "tr1", span_id: "i", parent_id: "d", name: "op.dispatch.inter_agent_communication", conversation: "", turn: "", start_ms: "0" },
    { trace_id: "tr1", span_id: "c", parent_id: "i", name: "session_task.turn", conversation: "", turn: child, start_ms: "0" },
    { trace_id: "tr1", span_id: "r", parent_id: "c", name: "run_turn", conversation: "sub", turn: child, start_ms: "0" },
  ];
  const seen = [];
  const run = async (sql, params) => {
    seen.push(params);
    if (sql.includes("op.dispatch")) return lineage;
    if (sql.includes("count() OVER ()"))
      return [{ span_id: "g", parent_id: "", span_name: "collaborationspawn_agent", start_ms: String(ms("2026-11-05T01:00:01Z")),
        duration_ms: "5", trace_id: "tr1", a_tool_name: "collaborationspawn_agent", total_spans: "1" }];
    if (sql.includes("GROUP BY turn_id"))
      return params.conversationIds ? [turn({ conversation_id: "sub", turn_id: child })] : [turn({ in_bucket: 1 })];
    if (sql.includes("otel_logs") && params.conversationIds) return [completion("2026-11-05T01:00:05Z", { conversation_id: "sub" })];
    return [];
  };
  const detail = await userTaskDetail(from, to, { id: `codex:c1:${U1}`, userExact: "kim@x.com" }, both, run, DEFAULT_CODEX_PRICING);
  assert.equal(detail.task.subagents, 1);
  assert.deepEqual(detail.agents.children.map(c => [c.id, c.tool, c.llm_calls]), [[`codex:sub:${child}`, "spawn_agent", 2]]);
  assert.ok(Math.abs(detail.agents.children[0].cost_usd - unitCost) < 1e-12);
  assert.deepEqual([detail.agents.spawn_calls, detail.agents.unlinked_calls], [1, 0]);
  assert.ok(!JSON.stringify(detail).includes("tr1"));
  // Native collaboration spans carry tool_name: the spawn is a tool call, not an internal span.
  assert.deepEqual(detail.activity.tools.map(t => [t.name, t.calls]), [["collaborationspawn_agent", 1]]);
  assert.equal(detail.spans[0].internal, undefined);
  assert.ok(seen.filter(p => p.traceIds).every(p => p.traceIds.join() === "tr1" && p.userExact === "kim@x.com"));
});

test("the Codex detail lists the turn's skills and tool calls and flags its internal spans", async () => {
  const seen = [];
  const run = async (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes("count() OVER ()")) return [
      { span_id: "a", parent_id: "", span_name: "exec_command", start_ms: String(ms("2026-11-05T01:00:01Z")), duration_ms: "20",
        a_tool_name: "exec_command", total_spans: "3" },
      { span_id: "b", parent_id: "", span_name: "mcp__awsdocsread_documentation", start_ms: String(ms("2026-11-05T01:00:02Z")),
        duration_ms: "900", a_tool_name: "mcp__awsdocsread_documentation", total_spans: "3" },
      { span_id: "c", parent_id: "", span_name: "mcp.runtime.resolve_for_step", start_ms: String(ms("2026-11-05T01:00:03Z")),
        duration_ms: "0", total_spans: "3" }];
    if (sql.includes("GROUP BY turn_id")) return [turn({ in_bucket: 1 })];
    if (sql.includes("codex.skill_invocation"))
      return [{ name: "superpowers:systematic-debugging", invocation: "implicit", scope: "user", calls: "2" }];
    return [];
  };
  const detail = await userTaskDetail(from, to, { id: `codex:c1:${U1}`, userExact: "kim@x.com" }, both, run, DEFAULT_CODEX_PRICING);
  assert.deepEqual(detail.activity.skills, [{ name: "superpowers:systematic-debugging", invocation: "implicit", scope: "user", calls: 2 }]);
  assert.deepEqual(detail.activity.tools.map(t => [t.name, t.mcp, t.calls]),
    [["exec_command", false, 1], ["mcp__awsdocsread_documentation", true, 1]]);
  assert.deepEqual(detail.spans.filter(s => s.internal).map(s => s.name), ["mcp.runtime.resolve_for_step"]);
  const skillRead = seen.find(s => s.sql.includes("codex.skill_invocation"));
  assert.deepEqual([skillRead.params.conversationId, skillRead.params.turnId, skillRead.params.userExact], ["c1", U1, "kim@x.com"]);
});

test("a context turn starting before the bucket is not a detail of this bucket", async () => {
  const run = async (sql) => sql.includes("GROUP BY turn_id") ? [turn({ in_bucket: 0 })] : [];
  const err = await userTaskDetail(from, to, { id: `codex:c1:${U1}`, userExact: "a" }, both, run, DEFAULT_CODEX_PRICING)
    .then(() => null, e => e);
  assert.ok(err instanceof NotFoundError);
});

test("taskDetailCacheKey isolates ids, users and ranges", () => {
  const base = { from: "2026-11-05T00:00:00Z", to: "2026-11-06T00:00:00Z" };
  const a = taskDetailCacheKey({ ...base, id: `claude:${TRACE}`, userExact: "kim@x.com" }, both);
  const b = taskDetailCacheKey({ ...base, id: `claude:${TRACE}`, userExact: "joakim@x.com" }, both);
  const c = taskDetailCacheKey({ ...base, id: `claude:${"f".repeat(32)}`, userExact: "kim@x.com" }, both);
  const d = taskDetailCacheKey({ ...base, to: "2026-11-07T00:00:00Z", id: `claude:${TRACE}`, userExact: "kim@x.com" }, both);
  assert.equal(new Set([a, b, c, d]).size, 4);
  assert.equal(taskDetailCacheKey({ x: "1", userExact: "kim@x.com", ...base, id: `claude:${TRACE}` }, both), a);
  assert.throws(() => taskDetailCacheKey({ ...base, id: "claude:x", userExact: "kim@x.com" }, both), { name: "ValidationError" });
});

test("index.js keys and routes the detail endpoint", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.match(src, /path === "\/api\/users\/tasks\/detail"\) return `\$\{path\}\?\$\{taskDetailCacheKey\(query, clientConfig\.enabledClients\)\}`/);
  assert.match(src, /err instanceof NotFoundError\) return res\.status\(404\)\.json\(\{ error: "not found" \}\)/);
  assert.match(src, /route\("\/api\/users\/tasks\/detail"/);
});

test("a shared link (no userExact) resolves the task owner and returns it", async () => {
  const run = fakeRun({ owner: "kim@x.com" });
  const claude = await userTaskDetail(from, to, { id: `claude:${TRACE}` }, both, run);
  assert.equal(claude.owner, "kim@x.com");
  assert.equal(claude.task.cost_usd, 0.3);
  const withUser = await userTaskDetail(from, to, { id: `claude:${TRACE}`, userExact: "kim@x.com" }, both, run);
  assert.equal(withUser.owner, "kim@x.com");
  const codex = await userTaskDetail(from, to, { id: `codex:c1:${U1}` }, both, run, DEFAULT_CODEX_PRICING);
  assert.equal(codex.owner, "kim@x.com");
  assert.equal(codex.task.id, `codex:c1:${U1}`);
  // Unknown task, an identity-less owner or two owners of one turn: the same 404.
  for (const [raw, tables] of [[{ id: `claude:${"f".repeat(32)}` }, { owner: "kim@x.com" }],
    [{ id: `claude:${TRACE}` }, { owner: "" }], [{ id: `codex:c9:${U1}` }, { owner: "kim@x.com" }],
    [{ id: `codex:c1:${U1}` }, { owner: "" }]]) {
    const err = await userTaskDetail(from, to, raw, both, fakeRun(tables), DEFAULT_CODEX_PRICING).then(() => null, e => e);
    assert.ok(err instanceof NotFoundError, JSON.stringify([raw, tables]));
  }
  const twoOwners = async (sql, params) => sql.includes("GROUP BY owner") ? [{ owner: "a" }, { owner: "b" }] : run(sql, params);
  const err = await userTaskDetail(from, to, { id: `codex:c1:${U1}` }, both, twoOwners, DEFAULT_CODEX_PRICING).then(() => null, e => e);
  assert.ok(err instanceof NotFoundError);
  // Without a user the header has no user condition; with one it keeps EXACT_USER.
  assert.ok(!claudeDetailSql(from, to, TRACE, { userExact: null }).header.sql.includes("{userExact:String}"));
  assert.ok(claudeDetailSql(from, to, TRACE, { userExact: "a" }).header.sql.includes("{userExact:String}"));
});

test("context series: one point per call in time order, unknown tokens counted missing", () => {
  const rows = [llm("b", 5000, { a_input_tokens: "20", a_cache_read_tokens: "300" }), llm("a", 1000),
    llm("c", 9000, { agent_id: "ag1", a_cache_creation_tokens: "" })];
  const out = foldTaskDetail({ client: "claude", ...header() }, rows, [{ request_id: "r-a", cost_usd: 0.1 }]);
  assert.deepEqual(out.context.points, [{ span: "a", lane: "main", start_ms: 1000, tokens: 110 },
    { span: "b", lane: "main", start_ms: 5000, tokens: 320 }, { span: "c", lane: "ag1", start_ms: 9000, tokens: null }]);
  assert.equal(out.context.missing, 1);
  assert.equal(out.context.partial, false);
  // No prompt id on any call: the compaction link is unknown, not "no compaction".
  assert.equal(out.context.compactions, null);
  assert.equal(out.context.limits, null);
});

test("compactions link through prompt ids and are deduplicated and bounded", () => {
  const rows = [llm("a", 1000)];
  const costs = [{ request_id: "r-a", cost_usd: 0.1, prompt_id: "p1" }];
  const at = String(t0 + 20000);
  const comp = { ts_ms: at, prompt_id: "p1", pre_tokens: "320000", post_tokens: "41000", trigger: "auto", success: "true" };
  const out = foldTaskDetail({ client: "claude", ...header() }, rows, costs, [comp, { ...comp },
    { ...comp, ts_ms: String(t0 + 30000), pre_tokens: "x", trigger: "has space", success: "" }]);
  assert.deepEqual(out.context.compactions, [
    { start_ms: 20000, pre_tokens: 320000, post_tokens: 41000, trigger: "auto", success: true },
    { start_ms: 30000, pre_tokens: null, post_tokens: 41000, trigger: null, success: null }]);
  assert.deepEqual(foldTaskDetail({ client: "claude", ...header() }, rows, costs, []).context.compactions, []);
  const many = Array.from({ length: COMPACTION_LIMIT + 5 }, (_, i) => ({ ...comp, ts_ms: String(t0 + i) }));
  assert.equal(foldCompactions(many, t0).length, COMPACTION_LIMIT);
  assert.ok(!JSON.stringify(out).includes("p1"), "prompt ids are never returned");
});

test("compaction and limit SQL bind every value", () => {
  const c = claudeCompactionSql(from, to, ["p1", "p2"]);
  assert.deepEqual(c.params.promptIds, ["p1", "p2"]);
  assert.match(c.sql, /LogAttributes\['prompt\.id'\] IN \{promptIds:Array\(String\)\}/);
  assert.match(c.sql, /EventName IN \('compaction', 'claude_code\.compaction'\)/);
  assert.equal(c.params.logFrom, "2026-11-04 23:00:00", "an hour before the bucket");
  assert.equal(c.params.logTo, "2026-11-07 00:00:00");
  const start = ms("2026-11-05T10:00:00Z");
  const l = codexLimitsSql({ userExact: "kim@x.com" }, "c1", start);
  assert.equal(l.params.conversationId, "c1");
  assert.equal(l.params.userExact, "kim@x.com");
  assert.equal(l.params.logFrom, "2026-10-29 10:00:00");
  assert.ok(l.params.beforeMs > start);
  assert.match(l.sql, /ORDER BY Timestamp DESC\s+LIMIT 1/);
  for (const { sql } of [c, l]) {
    assert.ok(!sql.includes("kim@x.com") && !sql.includes("p1") && !sql.includes("c1"));
    assert.ok(!/SELECT \*/.test(sql));
  }
});

test("Codex limits: reported values, unknown when absent", () => {
  assert.deepEqual(foldLimits([{ context_window: "1000000", auto_compact_token_limit: "180000" }]),
    { context_window: 1000000, auto_compact_token_limit: 180000 });
  assert.deepEqual(foldLimits([{ context_window: "1048576", auto_compact_token_limit: "" }]),
    { context_window: 1048576, auto_compact_token_limit: null });
  assert.equal(foldLimits([{ context_window: "", auto_compact_token_limit: "-1" }]), null);
  assert.equal(foldLimits([]), null);
});

test("detail runs the compaction query only with prompt ids and the limits query for Codex", async () => {
  const seen = [];
  const run = async (sql, params) => {
    seen.push(sql);
    if (sql.includes("SpanType = 'interaction'")) return [header({ owner: "kim@x.com" })];
    if (sql.includes("count() OVER ()")) return [llm("a", 0, { total_spans: "1" })];
    if (sql.includes("request_id IN") || sql.includes("{requestIds:Array(String)}")) return [{ request_id: "r-a", cost_usd: 0.3, prompt_id: "p1" }];
    if (sql.includes("'compaction'")) return [{ ts_ms: String(t0 + 10), prompt_id: "p1", pre_tokens: "9", post_tokens: "1", trigger: "manual", success: "true" }];
    return [];
  };
  const out = await userTaskDetail(from, to, { id: `claude:${TRACE}`, userExact: "kim@x.com" }, both, run);
  assert.equal(out.context.compactions.length, 1);
  assert.ok(seen.some(s => s.includes("'compaction'")));
  const noPrompt = [];
  await userTaskDetail(from, to, { id: `claude:${TRACE}`, userExact: "kim@x.com" }, both, async (sql, p) => {
    noPrompt.push(sql);
    if (sql.includes("{requestIds:Array(String)}")) return [{ request_id: "r-a", cost_usd: 0.3 }];
    return run(sql, p);
  });
  assert.ok(!noPrompt.some(s => s.includes("'compaction'")));
});

test("the detail cache key keeps a shared link apart from a literal null user", () => {
  const base = { from: "2026-11-05T00:00:00Z", to: "2026-11-06T00:00:00Z", id: `claude:${TRACE}` };
  const shared = taskDetailCacheKey(base, both);
  const literal = taskDetailCacheKey({ ...base, userExact: "null" }, both);
  assert.notEqual(shared, literal);
  assert.ok(!shared.includes("userExact"));
  assert.ok(literal.includes("userExact=null"));
});

test("Codex limits are bounded by the turn end plus slack", () => {
  const start = ms("2026-11-05T10:00:00Z"), end = start + 600000;
  assert.ok(codexLimitsSql({ userExact: "a" }, "c1", start, end).params.beforeMs > end);
  assert.ok(codexLimitsSql({ userExact: "a" }, "c1", start).params.beforeMs > start);
});

test("claudeEnvironmentSql reads the session's MCP and plugin events before the task ends", () => {
  const { sql, params } = claudeEnvironmentSql("sess-1", t0, t0 + 60000);
  assert.equal(params.sessionId, "sess-1");
  assert.equal(ENVIRONMENT_LOOKBACK_DAYS, 14);
  assert.equal(params.envFrom, "2026-10-22 01:00:00");
  assert.ok(params.envTo > "2026-11-05 01:01:00");
  assert.ok(sql.includes("EventName IN ('mcp_server_connection', 'plugin_loaded')"));
  assert.ok(sql.includes("SessionId = {sessionId:String}"));
  assert.ok(sql.includes("argMax(LogAttributes['status'], Timestamp)"), "latest status per server");
});

test("foldEnvironment counts MCP servers by latest status and plugin paths, never inventing zeros", () => {
  const env = foldEnvironment([
    { event: "mcp_server_connection", name: "github", status: "connected" },
    { event: "mcp_server_connection", name: "plugin:slack:slack", status: "failed" },
    { event: "mcp_server_connection", name: "my server/with space", status: "connected" },
    { event: "mcp_server_connection", name: "docs", status: "disconnected" },
    { event: "plugin_loaded", name: "p1", skills: "3", agents: "1", commands: "2", has_mcp: "true" },
    { event: "plugin_loaded", name: "p2", skills: null, agents: "0", commands: "4", has_mcp: "false" },
  ]);
  assert.deepEqual(env.mcp, { connected: 2, failed: 1, other: 1,
    servers: [{ name: "docs", status: "disconnected" }, { name: "github", status: "connected" },
      { name: "plugin:slack:slack", status: "failed" }, { name: null, status: "connected" }] });
  assert.deepEqual(env.plugins, { count: 2, skills: 3, agents: 1, commands: 6, with_mcp: 1, counts_partial: true });
  assert.equal(env.lookback_days, 14);
  // No events at all is unknown, not an empty environment.
  assert.equal(foldEnvironment([]), null);
  // Only plugins observed: MCP stays unknown rather than zero.
  assert.equal(foldEnvironment([{ event: "plugin_loaded", name: "p1", skills: "1", agents: "0", commands: "0", has_mcp: "false" }]).mcp, null);
});

test("the Claude detail carries the session environment and never the raw session id", async () => {
  const base = fakeRun({ owner: "kim@x.com" });
  const seen = [];
  const run = async (sql, params) => {
    if (sql.includes("'mcp_server_connection'")) {
      seen.push(params);
      return [{ event: "mcp_server_connection", name: "github", status: "connected" }];
    }
    if (sql.includes("SpanType = 'interaction'")) {
      const rows = await base(sql, params);
      return rows.map((r) => ({ ...r, session_id: "sess-secret-1" }));
    }
    return base(sql, params);
  };
  const out = await userTaskDetail(from, to, { id: `claude:${TRACE}`, userExact: "kim@x.com" }, both, run);
  assert.equal(seen[0].sessionId, "sess-secret-1");
  assert.equal(out.environment.mcp.connected, 1);
  assert.ok(!JSON.stringify(out).includes("sess-secret-1"));
  const codex = await userTaskDetail(from, to, { id: `codex:c1:${U1}`, userExact: "kim@x.com" }, both, base, DEFAULT_CODEX_PRICING);
  assert.equal(codex.environment, null);
});

test("codex turn SQL counts tries and compactions per span id", () => {
  const { sql, params } = codexTurnSql(from, to, validateTaskQuery({ userExact: "a" }, both));
  assert.match(sql, /uniqIf\(SpanId, SpanName = 'try_run_sampling_request'\) AS sampling_tries/);
  assert.match(sql, /uniqIf\(SpanId, SpanName = 'codex\.compaction'\) AS compactions/);
  // The per-span counts read SpanId from the deduplicated span subquery, which must select it.
  assert.match(sql, /SELECT Timestamp, SpanName, SpanId,\n/);
  assert.match(sql, /anyIf\(span_version, span_version != ''\) AS app_version/);
  assert.match(sql, /ResourceAttributes\['service\.version'\] AS span_version/);
  assert.ok(!Object.values(params).some(v => String(v).includes("try_run_sampling_request")));
});

test("codex retries are tries minus runs and unknown without runs", () => {
  assert.equal(codexRetries({ legacy_calls: "3", sampling_tries: "5" }), 2);
  assert.equal(codexRetries({ legacy_calls: "3", sampling_tries: "3" }), 0);
  assert.equal(codexRetries({ legacy_calls: "0", sampling_tries: "5" }), null);
  assert.equal(codexRetries({ legacy_calls: "3", sampling_tries: "2" }), null);
  assert.equal(codexRetries({ legacy_calls: "3" }), null);
});

test("namesTurnOnTools reads versions numerically", () => {
  for (const v of ["0.166.0", "0.169.0", "0.166.0-alpha.5.1", "1.0.0"]) assert.equal(namesTurnOnTools(v), true, v);
  for (const v of ["0.165.0", "0.99.9", "", null, undefined]) assert.equal(namesTurnOnTools(v), false, String(v));
});

test("emitsTurnCompactions reads versions numerically: Codex 0.161 and later", () => {
  for (const v of ["0.161.0", "0.161.0-alpha.1", "0.169.0", "1.0.0"]) assert.equal(emitsTurnCompactions(v), true, v);
  for (const v of ["0.160.1", "0.154.0", "0.99.9", "", null, undefined]) assert.equal(emitsTurnCompactions(v), false, String(v));
});

test("codex detail reports retries and compactions from the turn row", () => {
  const sp = (id, name, at) => ({ span_id: id, parent_id: "", span_name: name, start_ms: String(ms(at)),
    duration_ms: "10", a_model: "", a_tool_name: "", a_aborted: "", total_spans: "2" });
  const rows = [sp("c2", "codex.compaction", "2026-11-05T01:00:06Z"), sp("c1", "codex.compaction", "2026-11-05T01:00:02Z")];
  const run = (o, r = rows) => foldTaskDetail({ client: "codex", turn: turn({ legacy_calls: "3", sampling_tries: "5",
    compactions: "2", app_version: "0.161.0", ...o }), linked: [] }, r, []);
  const ok = run({});
  assert.equal(ruleMap(ok).retries, 2);
  assert.deepEqual(ok.context.compactions.map(c => c.start_ms), [2000, 6000]);
  assert.deepEqual(ok.context.compactions[0], { start_ms: 2000, pre_tokens: null, post_tokens: null, trigger: null, success: null });
  assert.equal(ok.context.compactions_total, 2);
  assert.equal(ok.context.compactions_partial, false);
  const none = run({ legacy_calls: "0" });
  assert.ok(!("retries" in ruleMap(none)));
  assert.equal(none.context.compactions, null);
  assert.equal(none.context.compactions_total, null);
  assert.deepEqual(run({ compactions: "0" }, []).context.compactions, []);
  assert.equal(run({ compactions: "0" }, []).context.compactions_total, 0);
  // Truncated span list: the turn row counts more compactions than the rows show; the total is the row's.
  const partial = run({ compactions: "4" });
  assert.equal(partial.context.compactions.length, 2);
  assert.equal(partial.context.compactions_total, 4);
  assert.equal(partial.context.compactions_partial, true);
  // Codex before 0.161 emits no turn-tagged compaction spans: unknown, never a known zero.
  for (const v of ["0.160.1", "0.154.0", ""]) {
    const old = run({ compactions: "0", app_version: v }, []);
    assert.deepEqual([old.context.compactions, old.context.compactions_total, "compactions_partial" in old.context],
      [null, null, false], v);
  }
});

test("the Codex list reads the rollup behind the gate and keeps raw otherwise", async () => {
  const run = (rows, seen) => async (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes("codex_turns_v1")) return rows;
    if (sql.includes("otel_traces")) return [];
    if (sql.includes("codex.sse_event")) return [completion("2026-11-05T01:00:01Z")];
    return [];
  };
  const page = new Date("2026-11-20T00:00:00Z"), pageTo = new Date("2026-11-21T00:00:00Z");
  const boundary = new Date("2026-11-01T00:00:00Z");
  const opt = { userExact: "a", client: "codex" };
  const rawSeen = [];
  await userTasks(page, pageTo, opt, both, run([], rawSeen), undefined, null);
  assert.ok(rawSeen.every(s => !s.sql.includes("codex_turns_v1")), "gate unset: raw reads");
  assert.ok(rawSeen.some(s => s.sql.includes("otel_traces")));
  const before = [];
  await userTasks(new Date("2026-11-05T00:00:00Z"), to, opt, both, run([], before), undefined, boundary);
  assert.ok(before.every(s => !s.sql.includes("codex_turns_v1")), "lookback before the boundary: raw");

  const seen = [];
  const rows = [{ turn_id: U1, in_bucket: 1, conversation_id: "c1", started_at: "2026-11-20T01:00:00Z",
    start_ms: String(ms("2026-11-20T01:00:00Z")), end_ms: String(ms("2026-11-20T01:00:10Z")),
    llm_calls: "2", models: ["openai.gpt-6-astra"], spawn_calls: "3", names_turn: 1 }];
  const out = await userTasks(page, pageTo, opt, both, run(rows, seen), undefined, boundary);
  assert.ok(seen.some(s => s.sql.includes("codex_turns_v1")));
  assert.ok(seen.every(s => !s.sql.includes("otel_traces")), "rollup list never reads spans");
  const rollupSql = seen.find(s => s.sql.includes("codex_turns_v1"));
  assert.ok(rollupSql.sql.includes("min_start < {spanTo:DateTime}"));
  assert.ok(rollupSql.sql.includes("end_ms + 5000 >= toUnixTimestamp({from:DateTime}) * 1000"));
  assert.equal(rollupSql.params.userExact, "a");
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0].subagent_calls, 3);
  assert.equal(out.tasks[0].subagents, null);
});

test("subagent_calls is known only for rows that name the turn on tools", () => {
  const fold = row => foldCodexTask(turn(row), []).subagent_calls;
  assert.equal(fold({}), null, "raw rows carry no spawn_calls");
  assert.equal(fold({ spawn_calls: "4", names_turn: 0 }), null, "before 0.166: not collected");
  assert.equal(fold({ spawn_calls: "0", names_turn: 1 }), 0, "0.166+: a known zero");
  assert.equal(fold({ spawn_calls: "2", names_turn: 1 }), 2);
});

test("the rollup list equals the raw list for the same turns and completions", async () => {
  const base = (id, at, endAt, inBucket, extra = {}) => ({ turn_id: id, in_bucket: inBucket, conversation_id: "c1",
    started_at: at, start_ms: String(ms(at)), end_ms: String(ms(endAt)), llm_calls: "2",
    models: ["openai.gpt-6-astra"], ...extra });
  // A context turn that started before from, ending inside the bucket, and two bucket turns.
  const shapes = [
    base(uuid(10), "2026-11-04T23:59:50Z", "2026-11-05T00:00:30Z", 0),
    base(uuid(11), "2026-11-05T01:00:00Z", "2026-11-05T01:00:10Z", 1),
    base(uuid(12), "2026-11-05T03:00:00Z", "2026-11-05T03:00:10Z", 1, { llm_calls: "1" }),
  ];
  const rollupRows = shapes.map((r, i) => ({ ...r, spawn_calls: String([2, 0, 5][i]), names_turn: i === 2 ? 0 : 1 }));
  const completions = [completion("2026-11-05T00:00:20Z"), completion("2026-11-05T01:00:01Z"),
    completion("2026-11-05T03:00:02Z", { cost_usd: undefined }), completion("2026-11-05T09:00:00Z")];
  const runFor = rows => async (sql) => {
    if (sql.includes("codex_turns_v1") || (sql.includes("otel_traces") && sql.includes("'codex'"))) return rows;
    if (sql.includes("codex.sse_event")) return completions;
    return [];
  };
  const opt = { userExact: "a", client: "codex" };
  const raw = await userTasks(from, to, opt, both, runFor(shapes), undefined, null);
  const roll = await userTasks(from, to, opt, both, runFor(rollupRows), undefined, new Date("2026-10-01T00:00:00Z"));
  const key = t => ({ id: t.id, llm_calls: t.llm_calls, models: t.models, cost_usd: t.cost_usd,
    cost_partial: t.cost_partial, tokens: t.tokens, started_at: t.started_at, duration_ms: t.duration_ms });
  assert.equal(raw.tasks.length, 2, "context turn is not a task of this bucket");
  assert.deepEqual(roll.tasks.map(key), raw.tasks.map(key));
  assert.deepEqual(roll.unattached_codex, raw.unattached_codex);
  assert.equal(raw.unattached_codex.completions, 1);
  assert.deepEqual(roll.coverage, raw.coverage);
  assert.deepEqual(raw.tasks.map(t => t.subagent_calls), [null, null]);
  assert.deepEqual(roll.tasks.map(t => t.subagent_calls), [0, null]);
  // The completion at 00:00:20 attached to the context turn, so its cost is not unattached.
  const lost = attachCompletions(shapes.slice(1), completions, { ...opts });
  assert.equal(lost.unattached.completions, 2, "without the context turn that completion is unattached");
});

// ── Rollup detail (CODEX_TURNS_READ_FROM): the turn's own window ────────
const { turnHourMs } = await import("./codexTurnsSchema.js");
const { codexDetailHourFrom } = detail;
const BOUNDARY = new Date("2026-10-01T00:00:00Z");
const DAY_MS = 24 * 3600000;
const v7 = (iso, n = 0) => {
  const hex = Date.parse(iso).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-${String(n).padStart(12, "0")}`;
};
const chMs = (text) => Date.parse(text.replace(" ", "T") + "Z");
// A rollup row (codexTurnsSource.rollupTurnSql shape) of owner "a", conversation c1.
const rollupRow = (id, at, endAt, extra = {}) => ({ turn_id: id, conversation_id: "c1", started_at: at.slice(0, 19) + "Z",
  start_ms: String(ms(at)), end_ms: String(ms(endAt)), sampling_calls: "2", legacy_calls: "0", sampling_tries: "0",
  compactions: "0", app_version: "0.169.0", llm_calls: "2", sampling_span: "codex.sampling",
  models: ["openai.gpt-6-astra"], spawn_calls: "0", names_turn: 1, ...extra });
// A store-like fake for owner "a": every turn and completion read honours its bound window, so a
// read narrowed wrongly changes the result. Raw turn reads return `rawTurns` unclipped.
const storeRun = ({ turns = [], rawTurns = [], completions = [], spans = [], seen = [], rollupOwners } = {}) =>
  async (sql, params) => {
    seen.push({ sql, params });
    const owned = params.userExact === undefined || params.userExact === "a";
    const conv = (r) => (params.conversationId === undefined || r.conversation_id === params.conversationId)
      && (params.conversationIds === undefined || params.conversationIds.includes(r.conversation_id));
    const bucket = (r) => ({ ...r, in_bucket: +r.start_ms >= chMs(params.from) && +r.start_ms < chMs(params.to) ? 1 : 0 });
    if (sql.includes("codex_turns_v1") && sql.includes("GROUP BY owner"))
      return rollupOwners ?? (turns.some(r => r.turn_id === params.turnId) ? [{ owner: "a" }] : []);
    if (sql.includes("codex_turns_v1")) {
      if (!owned) return [];
      return turns.filter(r => {
        const hour = turnHourMs(r.turn_id, +r.start_ms), s = +r.start_ms, e = +r.end_ms;
        if (hour < chMs(params.hourFrom) || hour >= chMs(params.hourTo) || !conv(r)) return false;
        if (params.turnId !== undefined) return r.turn_id === params.turnId;
        if (params.startFrom !== undefined || params.startTo !== undefined)
          return (params.startFrom === undefined || s >= params.startFrom) && (params.startTo === undefined || s < params.startTo);
        return s < chMs(params.spanTo) && e + COMPLETION_SLACK >= chMs(params.from);
      }).map(bucket);
    }
    if (sql.includes("otel_traces") && sql.includes("GROUP BY owner"))
      return rawTurns.some(r => r.turn_id === params.turnId && r.conversation_id === params.conversationId) ? [{ owner: "a" }] : [];
    if (sql.includes("otel_traces") && sql.includes("GROUP BY turn_id")) return owned ? rawTurns.filter(conv).map(bucket) : [];
    if (sql.includes("codex.sse_event"))
      return owned ? completions.filter(c => conv(c) && +c.timestamp_ms >= chMs(params.logFrom) && +c.timestamp_ms < chMs(params.logTo)) : [];
    if (sql.includes("count() OVER ()")) return owned ? spans : [];
    return [];
  };
const COMPLETION_SLACK = 5000;
const codexSpan = (id, at, extra = {}) => ({ span_id: id, parent_id: "", span_name: "codex.sampling", start_ms: String(ms(at)),
  duration_ms: "1000", trace_id: "tr-rollup", a_model: "openai.gpt-6-astra", total_spans: "1", ...extra });
const readOf = (seen, pick) => seen.find(s => pick(s));
const rawTurnRead = (s) => s.sql.includes("otel_traces") && s.sql.includes("GROUP BY turn_id");

test("on the rollup path the Codex detail reads its turn's own window", async () => {
  const id = v7("2026-11-05T05:00:00Z", 1);
  const row = rollupRow(id, "2026-11-05T05:00:00.000Z", "2026-11-05T05:00:10.250Z");
  const seen = [];
  const run = storeRun({ turns: [row], spans: [codexSpan("s1", "2026-11-05T05:00:01Z")], seen,
    completions: [completion("2026-11-05T05:00:02Z")] });
  const out = await userTaskDetail(from, to, { id: `codex:c1:${id}`, userExact: "a" }, both, run, DEFAULT_CODEX_PRICING, BOUNDARY);
  assert.equal(out.task.id, `codex:c1:${id}`);
  assert.equal(out.task.llm_calls, 2);
  assert.ok(Math.abs(out.task.cost_usd - unitCost) < 1e-12);
  assert.ok(!seen.some(rawTurnRead), "no raw turn read");
  const s = ms("2026-11-05T05:00:00Z"), e = ms("2026-11-05T05:00:10.250Z");
  // Turn row: from the id's hour minus 7 days, never after the list's first hour (from - 7 days),
  // every hour row of the turn merged, owner and conversation bound.
  const own = readOf(seen, x => x.sql.includes("codex_turns_v1") && x.params.turnId !== undefined);
  assert.deepEqual([own.params.turnId, own.params.conversationId, own.params.userExact, own.params.hourFrom],
    [id, "c1", "a", "2026-10-29 00:00:00"]);
  assert.equal(+codexDetailHourFrom(from, v7("2026-11-01T05:30:00Z")), Date.parse("2026-10-25T05:00:00Z"), "id hour - 7 days");
  assert.equal(+codexDetailHourFrom(new Date("2026-11-01T00:00:00Z"), v7("2026-11-12T05:30:00Z")), Date.parse("2026-10-25T00:00:00Z"),
    "a late id on a long page: the list's first hour");
  // Competitors: start in [s, e + slack] and before to + 24h (startTo is exclusive ms).
  const competitors = readOf(seen, x => x.sql.includes("codex_turns_v1") && x.params.startFrom !== undefined);
  assert.deepEqual([competitors.params.startFrom, competitors.params.startTo, competitors.params.conversationId,
    competitors.params.userExact, competitors.params.hourFrom, competitors.params.turnId], [s, e + 5001, "c1", "a", "2026-10-29 00:00:00", undefined]);
  // Completions: [max(s - 1h, from), min(e + 24h, to + 24h)), upper bound rounded up to the second.
  const completions = readOf(seen, x => x.sql.includes("codex.sse_event"));
  assert.deepEqual([completions.params.logFrom, completions.params.logTo, completions.params.conversationId, completions.params.userExact],
    ["2026-11-05 04:00:00", "2026-11-06 05:00:11", "c1", "a"]);
  // Spans and skills: [s - 1 min, min(e + 1 min, to + 24h)).
  const spanRead = readOf(seen, x => x.sql.includes("count() OVER ()"));
  assert.deepEqual([spanRead.params.spanFrom, spanRead.params.spanTo, spanRead.params.turnId, spanRead.params.userExact],
    ["2026-11-05 04:59:00", "2026-11-05 05:01:11", id, "a"]);
  const skills = readOf(seen, x => x.sql.includes("codex.skill_invocation"));
  assert.deepEqual([skills.params.logFrom, skills.params.logTo, skills.params.turnId, skills.params.conversationId, skills.params.userExact],
    ["2026-11-05 04:59:00", "2026-11-05 05:01:11", id, "c1", "a"]);
  // The window values are bound parameters, never SQL text.
  for (const x of [own, competitors, completions, spanRead, skills])
    assert.ok(!x.sql.includes(id) && !x.sql.includes("2026-") && !x.sql.includes("'a'"), x.sql.slice(0, 60));
});

test("the Codex detail keeps its raw reads unless both the list and the turn read the rollup", async () => {
  const id = v7("2026-11-05T05:00:00Z", 1);
  const row = rollupRow(id, "2026-11-05T05:00:00Z", "2026-11-05T05:00:10Z");
  const raw = { ...row, spawn_calls: undefined, names_turn: undefined };
  const cases = [
    ["gate unset", from, to, id, null],
    ["list lookback before the boundary", from, to, id, new Date("2026-10-30T00:00:00Z")],
    ["non-v7 turn id", from, to, U1, BOUNDARY],
  ];
  for (const [label, pageFrom, pageTo, turnId, boundary] of cases) {
    const seen = [];
    const run = storeRun({ turns: [{ ...row, turn_id: turnId }], rawTurns: [{ ...raw, turn_id: turnId }], seen,
      spans: [codexSpan("s1", "2026-11-05T05:00:01Z")] });
    const out = await userTaskDetail(pageFrom, pageTo, { id: `codex:c1:${turnId}`, userExact: "a" }, both, run, DEFAULT_CODEX_PRICING, boundary);
    assert.equal(out.task.id, `codex:c1:${turnId}`, label);
    assert.ok(!seen.some(x => x.sql.includes("codex_turns_v1") && x.params.turnId !== undefined), `${label}: no rollup detail read`);
    assert.ok(seen.some(rawTurnRead), `${label}: raw turn read`);
    const spanRead = readOf(seen, x => x.sql.includes("count() OVER ()"));
    assert.deepEqual([spanRead.params.spanFrom, spanRead.params.spanTo], ["2026-11-04 00:00:00", "2026-11-07 00:00:00"], label);
    const completions = readOf(seen, x => x.sql.includes("codex.sse_event"));
    assert.deepEqual([completions.params.logFrom, completions.params.logTo], ["2026-11-05 00:00:00", "2026-11-07 00:00:00"], label);
    const skills = readOf(seen, x => x.sql.includes("codex.skill_invocation"));
    assert.deepEqual([skills.params.logFrom, skills.params.logTo], ["2026-11-04 00:00:00", "2026-11-07 00:00:00"], label);
  }
});

test("a rollup miss falls back to the raw detail and never answers not found by itself", async () => {
  const id = v7("2026-11-05T05:00:00Z", 1);
  const raw = { ...rollupRow(id, "2026-11-05T05:00:00Z", "2026-11-05T05:00:10Z"), spawn_calls: undefined, names_turn: undefined };
  // No rollup row for the turn (lost row, or a conversation the merged set lacks): raw read.
  const seen = [];
  const out = await userTaskDetail(from, to, { id: `codex:c1:${id}`, userExact: "a" }, both,
    storeRun({ rawTurns: [raw], seen }), DEFAULT_CODEX_PRICING, BOUNDARY);
  assert.equal(out.task.id, `codex:c1:${id}`);
  assert.ok(seen.some(x => x.sql.includes("codex_turns_v1") && x.params.turnId === id));
  assert.ok(seen.some(rawTurnRead));
  // A shared link whose rollup owner read finds no owner: the raw owner read decides.
  const shared = [];
  const link = await userTaskDetail(from, to, { id: `codex:c1:${id}` }, both, storeRun({ rawTurns: [raw], seen: shared }),
    DEFAULT_CODEX_PRICING, BOUNDARY);
  assert.equal(link.owner, "a");
  assert.ok(shared.some(x => x.sql.includes("codex_turns_v1") && x.sql.includes("GROUP BY owner")));
  assert.ok(shared.some(x => x.sql.includes("otel_traces") && x.sql.includes("GROUP BY owner")));
  // Two rollup owners: ambiguous there, so raw decides too (here: one owner, the link opens).
  const two = await userTaskDetail(from, to, { id: `codex:c1:${id}` }, both,
    storeRun({ rawTurns: [raw], rollupOwners: [{ owner: "a" }, { owner: "b" }] }), DEFAULT_CODEX_PRICING, BOUNDARY);
  assert.equal(two.owner, "a");
  // Nowhere: not found.
  const err = await userTaskDetail(from, to, { id: `codex:c1:${id}`, userExact: "a" }, both, storeRun({}), DEFAULT_CODEX_PRICING, BOUNDARY)
    .then(() => null, e => e);
  assert.ok(err instanceof NotFoundError);
  // A shared link resolved by the rollup reads everything for that owner.
  const resolved = [];
  const viaRollup = await userTaskDetail(from, to, { id: `codex:c1:${id}` }, both,
    storeRun({ turns: [rollupRow(id, "2026-11-05T05:00:00Z", "2026-11-05T05:00:10Z")], seen: resolved }), DEFAULT_CODEX_PRICING, BOUNDARY);
  assert.equal(viaRollup.owner, "a");
  assert.ok(!resolved.some(x => x.sql.includes("otel_traces") && x.sql.includes("GROUP BY owner")));
  assert.ok(resolved.filter(x => x.params.userExact !== undefined).every(x => x.params.userExact === "a"));
});

test("a rollup turn that starts before the page is not a detail of this page", async () => {
  const id = v7("2026-11-04T23:59:00Z", 1);
  const seen = [];
  const run = storeRun({ turns: [rollupRow(id, "2026-11-04T23:59:00Z", "2026-11-05T00:10:00Z")], seen });
  const err = await userTaskDetail(from, to, { id: `codex:c1:${id}`, userExact: "a" }, both, run, DEFAULT_CODEX_PRICING, BOUNDARY)
    .then(() => null, e => e);
  assert.ok(err instanceof NotFoundError);
  assert.ok(!seen.some(rawTurnRead), "an out-of-bucket rollup row is an answer, not a miss");
});

test("the rollup detail equals its rollup list row", async () => {
  const opt = { userExact: "a", client: "codex" };
  const check = async (label, pageFrom, pageTo, turns, completions, id, extra = () => {}) => {
    const list = await userTasks(pageFrom, pageTo, opt, both, storeRun({ turns, completions }), DEFAULT_CODEX_PRICING, BOUNDARY);
    const seen = [];
    const detail = await userTaskDetail(pageFrom, pageTo, { id: `codex:c1:${id}`, userExact: "a" }, both,
      storeRun({ turns, completions, seen, spans: [codexSpan("s1", new Date(+turns.find(t => t.turn_id === id).start_ms + 1000).toISOString())] }),
      DEFAULT_CODEX_PRICING, BOUNDARY);
    assert.ok(!seen.some(rawTurnRead), `${label}: rollup detail`);
    const row = list.tasks.find(t => t.id === `codex:c1:${id}`);
    assert.ok(row, `${label}: listed`);
    const key = t => ({ llm_calls: t.llm_calls, models: t.models, cost_usd: t.cost_usd, cost_partial: t.cost_partial,
      tokens: t.tokens, duration_ms: t.duration_ms, started_at: t.started_at, subagent_calls: t.subagent_calls });
    assert.deepEqual(key(detail.task), key(row), label);
    extra({ list, row, detail, seen });
  };
  // (a) A later same-conversation turn starting within the slack wins the completion after its start.
  const a = v7("2026-11-05T05:00:00Z", 1), aNext = v7("2026-11-05T05:00:12Z", 2), aBefore = v7("2026-11-05T04:59:00Z", 3);
  await check("normal turn", from, to, [
    rollupRow(aBefore, "2026-11-05T04:59:00Z", "2026-11-05T05:00:30Z"),
    rollupRow(a, "2026-11-05T05:00:00Z", "2026-11-05T05:00:10Z"),
    rollupRow(aNext, "2026-11-05T05:00:12Z", "2026-11-05T05:00:20Z", { llm_calls: "1" }),
  ], [completion("2026-11-05T05:00:05Z"), completion("2026-11-05T05:00:13Z"),
    completion("2026-11-05T05:00:06Z", { model: "openai.gpt-6.1-sol", cost_usd: undefined, input_token_count: "" })], a,
  ({ row, detail }) => {
    assert.equal(row.subagent_calls, 0);
    assert.equal(detail.task.subagents, 0, "known zero: no spawn spans, complete, 0.166+");
    assert.equal(detail.agents.known_zero, true);
    assert.equal(row.tokens.observed_tokens !== null, true);
  });
  // (b) A turn running past to + 24h: unclipped end; the window stops at to + 24h like the list.
  const b = v7("2026-11-05T20:00:00Z", 4), bLate = v7("2026-11-07T00:30:00Z", 5);
  await check("turn ending after to + 24h", from, to, [
    rollupRow(b, "2026-11-05T20:00:00Z", "2026-11-07T02:00:00Z", { spawn_calls: "2" }),
    rollupRow(bLate, "2026-11-07T00:30:00Z", "2026-11-07T00:50:00Z"),
  ], [completion("2026-11-05T20:00:05Z"), completion("2026-11-06T23:00:00Z"),
    // Collector time before to + 24h, event time after the later turn's start: only a read of that
    // turn (beyond the list's context) would take it away.
    completion("2026-11-07T00:45:00Z", { timestamp_ms: String(ms("2026-11-06T23:59:59Z")) }),
    completion("2026-11-07T01:00:00Z")], b,
  ({ row, detail, seen }) => {
    assert.equal(row.duration_ms, ms("2026-11-07T02:00:00Z") - ms("2026-11-05T20:00:00Z"));
    assert.equal(row.llm_calls, 2);
    assert.equal(row.subagent_calls, 2);
    // Spans stop at to + 24h, so their spawn calls are partial: never a known zero beside 2 calls.
    assert.deepEqual([detail.task.subagent_calls, detail.agents.spawn_calls, detail.agents.known_zero, detail.task.subagents],
      [2, null, false, null]);
    const competitors = readOf(seen, x => x.sql.includes("codex_turns_v1") && x.params.startFrom !== undefined);
    assert.equal(competitors.params.startTo, +to + DAY_MS);
    const completions = readOf(seen, x => x.sql.includes("codex.sse_event"));
    assert.equal(completions.params.logTo, "2026-11-07 00:00:00");
    const spanRead = readOf(seen, x => x.sql.includes("count() OVER ()"));
    assert.equal(spanRead.params.spanTo, "2026-11-07 00:00:00");
  });
  // (d) A competitor starting exactly at e + slack wins a completion at exactly e + slack: linking
  // accepts that time, so the competitor bound is inclusive there.
  const edge = v7("2026-11-05T07:00:00Z", 9), edgeNext = v7("2026-11-05T07:00:15Z", 10);
  await check("competitor at exactly e + slack", from, to, [
    rollupRow(edge, "2026-11-05T07:00:00.000Z", "2026-11-05T07:00:10.000Z"),
    rollupRow(edgeNext, "2026-11-05T07:00:15.000Z", "2026-11-05T07:00:20.000Z"),
  ], [completion("2026-11-05T07:00:05.000Z"), completion("2026-11-05T07:00:15.000Z")], edge,
  ({ row, seen }) => {
    assert.ok(Math.abs(row.cost_usd - unitCost) < 1e-12, "the later turn wins the completion at e + 5 s");
    const competitors = readOf(seen, x => x.sql.includes("codex_turns_v1") && x.params.startFrom !== undefined);
    assert.equal(competitors.params.startTo, ms("2026-11-05T07:00:15.000Z") + 1);
  });
  // (c) A one-hour link window: completions start at the window, never s - 1h before it.
  const hourFrom = new Date("2026-11-05T05:00:00Z"), hourTo = new Date("2026-11-05T06:00:00Z");
  const c = v7("2026-11-05T05:00:00Z", 6), cNext = v7("2026-11-05T05:00:05Z", 7), cPrev = v7("2026-11-05T04:59:50Z", 8);
  await check("one-hour link window", hourFrom, hourTo, [
    rollupRow(cPrev, "2026-11-05T04:59:50Z", "2026-11-05T05:00:30Z"),
    rollupRow(c, "2026-11-05T05:00:00Z", "2026-11-05T05:00:10Z"),
    rollupRow(cNext, "2026-11-05T05:00:05Z", "2026-11-05T05:00:20Z"),
  ], [completion("2026-11-05T04:59:55Z"), completion("2026-11-05T05:00:02Z"), completion("2026-11-05T05:00:07Z")], c,
  ({ row, seen }) => {
    assert.ok(Math.abs(row.cost_usd - unitCost) < 1e-12, "one completion: the later turn wins 05:00:07");
    const completions = readOf(seen, x => x.sql.includes("codex.sse_event"));
    assert.equal(completions.params.logFrom, "2026-11-05 05:00:00");
  });
});

test("a rollup detail whose spans hold fewer spawn calls than its turn row has no spawn evidence", async () => {
  const id = v7("2026-11-05T05:00:00Z", 1);
  const spawn = codexSpan("g1", "2026-11-05T05:00:02Z", { span_name: "collaborationspawn_agent", a_tool_name: "collaborationspawn_agent",
    total_spans: "2" });
  const spans = [codexSpan("s1", "2026-11-05T05:00:01Z", { total_spans: "2" }), spawn];
  const detailFor = async (spawnCalls) => userTaskDetail(from, to, { id: `codex:c1:${id}`, userExact: "a" }, both,
    storeRun({ turns: [rollupRow(id, "2026-11-05T05:00:00Z", "2026-11-05T05:00:10Z", { spawn_calls: spawnCalls })], spans }),
    DEFAULT_CODEX_PRICING, BOUNDARY);
  // Not clipped, but the turn row counts 2 spawn calls and the spans show 1: unknown.
  const short = await detailFor("2");
  assert.deepEqual([short.task.subagent_calls, short.agents.spawn_calls, short.agents.unlinked_calls, short.agents.known_zero,
    short.task.subagents], [2, null, null, false, null]);
  // The spans account for every call: the spawn call stays known (here unlinked).
  const whole = await detailFor("1");
  assert.deepEqual([whole.task.subagent_calls, whole.agents.spawn_calls, whole.agents.unlinked_calls, whole.agents.known_zero],
    [1, 1, 1, false]);
  // A known zero needs the turn row's zero too.
  const zero = await userTaskDetail(from, to, { id: `codex:c1:${id}`, userExact: "a" }, both,
    storeRun({ turns: [rollupRow(id, "2026-11-05T05:00:00Z", "2026-11-05T05:00:10Z")], spans: [{ ...spans[0], total_spans: "1" }] }), DEFAULT_CODEX_PRICING, BOUNDARY);
  assert.deepEqual([zero.task.subagent_calls, zero.agents.spawn_calls, zero.agents.known_zero, zero.task.subagents], [0, 0, true, 0]);
  // A turn whose spans run past to + 24h (span window clipped): unknown even with a zero row count.
  const longId = v7("2026-11-05T20:00:00Z", 2);
  const clipped = await userTaskDetail(from, to, { id: `codex:c1:${longId}`, userExact: "a" }, both,
    storeRun({ turns: [rollupRow(longId, "2026-11-05T20:00:00Z", "2026-11-06T23:59:30Z")],
      spans: [codexSpan("s1", "2026-11-05T20:00:01Z")] }), DEFAULT_CODEX_PRICING, BOUNDARY);
  assert.deepEqual([clipped.task.subagent_calls, clipped.agents.spawn_calls, clipped.agents.known_zero, clipped.task.subagents],
    [0, null, false, null]);
});
