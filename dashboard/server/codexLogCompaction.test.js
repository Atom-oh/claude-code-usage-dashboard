import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import * as logs from "./codexInsightsLogs.js";

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
    assert.equal(details.length,2);
    const summary = logs.foldCodexLogSummary(select(logs.buildCodexLogSummaryQuery(from,to,filters)));
    const result = logs.foldCodexInsightsLogs(details,undefined,{summary,deduplicated:true});
    assert.equal(result.coverage.status,"observed"); assert.equal(result.coverage.records,100003);
    assert.equal(result.summary.tokens_per_request,130);
    assert.equal(result.summary.cost_per_request,0.00238425);
    assert.equal(result.summary.cost_per_session,0.00238425);
    assert.equal(result.events.find(x=>x.event==='codex.sse_event').count,100002);
    const latency = result.latency.find(x=>x.name==='sse_event');
    assert.equal(latency.count,100002); assert.equal(latency.p50_ms,5); assert.equal(latency.p95_ms,9); assert.equal(latency.max_ms,40);
    assert(Math.abs(latency.average_ms-450060/100002)<1e-12);
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
    assert(!JSON.stringify(compact(filters).details).includes("PRIVATE"));
    insert([completion(214,{cache_write_token_count:""},r)]);
    assert.equal(equivalent(filters).summary.cost_per_request,null);
  });
  await t.test("model-less evidence keeps the original user/project/backend session boundary", () => {
    const r={"user.email":"scope-compact@example.test","project.name":"one"};
    insert([make(301,"sse_event",{"event.kind":"response.output_text.delta","conversation.id":"shared",duration_ms:"1"},r),
      make(302,"tool_result",{model:"","conversation.id":"shared",tool_name:"included",success:"true"},r),
      make(303,"tool_result",{model:"","conversation.id":"shared",tool_name:"wrong-project"},{...r,"project.name":"two"}),
      make(304,"tool_result",{model:"","conversation.id":"shared",tool_name:"wrong-backend"},{...r,backend:"bedrock-runtime"}),
      make(305,"tool_result",{model:"","conversation.id":"shared",tool_name:"wrong-user"},{...r,"user.email":"other@example.test"})]);
    const actual=equivalent({user:"scope-compact@",model:"gpt-6"});
    assert.deepEqual(actual.tools.map(x=>x.tool),["included"]);
    assert.equal(actual.coverage.records,2);
    assert.equal(actual.summary.tokens_per_request,null);
    assert.equal(compact({user:"' OR 1=1"}).result.coverage.records,0);
  });
  await t.test("stream-only and empty windows preserve observations without inventing usage", () => {
    const r={"user.email":"stream-only@example.test"};
    insert([make(401,"sse_event",{"event.kind":"response.output_text.delta",duration_ms:"0"},r),
      make(402,"sse_event",{"event.kind":"response.output_text.delta",duration_ms:"2"},r)]);
    const result=equivalent({user:"stream-only@"});
    assert.equal(result.coverage.records,2); assert.equal(result.summary.tokens_per_request,null);
    assert.equal(result.latency[0].p50_ms,0); assert.equal(result.latency[0].p95_ms,2);
    assert.equal(compact({user:"no-such-user"}).result.coverage.status,"empty");
    assert.deepEqual(compact({user:"no-such-user"}).result.events,[]);
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
    for(const field of ["tokens_per_request","cost_per_request","cost_per_session"]){
      assert.equal(before.summary[field],null);assert.equal(after.summary[field],null);assert.equal(mixed.summary[field],null);
    }
    assert(!JSON.stringify(mixed).includes("ahead@example.test"));
  });
  await t.test("detail-ahead usage satisfies the stream scopes without trusting stale summary counts", () => {
    const r={"user.email":"behind@example.test"},filters={user:"behind@"};
    insert([completion(601,{},r),request(602,{},r),
      make(603,"sse_event",{"event.kind":"response.output_text.delta","conversation.id":"late",duration_ms:"1"},r)]);
    const summary=logs.foldCodexLogSummary(select(logs.buildCodexLogSummaryQuery(from,to,filters)));
    insert([completion(604,{"conversation.id":"late"},r),request(605,{"conversation.id":"late"},r)]);
    const details=select(logs.buildCodexInsightsLogQuery(from,to,filters,{detailsOnly:true}));
    const expected=logs.foldCodexInsightsLogs(select(logs.buildCodexInsightsLogQuery(from,to,filters)));
    const actual=logs.foldCodexInsightsLogs(details,undefined,{summary,deduplicated:true});
    assert.equal(actual.summary.cost_per_session,expected.summary.cost_per_session);
    assert.equal(actual.summary.cost_per_request,expected.summary.cost_per_request);
    assert.equal(actual.summary.tokens_per_request,expected.summary.tokens_per_request);
  });

});
