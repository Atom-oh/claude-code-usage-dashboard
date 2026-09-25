import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import * as logs from "./codexInsightsLogs.js";
import { buildCodexLogAggregateQuery, foldCodexLogAggregates } from "./codexLogAggregates.js";

function observed(value, tokens, partial) {
  assert.equal(value.observed_tokens, tokens);
  assert.equal(value.tokens_partial, partial);
}

test("Codex log compaction against isolated ClickHouse", {
  skip: process.env.CODEX_LOG_COMPACTION_SQL_TEST !== "1", timeout: 120000,
}, async (t) => {
  const name = `ccdash-log-compaction-${process.pid}`;
  const directory = mkdtempSync(join(tmpdir(), "codex-log-compaction-"));
  function docker(args, input) {
    const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
    return result.stdout.trim();
  }
  const execute = (sql, params = {}) => docker(["exec", "-i", name, "clickhouse-client", "--multiquery",
    ...Object.entries(params).map(([key, value]) => `--param_${key}=${value}`)], sql);
  const from = new Date("2026-09-15T10:00:00Z"), to = new Date("2026-09-15T11:00:00Z");
  const select = (request) => {
    const text = execute(`${request.sql} FORMAT JSONEachRow`, request.params);
    return text ? text.split("\n").map(JSON.parse) : [];
  };
  const insert = (rows) => execute(`INSERT INTO claude_code.otel_logs FORMAT JSONEachRow\n${rows.map(JSON.stringify).join("\n")}`);
  const resource = { client: "codex", backend: "bedrock-mantle", "user.email": "load@example.test" };
  const make = (n, event, attributes = {}, r = {}) => ({ Timestamp: `2026-09-15 10:00:00.${String(n).padStart(9, "0")}`,
    ResourceAttributes: { ...resource, ...r }, LogAttributes: { "event.name": `codex.${event}`,
      "conversation.id": "session", model: "openai.gpt-6-astra", ...attributes } });
  const completion = (n, a = {}, r = {}) => make(n, "sse_event", { "event.kind": "response.completed",
    input_token_count: "100", cached_token_count: "40", cache_write_token_count: "11",
    output_token_count: "30", reasoning_token_count: "10", model_reasoning_effort: "high", duration_ms: "20", ...a }, r);
  const request = (n, a = {}, r = {}) => make(n, "api_request", { attempt: "0", "http.response.status_code": "200", duration_ms: "15", ...a }, r);
  t.after(() => { try { docker(["rm", "-f", name]); } finally { rmSync(directory, { recursive: true, force: true }); } });
  writeFileSync(join(directory, "test.xml"), `<clickhouse><background_schedule_pool_size>16</background_schedule_pool_size><background_buffer_flush_schedule_pool_size>4</background_buffer_flush_schedule_pool_size><background_message_broker_schedule_pool_size>4</background_message_broker_schedule_pool_size><background_distributed_schedule_pool_size>4</background_distributed_schedule_pool_size><max_server_memory_usage>1500000000</max_server_memory_usage></clickhouse>`);
  docker(["run", "-d", "--name", name, "--network", "none", "--memory", "2g", "--cpus", "2", "--tmpfs", "/var/lib/clickhouse:rw,size=1g", "--tmpfs", "/var/log/clickhouse-server:rw,size=128m", "-v", `${join(directory,"test.xml")}:/etc/clickhouse-server/config.d/test.xml:ro`, "clickhouse/clickhouse-server:24.8"]);
  let startup;
  for (let i = 0; i < 60; i++) { try { execute("SELECT 1"); startup = null; break; } catch (error) { startup = error; await setTimeout(250); } }
  if (startup) throw startup;
  const schema = readFileSync(new URL("../../clickhouse-schema.sql", import.meta.url), "utf8");
  execute("CREATE DATABASE claude_code");
  execute(schema.match(/CREATE TABLE IF NOT EXISTS claude_code\.otel_logs\s*\([\s\S]*?;/)[0]);

  await t.test("100000 repeated stream events do not exhaust the detail row budget", () => {
    const bulk = `INSERT INTO claude_code.otel_logs (Timestamp,ResourceAttributes,LogAttributes)
      SELECT toDateTime64('2026-09-15 10:01:00',9)+toIntervalMicrosecond(number),
      map('client','codex','backend','bedrock-mantle','user.email','load@example.test'),
      map('event.name','codex.sse_event','conversation.id','session','model','openai.gpt-6-astra',
        'event.kind','response.output_text.delta','duration_ms',toString(number%10)) FROM numbers(100000)`;
    execute(bulk); execute(bulk);
    insert([completion(1), request(2), make(3,"sse_event",{"event.kind":"response.output_text.delta","conversation.id":"session",duration_ms:"40"})]);
    const filters = { user: "load@example.test" };
    const details = select(logs.buildCodexInsightsLogQuery(from,to,filters,{detailsOnly:true}));
    assert.equal(details.length,3);
    assert.equal(details.filter(row=>Number(row.is_scope)===1).length,1);
    const summary = logs.foldCodexLogSummary(select(logs.buildCodexLogSummaryQuery(from,to,filters)));
    const result = logs.foldCodexInsightsLogs(details,undefined,{summary,deduplicated:true});
    assert.equal(result.coverage.status,"observed"); assert.equal(result.coverage.records,100003);
    assert.equal(result.summary.tokens_per_request,130);
    observed(result.summary,130,false);
    assert.equal(result.summary.cost_per_request,0.00238425);
    assert.equal(result.summary.cost_per_session,0.00238425);
    assert.equal(result.summary.cost_partial,false);
    assert.equal(result.events.find(x=>x.event==='codex.sse_event').count,100002);
    const latency = result.latency.find(x=>x.name==='sse_event');
    assert.equal(latency.count,100002); assert.equal(latency.p50_ms,5); assert.equal(latency.p95_ms,9); assert.equal(latency.max_ms,40);
    assert(Math.abs(latency.average_ms-450060/100002)<1e-12);
    const aggregateRows = select(buildCodexLogAggregateQuery(from, to, filters));
    const aggregated = foldCodexLogAggregates(aggregateRows);
    assert(aggregateRows.length < 20);
    assert.deepEqual(aggregated, result);
  });
  const compact = (filters) => {
    const details = select(logs.buildCodexInsightsLogQuery(from,to,filters,{detailsOnly:true}));
    const summary = logs.foldCodexLogSummary(select(logs.buildCodexLogSummaryQuery(from,to,filters)));
    return { details, result: logs.foldCodexInsightsLogs(details,undefined,{summary,deduplicated:true}) };
  };
  const equivalent = (filters) => {
    const expected = logs.foldCodexInsightsLogs(select(logs.buildCodexInsightsLogQuery(from,to,filters)));
    const actual = compact(filters).result;
    const normalize = (x) => ({ ...x, latency: x.latency.map((row) => ({ ...row,
      average_ms: row.average_ms === null ? null : Number(row.average_ms.toPrecision(14)) })) });
    assert.deepEqual(normalize(actual),normalize(expected));
    const aggregated = foldCodexLogAggregates(select(buildCodexLogAggregateQuery(from, to, filters)));
    assert.deepEqual(normalize(aggregated), normalize(expected));
    return actual;
  };
  await t.test("compaction preserves the raw fold, full identity, missingness and private-field exclusion", () => {
    const r = { "user.email": "oracle@example.test", "service.version": "0.154.0" };
    const first = completion(201, { private_payload: "PRIVATE first" }, r);
    const reordered = { ...first, ResourceAttributes: Object.fromEntries(Object.entries(first.ResourceAttributes).reverse()),
      LogAttributes: Object.fromEntries(Object.entries(first.LogAttributes).reverse()) };
    insert([first,reordered,{...first,LogAttributes:{...first.LogAttributes,private_payload:"PRIVATE second"}},
      request(202,{"error.message":"PRIVATE error"},r),
      make(203,"tool_result",{tool_name:"shell",success:"true",duration_ms:"2.5",tool_parameters:"PRIVATE command"},r),
      make(204,"tool_decision",{tool_name:"shell",decision:"approved",source:"User"},r),
      make(205,"user_prompt",{prompt_length:"12",prompt:"PRIVATE prompt"},r),
      make(206,"startup_phase",{"startup.phase":"init",duration_ms:"1.25"},r),
      make(207,"conversation_starts",{provider_name:"amazon-bedrock",sandbox_policy:'{"type":"workspace-write"}',approval_policy:"on-request"},r),
      make(208,"sse_event",{"event.kind":"response.output_text.delta",duration_ms:"0"},r),
      make(209,"sse_event",{"event.kind":"response.output_text.delta",duration_ms:"-1"},r),
      make(210,"sse_event",{"event.kind":"response.output_text.delta",duration_ms:"bad"},r),
      make(211,"websocket_event",{"event.kind":"response.failed",duration_ms:"4"},r),
      make(212,"sse_event",{"event.kind":"response.completed"},r),
      make(213,"sse_event",{"event.kind":"response.output_text.delta","conversation.id":"stream-only",duration_ms:"8"},r)]);
    const filters={user:"oracle@example.test"};
    const actual=equivalent(filters);
    assert.equal(actual.effort[0].requests,2);
    observed(actual.summary,260,true);
    observed(actual.effort[0],260,false);
    assert(!JSON.stringify(compact(filters).details).includes("PRIVATE"));
    insert([completion(214,{cache_write_token_count:""},r)]);
    const partial=equivalent(filters);
    assert.equal(partial.summary.cost_per_request,0.0047685);
    assert.equal(partial.summary.cost_per_session,0.00238425);
    assert.equal(partial.summary.cost_partial,true);
    assert.equal(partial.summary.tokens_per_request,null);
    observed(partial.summary,390,true);
    assert.equal(partial.effort[0].tokens,null);
    observed(partial.effort[0],390,true);
    assert.equal(partial.effort[0].unpriced,1);
    assert.equal(partial.effort[0].cost_partial,true);
  });
  await t.test("compaction retains known observed tokens beside malformed input and output", () => {
    const r={"user.email":"observed-mixed@example.test"},filters={user:"observed-mixed@"};
    const first=completion(801,{},r);
    insert([first,first,completion(802,{input_token_count:""},r),
      completion(803,{output_token_count:"bad"},r),request(804,{},r),
      make(805,"sse_event",{"event.kind":"response.output_text.delta",input_token_count:"999999"},r)]);
    const result=equivalent(filters);
    observed(result.summary,130,true);
    assert.equal(result.summary.tokens_per_request,null);
    assert.equal(result.summary.cache_hit_rate,null);
    assert.equal(result.summary.cache_write_share,null);
    assert.equal(result.summary.reasoning_share,null);
    assert.equal(result.summary.cost_per_request,0.00238425);
    assert.equal(result.summary.cost_per_session,0.00238425);
    assert.equal(result.effort[0].requests,3);
    assert.equal(result.effort[0].tokens,null);
    observed(result.effort[0],130,true);
    assert.equal(result.effort[0].unpriced,2);
  });
  await t.test("model-less evidence keeps the original user/project session boundary", () => {
    const r={"user.email":"scope-compact@example.test","project.name":"one"};
    insert([make(301,"sse_event",{"event.kind":"response.output_text.delta","conversation.id":"shared",duration_ms:"1"},r),
      make(302,"tool_result",{model:"","conversation.id":"shared",tool_name:"included",success:"true"},r),
      make(303,"tool_result",{model:"","conversation.id":"shared",tool_name:"wrong-project"},{...r,"project.name":"two"}),
      // A differing backend tag alone no longer isolates a model-less row (ADR-017): the tag
      // is not assumed authoritative any more, so this now coarsely attributes like "included".
      make(304,"tool_result",{model:"","conversation.id":"shared",tool_name:"still-included"},{...r,backend:"bedrock-runtime"}),
      make(305,"tool_result",{model:"","conversation.id":"shared",tool_name:"wrong-user"},{...r,"user.email":"other@example.test"})]);
    const actual=equivalent({user:"scope-compact@",model:"gpt-6"});
    assert.deepEqual(actual.tools.map(x=>x.tool).sort(),["included","still-included"]);
    assert.equal(actual.coverage.records,3);
    assert.equal(actual.summary.tokens_per_request,null);
    assert.equal(compact({user:"' OR 1=1"}).result.coverage.records,0);
  });
  await t.test("stream-only and empty windows preserve observations without inventing usage", () => {
    const r={"user.email":"stream-only@example.test"};
    insert([make(401,"sse_event",{"event.kind":"response.output_text.delta",duration_ms:"0"},r),
      make(402,"sse_event",{"event.kind":"response.output_text.delta",duration_ms:"2"},r)]);
    const result=equivalent({user:"stream-only@"});
    assert.equal(result.coverage.records,2); assert.equal(result.summary.tokens_per_request,null);
    assert.equal(result.summary.cost_partial,true);
    observed(result.summary,null,true);
    assert.equal(result.summary.cost_per_request,null); assert.equal(result.summary.cost_per_session,null);
    assert.equal(result.latency[0].p50_ms,0); assert.equal(result.latency[0].p95_ms,2);
    const empty=compact({user:"no-such-user"}).result;
    assert.equal(empty.coverage.status,"empty");
    assert.equal(empty.summary.cost_partial,false);
    observed(empty.summary,null,false);
    assert.equal(empty.summary.cost_per_request,null); assert.equal(empty.summary.cost_per_session,null);
    assert.deepEqual(empty.events,[]);
  });

  // ADR-017's Claude-table fallback must not fire for a model that has ANY Codex-table
  // entry, even one missing rates for this specific scope/tier — that is a scope mismatch
  // (priceCodexUsage's own rule), not a missing model. Codex-table presence, not per-tier
  // completeness, is what gates the fallback. Verify JS and the SQL mirror agree.
  await t.test("a partial Codex-table entry for an Anthropic-looking key blocks its Claude-table fallback", () => {
    const r = { "user.email": "partial-entry@example.test", backend: "bedrock-runtime" };
    // global.anthropic.claude-fable-5-1 normalizes to base_model "anthropic.claude-fable-5-1"
    // (us./global. stripped) and to claude_model "claude-fable-5-1" (full normalizeModelId).
    // The Codex-table entry below matches the first but only has a "regional" scope, while
    // this row's model carries the "global." prefix (scope "global") — a genuine scope gap.
    insert([completion(601, { model: "global.anthropic.claude-fable-5-1" }, r)]);
    const rate = { input: 999, cacheWrite: 999, cacheRead: 999, output: 999 };
    const prices = { "anthropic.claude-fable-5-1": { short_context_limit: 272000,
      regional: { short: rate, long: rate } } };
    const filters = { user: "partial-entry@" };
    const raw = logs.foldCodexInsightsLogs(select(logs.buildCodexInsightsLogQuery(from, to, filters)), prices);
    const aggregated = foldCodexLogAggregates(select(buildCodexLogAggregateQuery(from, to, filters, prices)));
    for (const result of [raw, aggregated]) {
      assert.equal(result.summary.cost_partial, true);
      observed(result.summary, 130, false);
    }
    assert.equal(raw.effort[0].unpriced, 1);
    assert.equal(raw.effort[0].cost_usd, null);
  });

  await t.test("120000 request/completion events retain per-request tiers in bounded aggregates", () => {
    const rates = input => ({ input, cacheRead: 0, cacheWrite: 0, output: 0 });
    const prices = { "test.model": { short_context_limit: 100,
      regional: { short: rates(1), long: rates(2) } } };
    execute(`INSERT INTO claude_code.otel_logs (Timestamp,ResourceAttributes,LogAttributes)
      SELECT toDateTime64('2026-09-15 10:10:00',9)+toIntervalMicrosecond(number),
        map('client','codex','backend','bedrock-mantle','user.email','many-requests@example.test'),
        map('event.name',if(number%2=0,'codex.api_request','codex.sse_event'),
          'event.kind',if(number%2=0,'','response.completed'),
          'conversation.id',concat('session-',toString(intDiv(number,2)%80)), 'model','test.model',
          'input_token_count',toString(100+intDiv(number,2)%3),'output_token_count','1',
          'cached_token_count','0','cache_write_token_count','0','reasoning_token_count','0',
          'model_reasoning_effort','high','attempt','0','http.response.status_code','200')
      FROM numbers(120000)`);
    const rows = select(buildCodexLogAggregateQuery(from, to, { user: "many-requests@" }, prices));
    const result = foldCodexLogAggregates(rows);
    assert(rows.length < 100, `expected compact aggregates, got ${rows.length}`);
    assert.equal(result.coverage.records, 120000);
    assert.equal(result.coverage.status, "observed");
    observed(result.summary, 6120000, false);
    assert.equal(result.effort[0].requests, 60000);
    assert.equal(result.effort[0].cost_usd, 10.12);
    assert.equal(result.summary.tokens_per_request, 102);
    assert.equal(result.summary.cost_per_request, 10.12 / 60000);
    assert.equal(result.summary.cost_per_session, 10.12 / 80);
  });

  await t.test("combined dimension overflow retains whole-window totals within the transfer budget", () => {
    execute(`INSERT INTO claude_code.otel_logs (Timestamp,ResourceAttributes,LogAttributes)
      SELECT Timestamp,mapUpdate(ResourceAttributes,map('user.email','budget@example.test')),
        mapUpdate(LogAttributes,map(
          'conversation.id',concat('session-',toString(intDiv(toUnixTimestamp64Micro(Timestamp),2))),
          'model_reasoning_effort',concat('effort-',toString(intDiv(toUnixTimestamp64Micro(Timestamp),2)%6000))))
      FROM claude_code.otel_logs WHERE ResourceAttributes['user.email']='many-requests@example.test'`);
    const rates = input => ({ input, cacheRead: 0, cacheWrite: 0, output: 0 });
    const prices = { "test.model": { short_context_limit: 100,
      regional: { short: rates(1), long: rates(2) } } };
    const rows = select(buildCodexLogAggregateQuery(from, to, { user: "budget@" }, prices));
    const result = foldCodexLogAggregates(rows);
    assert(rows.length < 10, `over-budget families should return only markers, got ${rows.length} rows`);
    assert.equal(result.coverage.records, 120000);
    assert.deepEqual(result.coverage.limited_sections, ["effort", "scope"]);
    observed(result.summary, 6120000, true);
    assert.equal(result.summary.cost_per_request, 10.12 / 60000);
    assert.equal(result.summary.cost_per_session, null);
    assert.equal(result.summary.cost_partial, true);
    assert.deepEqual(result.effort, []);
  });

  await t.test("rejection scopes, normalized runtime settings, and unknown labels retain the raw contract", () => {
    const r = { "user.email": "rejections-aggregate@example.test" };
    const setup = (n, policy) => make(n, "conversation_starts", { sandbox_policy: policy,
      approval_policy: '{"reject":{"sandbox_approval":true}}', model: "/private/model" }, r);
    insert([request(901, { "http.response.status_code": "400" }, r),
      setup(902, '{"type":"workspace-write"}'), setup(903, '"workspace-write"'),
      setup(904, '{"workspace-write":{}}'), setup(905, '{"type":true,"name":"workspace-write"}'),
      make(906, "user_prompt", { prompt_length: "0" }, r)]);
    equivalent({ user: "rejections-aggregate@" });
    insert([make(907, "sse_event", { "event.kind": "response.output_text.delta", model: "" }, r)]);
    equivalent({ user: "rejections-aggregate@" });
    insert([completion(908, {}, r), make(909, "tool_result",
      { model: "", tool_name: "/private/path", success: "false", duration_ms: "0" }, r)]);
    equivalent({ user: "rejections-aggregate@" });
  });

  await t.test("numeric encodings, incomplete subsets, and anonymous scopes preserve partial observations", () => {
    const r = { "user.email": "numeric-aggregate@example.test" };
    const inputs = ["1e2", "0x64", "0b1100100", "0o144", "0x20000000000000", "NaN", "Infinity", "", "-1", "100.5"];
    insert(inputs.map((input, n) => completion(1001 + n, { input_token_count: input }, r)));
    insert([request(1101, {}, r), completion(1102, { input_token_count: "0", output_token_count: "0",
      cached_token_count: "0", cache_write_token_count: "0", reasoning_token_count: "0" }, r),
      completion(1103, { cached_token_count: "101" }, r),
      completion(1104, { reasoning_token_count: "31" }, r),
      completion(1105, { model: "global.openai.gpt-6-astra" }, r),
      completion(1106, { "conversation.id": "" }, r),
      request(1107, { "conversation.id": "" }, r),
      make(1108, "user_prompt", { prompt_length: "10.5" }, r),
      make(1109, "user_prompt", { prompt_length: "9007199254740992" }, r)]);
    equivalent({ user: "numeric-aggregate@" });
  });

  await t.test("a summary-ahead completion cannot price a session absent from the detail snapshot", () => {
    const r={"user.email":"ahead@example.test"},filters={user:"ahead@"};
    insert([completion(501,{},r),request(502,{},r),
      make(503,"sse_event",{"event.kind":"response.output_text.delta","conversation.id":"late",duration_ms:"1"},r)]);
    const details=select(logs.buildCodexInsightsLogQuery(from,to,filters,{detailsOnly:true}));
    const before=logs.foldCodexInsightsLogs(select(logs.buildCodexInsightsLogQuery(from,to,filters)));
    insert([completion(504,{"conversation.id":"late",cache_write_token_count:""},r)]);
    const summary=logs.foldCodexLogSummary(select(logs.buildCodexLogSummaryQuery(from,to,filters)));
    const after=logs.foldCodexInsightsLogs(select(logs.buildCodexInsightsLogQuery(from,to,filters)));
    const mixed=logs.foldCodexInsightsLogs(details,undefined,{summary,deduplicated:true});
    for(const result of [before,after,mixed]){
      assert.equal(result.summary.tokens_per_request,null);
      assert.equal(result.summary.tokens_partial,true);
      assert.equal(result.summary.cost_partial,true);
      assert.equal(result.summary.cost_per_request,0.00238425);
      assert.equal(result.summary.cost_per_session,0.001192125);
    }
    assert.equal(before.summary.observed_tokens,130);
    assert.equal(mixed.summary.observed_tokens,130);
    assert.equal(after.summary.observed_tokens,260);
    observed(mixed.effort[0],130,false);
    observed(after.effort[0],260,true);
    for(const field of ["cost_per_request","cost_per_session"]){
      assert.equal(mixed.summary[field],before.summary[field]);
    }
    assert.equal(before.coverage.records,3); assert.equal(mixed.coverage.records,4);
    assert.equal(mixed.effort[0].requests,1); assert.equal(mixed.effort[0].unpriced,0);
    assert.equal(after.effort[0].requests,2); assert.equal(after.effort[0].unpriced,1);
    assert(!JSON.stringify(mixed).includes("ahead@example.test"));
  });
  await t.test("detail-ahead subtotals stay partial until every stream scope has usage", () => {
    const r={"user.email":"behind@example.test"},filters={user:"behind@"};
    insert([completion(601,{},r),request(602,{},r),
      make(603,"sse_event",{"event.kind":"response.output_text.delta","conversation.id":"late",duration_ms:"1"},r),
      make(604,"sse_event",{"event.kind":"response.output_text.delta","conversation.id":"last",duration_ms:"1"},r)]);
    const summary=logs.foldCodexLogSummary(select(logs.buildCodexLogSummaryQuery(from,to,filters)));
    insert([completion(605,{"conversation.id":"late"},r),request(606,{"conversation.id":"late"},r)]);
    const details=select(logs.buildCodexInsightsLogQuery(from,to,filters,{detailsOnly:true}));
    const expected=logs.foldCodexInsightsLogs(select(logs.buildCodexInsightsLogQuery(from,to,filters)));
    const actual=logs.foldCodexInsightsLogs(details,undefined,{summary,deduplicated:true});
    assert.equal(actual.summary.cost_partial,true);
    assert.equal(actual.summary.tokens_per_request,null);
    observed(actual.summary,260,true);
    observed(actual.effort[0],260,false);
    assert.equal(actual.summary.cost_per_session,0.0015895);
    assert.equal(actual.summary.cost_per_request,0.00238425);
    assert.equal(actual.summary.cost_per_session,expected.summary.cost_per_session);
    assert.equal(actual.summary.cost_per_request,expected.summary.cost_per_request);
    assert.equal(actual.summary.tokens_per_request,expected.summary.tokens_per_request);
    assert.equal(actual.coverage.records,4); assert.equal(expected.coverage.records,6);
    // Retain the completeness proof: detail usage can close every scope even
    // when the separate summary still predates those completions and attempts.
    insert([completion(607,{"conversation.id":"last"},r),request(608,{"conversation.id":"last"},r)]);
    const complete=logs.foldCodexInsightsLogs(
      select(logs.buildCodexInsightsLogQuery(from,to,filters,{detailsOnly:true})),undefined,{summary,deduplicated:true});
    assert.equal(complete.summary.cost_partial,false);
    assert.equal(complete.summary.tokens_per_request,130);
    observed(complete.summary,390,false);
    assert.equal(complete.summary.cost_per_session,0.00238425);
    assert.equal(complete.summary.cost_per_request,0.00238425);
    assert.equal(complete.coverage.records,4);
  });

  await t.test("a detail-ahead batch cannot hide a new stream-only session from completeness", () => {
    const r={"user.email":"new-session-race@example.test"},filters={user:"new-session-race@"};
    insert([completion(701,{},r),request(702,{},r),
      make(703,"sse_event",{"event.kind":"response.output_text.delta","conversation.id":"second",duration_ms:"1"},r)]);
    const before=logs.foldCodexInsightsLogs(select(logs.buildCodexInsightsLogQuery(from,to,filters)));
    const summary=logs.foldCodexLogSummary(select(logs.buildCodexLogSummaryQuery(from,to,filters)));
    insert([completion(704,{"conversation.id":"second"},r),request(705,{"conversation.id":"second"},r),
      make(706,"sse_event",{"event.kind":"response.output_text.delta","conversation.id":"third",duration_ms:"1"},r)]);
    const details=select(logs.buildCodexInsightsLogQuery(from,to,filters,{detailsOnly:true}));
    const after=logs.foldCodexInsightsLogs(select(logs.buildCodexInsightsLogQuery(from,to,filters)));
    const actual=logs.foldCodexInsightsLogs(details,undefined,{summary,deduplicated:true});
    for(const result of [before,after,actual]){
      assert.equal(result.summary.tokens_per_request,null);
      assert.equal(result.summary.tokens_partial,true);
      assert.equal(result.summary.cost_partial,true);
    }
    assert.equal(before.summary.observed_tokens,130);
    assert.equal(actual.summary.observed_tokens,260);
    assert.equal(after.summary.observed_tokens,260);
    assert.equal(before.summary.cost_per_session,0.001192125);
    assert.equal(actual.summary.cost_per_session,0.0015895);
    assert.equal(actual.summary.cost_per_request,0.00238425);
    for(const field of ["cost_per_request","cost_per_session"]){
      assert.equal(actual.summary[field],after.summary[field]);
    }
    assert.equal(actual.coverage.records,3); assert.equal(after.coverage.records,6);
  });

});
