import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { buildCodexLogAggregateQuery, foldCodexLogAggregates } from "./codexLogAggregates.js";
import { diagnosticSchemaSql } from "./codexDiagnosticSchema.js";

function observed(value, tokens, partial) {
  assert.equal(value.observed_tokens, tokens);
  assert.equal(value.tokens_partial, partial);
}

// Opt in with CODEX_EFFORT_SQL_TEST=1. All SQL uses a networkless disposable
// ClickHouse container; no production CH_URL or credentials are consumed.
test("Codex Effort hybrid SQL against isolated ClickHouse", {
  skip: process.env.CODEX_EFFORT_SQL_TEST !== "1", timeout: 120000,
}, async (t) => {
  const name = `ccdash-effort-sql-${process.pid}`;
  const directory = mkdtempSync(join(tmpdir(), "codex-effort-sql-"));
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
  const resource = { client: "codex", backend: "bedrock-mantle", "user.email": "fixture@example.test" };
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
  execute(diagnosticSchemaSql());

  const equivalentEffort = (filters, rangeFrom = from, rangeTo = to) => {
    const raw = foldCodexLogAggregates(select(buildCodexLogAggregateQuery(rangeFrom, rangeTo,
      filters, undefined, { profile: "effort", diagnosticSource: "raw" })));
    const hybrid = foldCodexLogAggregates(select(buildCodexLogAggregateQuery(rangeFrom, rangeTo,
      filters, undefined, { profile: "effort", diagnosticSource: "states" })));
    assert.deepEqual(hybrid, raw);
    return hybrid;
  };

  await t.test("hybrid Effort retains full bulk identities and exact non-bulk evidence", () => {
    const r = { "user.email": "hybrid-identities@example.test", "project.name": "one" };
    const bulk = make(2001, "sse_event", { "event.kind": "response.output_text.delta",
      duration_ms: "1", private_payload: "PRIVATE first" }, r);
    const reordered = { ...bulk,
      ResourceAttributes: Object.fromEntries(Object.entries(bulk.ResourceAttributes).reverse()),
      LogAttributes: Object.fromEntries(Object.entries(bulk.LogAttributes).reverse()) };
    const hex = completion(2003, { input_token_count: "0x64", cached_token_count: "0x28",
      cache_write_token_count: "0xb", output_token_count: "0x1e", reasoning_token_count: "0xa" }, r);
    insert([bulk, reordered,
      { ...bulk, LogAttributes: { ...bulk.LogAttributes, private_payload: "PRIVATE second" } },
      { ...bulk, ResourceAttributes: { ...bulk.ResourceAttributes, private_resource: "PRIVATE third" } },
      make(2002, "websocket_event", { "event.kind": "response.output_text.delta" }, r),
      hex, hex, request(2004, {}, r),
      make(2005, "tool_decision", { tool_name: "shell", decision: "approved", source: "user" }, r),
      make(2006, "tool_decision", { tool_name: "shell", decision: "denied", source: "user" }, r),
      make(2007, "user_prompt", { prompt_length: "12" }, r),
      make(2008, "user_prompt", { prompt_length: "0x10" }, r),
      make(2009, "websocket_event", { "event.kind": "response.failed" }, r),
      completion(2010, { "conversation.id": "" }, r),
      request(2010, { "conversation.id": "" }, r),
      request(2011, { "conversation.id": "" }, r)]);
    // A second insertion block must merge the same identity before finalization.
    insert([bulk]);
    const result = equivalentEffort({ user: "hybrid-identities@" });
    assert.equal(result.coverage.records, 14);
    assert.equal(result.events.find(row => row.event === "codex.sse_event").count, 5);
    assert.equal(result.summary.prompts, 2);
    assert.equal(result.summary.prompt_length_mean, 14);
    assert.equal(result.summary.approval_rate, 0.5);
    assert.equal(result.summary.retry_rate, 0);
    assert.equal(result.summary.api_error_rate, 1 / 3);
    assert.equal(result.completeness.missing_session, true);
    assert.equal(result.completeness.missing_usage, true);
    assert.equal(result.summary.cost_per_session, null);
    observed(result.summary, 260, true);
    assert.equal(result.effort[0].requests, 2);
    assert.equal(result.effort[0].tokens, 260);
    assert.equal(result.effort[0].cache_hit_rate, 0.4);
  });

  await t.test("hybrid Effort preserves half-open second boundaries and subsecond identities", () => {
    const r = { "user.email": "hybrid-boundaries@example.test" };
    const bulkAt = timestamp => ({ ...make(2100, "sse_event",
      { "event.kind": "response.output_text.delta" }, r), Timestamp: timestamp });
    insert([
      bulkAt("2026-09-15 10:00:14.999999999"),
      bulkAt("2026-09-15 10:00:15.000000000"),
      bulkAt("2026-09-15 10:00:15.000000001"),
      bulkAt("2026-09-15 10:00:15.999999999"),
      bulkAt("2026-09-15 10:00:16.000000000"),
      bulkAt("2026-09-15 10:00:16.000000001"),
      bulkAt("2026-09-15 10:00:17.000000000"),
      { ...completion(2101, {}, r), Timestamp: "2026-09-15 10:00:15.900000000" },
      { ...request(2102, {}, r), Timestamp: "2026-09-15 10:00:16.500000000" },
    ]);
    for (const [start, end, count, lastSeen] of [
      ["2026-09-15T10:00:15Z", "2026-09-15T10:00:16Z", 4, "2026-09-15T10:00:15.999Z"],
      ["2026-09-15T10:00:16Z", "2026-09-15T10:00:17Z", 3, "2026-09-15T10:00:16.500Z"],
      ["2026-09-15T10:00:15.987Z", "2026-09-15T10:00:16.456Z", 4, "2026-09-15T10:00:15.999Z"],
    ]) {
      const result = equivalentEffort({ user: "hybrid-boundaries@" }, new Date(start), new Date(end));
      assert.equal(result.coverage.records, count);
      assert.equal(result.coverage.last_seen, lastSeen);
    }
  });

  await t.test("hybrid Effort keeps rejection, setup and stream-only scope distinctions", () => {
    const rejected = { "user.email": "hybrid-rejected@example.test" };
    const setup = { "user.email": "hybrid-setup@example.test" };
    const missing = { "user.email": "hybrid-missing@example.test" };
    insert([
      request(2201, { "http.response.status_code": "400" }, rejected),
      make(2202, "conversation_starts", {}, rejected),
      make(2203, "conversation_starts", {}, setup),
      make(2204, "user_prompt", { prompt_length: "9" }, setup),
      make(2205, "sse_event", { "event.kind": "response.output_text.delta" }, missing),
      make(2206, "websocket_event", { "event.kind": "response.output_text.delta",
        "conversation.id": "" }, missing),
    ]);
    const rejection = equivalentEffort({ user: "hybrid-rejected@" });
    assert.equal(rejection.coverage.records, 2);
    assert.equal(rejection.completeness.missing_usage, false);
    assert.equal(rejection.summary.rejected_requests, 1);
    assert.equal(rejection.summary.cost_per_request, 0);
    observed(rejection.summary, 0, false);
    const setupOnly = equivalentEffort({ user: "hybrid-setup@" });
    assert.equal(setupOnly.completeness.missing_usage, true);
    assert.equal(setupOnly.summary.prompts, 1);
    assert.equal(setupOnly.summary.prompt_length_mean, 9);
    assert.equal(setupOnly.summary.cost_per_request, null);
    const streamOnly = equivalentEffort({ user: "hybrid-missing@" });
    assert.equal(streamOnly.coverage.records, 2);
    assert.equal(streamOnly.completeness.missing_usage, true);
    assert.equal(streamOnly.completeness.missing_session, false);
    observed(streamOnly.summary, null, true);
  });

  await t.test("hybrid Effort resolves model-less rows from bulk evidence before backend filtering", () => {
    const r = { "user.email": "hybrid-model-only@example.test", "project.name": "one" };
    const runtime = { ...r, backend: "bedrock-runtime" };
    insert([
      make(2301, "sse_event", { "event.kind": "response.output_text.delta",
        "conversation.id": "shared" }, r),
      make(2302, "websocket_event", { "event.kind": "response.output_text.delta",
        "conversation.id": "shared" }, r),
      completion(2303, { model: "", "conversation.id": "shared" }, runtime),
      request(2304, { model: "", "conversation.id": "shared" }, runtime),
      make(2305, "tool_result", { model: "", "conversation.id": "shared",
        tool_name: "included", success: "true" }, runtime),
      make(2306, "startup_phase", { model: "", "conversation.id": "shared" }, runtime),
      make(2307, "tool_result", { model: "", "conversation.id": "shared",
        tool_name: "wrong-project" }, { ...runtime, "project.name": "two" }),
      make(2308, "tool_result", { model: "", "conversation.id": "shared",
        tool_name: "wrong-user" }, { ...runtime, "user.email": "other@example.test" }),
    ]);
    const result = equivalentEffort({ user: "hybrid-model-only@", model: "gpt-6",
      backend: "bedrock-runtime" });
    assert.equal(result.coverage.records, 4);
    assert.equal(result.events.some(row => row.event === "codex.sse_event"), true);
    assert.equal(result.events.some(row => row.event === "codex.websocket_event"), false);
    assert.equal(result.completeness.missing_usage, false);
    observed(result.summary, 130, false);
    assert.equal(result.effort[0].requests, 1);
    assert.equal(equivalentEffort({ user: "hybrid-model-only@", model: "gpt-6" }).coverage.records, 6);
    assert.equal(equivalentEffort({ user: "hybrid-model-only@", model: "no-such-model" }).coverage.records, 0);
  });

});
