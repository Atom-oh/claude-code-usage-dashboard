import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { buildCodexLogAggregateQuery, foldCodexLogAggregates } from "./codexLogAggregates.js";
import { foldCodexInsightsLogs } from "./codexInsightsLogs.js";
import { DEFAULT_CODEX_PRICING, codexModel, priceCodexUsage } from "./codexPricing.js";
import { resolveBackend, VALID_BACKENDS } from "./backend.js";
import { resolvedRatesTable } from "./pricing.js";

// Opt in with CODEX_PRICING_SQL_TEST=1. Synthetic events and production SELECTs
// use only a networkless disposable ClickHouse, never CH_URL or AWS credentials.
test("Codex log pricing matches JavaScript across batched rate selections", {
  skip: process.env.CODEX_PRICING_SQL_TEST !== "1", timeout: 120000,
}, async (t) => {
  const name = `ccdash-log-pricing-${process.pid}`;
  const directory = mkdtempSync(join(tmpdir(), "codex-log-pricing-"));
  function docker(args, input) {
    const result = spawnSync("docker", args, {
      input, encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(result.error?.message || result.stderr || result.stdout);
    return result.stdout.trim();
  }
  const execute = (sql, params = {}) => docker(["exec", "-i", name, "clickhouse-client", "--multiquery",
    ...Object.entries(params).map(([key, value]) => `--param_${key}=${value}`)], sql);
  const from = new Date("2026-09-15T10:00:00Z"), to = new Date("2026-09-15T11:00:00Z");
  const select = request => {
    const output = execute(`${request.sql} FORMAT JSONEachRow`, request.params);
    return output ? output.split("\n").map(JSON.parse) : [];
  };
  t.after(() => {
    try { docker(["rm", "-f", name]); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  writeFileSync(join(directory, "test.xml"), `<clickhouse>
    <background_schedule_pool_size>16</background_schedule_pool_size>
    <background_buffer_flush_schedule_pool_size>4</background_buffer_flush_schedule_pool_size>
    <background_message_broker_schedule_pool_size>4</background_message_broker_schedule_pool_size>
    <background_distributed_schedule_pool_size>4</background_distributed_schedule_pool_size>
    <max_server_memory_usage>1500000000</max_server_memory_usage>
  </clickhouse>`);
  docker(["run", "-d", "--name", name, "--network", "none", "--memory", "2g", "--cpus", "2",
    "--tmpfs", "/var/lib/clickhouse:rw,size=1g", "--tmpfs", "/var/log/clickhouse-server:rw,size=128m",
    "-v", `${join(directory, "test.xml")}:/etc/clickhouse-server/config.d/test.xml:ro`,
    "clickhouse/clickhouse-server:24.8"]);
  let startup;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { execute("SELECT 1"); startup = null; break; }
    catch (error) { startup = error; await setTimeout(250); }
  }
  if (startup) throw startup;
  const schema = readFileSync(new URL("../../clickhouse-schema.sql", import.meta.url), "utf8");
  execute("CREATE DATABASE claude_code");
  execute(schema.match(/CREATE TABLE IF NOT EXISTS claude_code\.otel_logs\s*\([\s\S]*?;/)[0]);

  function batch(user) {
    const cases = [];
    const add = (description, model, backend, input = 100, patch = {}, literalCost) => {
      const effort = `case-${String(cases.length).padStart(4, "0")}`;
      const row = {
        Timestamp: `2026-09-15 10:00:00.${String(cases.length).padStart(9, "0")}`,
        ResourceAttributes: { client: "codex", "user.email": user, backend },
        LogAttributes: {
          "event.name": "codex.sse_event", "event.kind": "response.completed",
          "conversation.id": effort, model, model_reasoning_effort: effort,
          input_token_count: String(input), cached_token_count: "40", cache_write_token_count: "11",
          output_token_count: "30", reasoning_token_count: "10", ...patch,
        },
      };
      cases.push({ description, effort, row, literalCost });
    };
    return { cases, add };
  }
  function assertBatch(user, cases, prices) {
    execute(`INSERT INTO claude_code.otel_logs FORMAT JSONEachRow\n${cases.map(value => JSON.stringify(value.row)).join("\n")}`);
    const sql = foldCodexLogAggregates(select(buildCodexLogAggregateQuery(from, to, { user }, prices,
      { profile: "effort", diagnosticSource: "raw" })));
    const jsRows = cases.map(({ row }) => ({
      timestamp: row.Timestamp, resource: row.ResourceAttributes, attributes: row.LogAttributes,
    }));
    const js = foldCodexInsightsLogs(jsRows, prices);
    const expected = new Map(js.effort.map(row => [row.effort, row]));
    const actual = new Map(sql.effort.map(row => [row.effort, row]));
    assert.equal(sql.coverage.records, cases.length);
    assert.equal(actual.size, cases.length);
    for (const { description, effort, row, literalCost } of cases) {
      const a = row.LogAttributes;
      const input = Number(a.input_token_count);
      const direct = priceCodexUsage({
        model: a.model, backend: resolveBackend(a.model, row.ResourceAttributes.backend),
        context_tier: input > (prices[codexModel(a.model)]?.short_context_limit ?? 0) ? "long" : "short",
        input_tokens_total: a.input_token_count, cache_read_tokens: a.cached_token_count,
        cache_write_tokens: a.cache_write_token_count, output_tokens: a.output_token_count,
        reasoning_tokens: a.reasoning_token_count,
      }, prices);
      const actualRow = actual.get(effort), expectedRow = expected.get(effort);
      assert.ok(actualRow, description);
      for (const field of ["requests", "tokens", "observed_tokens", "tokens_partial",
        "cost_usd", "cost_partial", "unpriced"])
        assert.equal(actualRow[field], expectedRow[field], `${description}: ${field}`);
      assert.equal(actualRow.cost_usd, direct.cost_usd, `${description}: direct pricing`);
      assert.equal(actualRow.unpriced, Number(direct.unpriced), `${description}: direct availability`);
      if (literalCost !== undefined) {
        assert.equal(direct.cost_usd, literalCost, `${description}: hand-computed cost`);
        assert.equal(actualRow.cost_usd, literalCost, `${description}: SQL hand-computed cost`);
      }
    }
  }

  await t.test("every default model, tier, scope and backend tag selects the JavaScript rate", () => {
    const user = "default-pricing@example.test";
    const { cases, add } = batch(user);
    for (const [model, entry] of Object.entries(DEFAULT_CODEX_PRICING)) {
      for (const backend of VALID_BACKENDS) for (const scope of ["regional", "global"]) {
        // Routing prefixes determine runtime even with a stale mantle tag.
        const routed = scope === "global" ? `global.${model}`
          : backend === "bedrock-runtime" ? `us.${model}` : model;
        for (const [tier, input] of [["short", entry.short_context_limit], ["long", entry.short_context_limit + 1]])
          add(`${model}/${scope}/${tier}/${backend}`, routed, backend, input);
      }
    }
    for (const model of Object.keys(resolvedRatesTable())) {
      if (Object.hasOwn(DEFAULT_CODEX_PRICING, `anthropic.${model}`)) continue;
      for (const backend of VALID_BACKENDS) for (const prefix of ["", "us.anthropic.", "global.anthropic."])
        add(`Claude fallback ${prefix}${model}/${backend}`, `${prefix}${model}`, backend);
    }
    assertBatch(user, cases, DEFAULT_CODEX_PRICING);
  });

  await t.test("backend override priority, missing rates and malformed usage retain availability", () => {
    const user = "custom-pricing@example.test";
    const { cases, add } = batch(user);
    const rates = scale => ({ input: 2 * scale, cacheRead: scale, cacheWrite: 3 * scale, output: 4 * scale });
    const prices = {
      ...DEFAULT_CODEX_PRICING,
      "fixture-override": {
        short_context_limit: 100,
        regional: { short: rates(1), long: rates(2) },
        global: { short: rates(3), long: rates(4) },
        backends: {
          "bedrock-mantle": { regional: { short: rates(10), long: rates(20) } },
          "bedrock-runtime": { global: { short: rates(300), long: rates(400) } },
        },
      },
      "fixture-free": { short_context_limit: 100, regional: { short: rates(0), long: rates(0) } },
      "fixture-missing": { short_context_limit: 100, regional: { short: rates(1) } },
      "fixture-overflow": { short_context_limit: 100,
        regional: { short: rates(Number.MAX_VALUE / 4), long: rates(Number.MAX_VALUE / 4) } },
      // Its existence must block the otherwise available flat Claude fallback.
      "anthropic.claude-fable-5-1": { short_context_limit: 100, regional: { short: rates(1) } },
    };
    add("mantle override at threshold", "fixture-override", "bedrock-mantle", 100, {}, 0.00291);
    add("mantle override above threshold", "fixture-override", "bedrock-mantle", 101, {}, 0.00586);
    add("runtime falls back to base regional short", "fixture-override", "bedrock-runtime", 100, {}, 0.000291);
    add("runtime falls back to base regional long", "fixture-override", "bedrock-runtime", 101, {}, 0.000586);
    add("runtime global override short", "global.fixture-override", "bedrock-runtime", 100, {}, 0.0873);
    add("runtime global override long", "global.fixture-override", "bedrock-runtime", 101, {}, 0.1172);
    add("routing corrects stale backend", "global.fixture-override", "bedrock-mantle", 100, {}, 0.0873);
    add("all-zero rates remain priced", "fixture-free", "bedrock-mantle", 100, {}, 0);
    add("missing global rates", "global.fixture-free", "bedrock-runtime", 100, {}, null);
    add("missing long tier", "fixture-missing", "bedrock-mantle", 101, {}, null);
    add("Codex entry blocks global Claude fallback", "global.anthropic.claude-fable-5-1", "bedrock-runtime", 100, {}, null);
    add("Codex entry blocks long Claude fallback", "anthropic.claude-fable-5-1", "bedrock-mantle", 101, {}, null);
    add("unknown model", "fixture-unknown", "bedrock-runtime", 100, {}, null);
    add("unknown backend", "fixture-override", "unknown", 100, {}, null);
    add("GovCloud remains unavailable", "us-gov.openai.gpt-6-astra", "bedrock-runtime", 100, {}, null);
    add("non-finite price remains unavailable", "fixture-overflow", "bedrock-mantle", 100, {}, null);
    add("known zero usage", "fixture-override", "bedrock-mantle", 0,
      { cached_token_count: "0", cache_write_token_count: "0", output_token_count: "0", reasoning_token_count: "0" }, 0);
    add("hex token encodings", "fixture-override", "bedrock-mantle", "0x64",
      { cached_token_count: "0x28", cache_write_token_count: "0xb", output_token_count: "0x1e", reasoning_token_count: "0xa" }, 0.00291);
    for (const [description, patch] of [
      ["missing input", { input_token_count: undefined }],
      ["missing cache read", { cached_token_count: undefined }],
      ["missing cache write", { cache_write_token_count: undefined }],
      ["missing output", { output_token_count: undefined }],
      ["missing reasoning", { reasoning_token_count: undefined }],
      ["invalid cache subsets", { cached_token_count: "70", cache_write_token_count: "40" }],
      ["invalid reasoning subset", { reasoning_token_count: "31" }],
      ["negative input", { input_token_count: "-1" }],
      ["fractional input", { input_token_count: "100.5" }],
      ["unsafe input", { input_token_count: "9007199254740992" }],
      ["NaN input", { input_token_count: "NaN" }],
      ["infinite output", { output_token_count: "Infinity" }],
      ["empty input", { input_token_count: "" }],
    ]) add(description, "fixture-override", "bedrock-mantle", 100, patch, null);
    assertBatch(user, cases, prices);
  });
});
