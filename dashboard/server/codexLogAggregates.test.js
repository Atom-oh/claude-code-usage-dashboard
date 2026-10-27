import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodexLogAggregateQuery } from "./codexLogAggregates.js";
import { DEFAULT_CODEX_PRICING } from "./codexPricing.js";

// ClickHouse query parameters are sent in the request URL; servers and proxies cap the header
// block near 16 KiB. The price table must not eat that budget as models are added.
const urlBytes = (params) => Object.entries(params)
  .reduce((n, [k, v]) => n + `param_${k}=${encodeURIComponent(String(v))}&`.length, 0);

test("aggregate query parameters stay far below the URL header limit with the default price table", () => {
  const { params } = buildCodexLogAggregateQuery(new Date("2026-09-14T00:00:00Z"), new Date("2026-09-15T00:00:00Z"));
  assert.ok(urlBytes(params) < 8192, `query parameters take ${urlBytes(params)} URL bytes`);
});

test("identical rates share one query parameter regardless of how many models use them", () => {
  const from = new Date("2026-09-14T00:00:00Z"), to = new Date("2026-09-15T00:00:00Z");
  const flat = { input: 0.62, cacheWrite: 0.62, cacheRead: 0.62, output: 1.85 };
  const entry = (limit) => ({ short_context_limit: limit, regional: { short: flat, long: flat } });
  const prices = { "a.model": entry(1000), "b.model": entry(2000), "c.model": entry(3000) };
  const { params, sql } = buildCodexLogAggregateQuery(from, to, {}, prices);
  const rateNames = Object.keys(params).filter((k) => k.startsWith("rate"));
  assert.deepEqual(rateNames.filter((k) => params[k] === 0.62), ["rate0_62"]);
  assert.equal(sql.includes("{rate0_62:Float64}"), true);
});

test("every default price entry yields a parameter for each of its rates", () => {
  const { params } = buildCodexLogAggregateQuery(new Date("2026-09-14T00:00:00Z"), new Date("2026-09-15T00:00:00Z"));
  const values = new Set(Object.entries(params).filter(([k]) => k.startsWith("rate")).map(([, v]) => v));
  for (const entry of Object.values(DEFAULT_CODEX_PRICING)) {
    for (const scope of ["regional", "global"]) for (const tier of ["short", "long"]) {
      const rates = entry[scope]?.[tier];
      if (rates) for (const field of ["input", "cacheRead", "cacheWrite", "output"]) assert.ok(values.has(rates[field]));
    }
  }
});

test("the rate catalog selects rates before evaluating one token pricing expression", () => {
  const { sql } = buildCodexLogAggregateQuery(new Date("2026-09-14T00:00:00Z"),
    new Date("2026-09-15T00:00:00Z"), {}, undefined, { profile: "effort" });
  assert.equal((sql.match(/input_value - read_value - write_value/g) || []).length, 1);
  assert.match(sql, /arrayFirst\(/);
  assert.match(sql, /AS price_row/);
});

test("shared diagnostic profiles omit pricing and unrelated log aggregate families", () => {
  const from = new Date("2026-09-14T00:00:00Z"), to = new Date("2026-09-15T00:00:00Z");
  for (const [profile, included, omitted] of [
    ["tools", ["event", "operations", "tool", "approval"], ["usage", "effort", "scope", "latency", "runtime"]],
    ["performance", ["event", "operations", "latency"], ["usage", "effort", "scope", "tool", "approval", "runtime"]],
  ]) {
    const { sql, params } = buildCodexLogAggregateQuery(from, to, { model: "fixture" }, undefined, { profile });
    for (const family of included) assert.ok(sql.includes(`tuple('${family}'`), `${profile}: ${family}`);
    for (const family of omitted) assert.ok(!sql.includes(`tuple('${family}'`), `${profile}: ${family}`);
    assert.deepEqual(Object.keys(params).sort(), ["clientBackend", "clientModel", "clientUser", "from", "to"]);
    assert.match(sql, /quantilesExactWeightedIf/);
    assert.match(sql, /model_sessions AS/);
    assert.match(sql, /uniqExact\(tuple\(compact_source.timestamp,compact_source.resource,compact_source.attributes\)\)/);
    assert.doesNotMatch(sql, /AS input_number|AS output_number/);
  }
});

test("diagnostic states bypass raw maps and finalize merged identities before weighted aggregation", () => {
  const from = new Date("2026-10-01T00:00:15Z"), to = new Date("2026-10-26T00:00:45Z");
  for (const profile of ["tools", "performance"]) {
    const { sql, params } = buildCodexLogAggregateQuery(from, to,
      { user: "synthetic", model: "fixture", backend: "bedrock-mantle" }, undefined,
      { profile, diagnosticSource: "states" });
    assert.match(sql, /FROM claude_code\.codex_diagnostic_events_v1 FINAL/);
    assert.match(sql, /finalizeAggregation\(Identities\) AS weight/);
    assert.doesNotMatch(sql, /FROM claude_code\.otel_logs|uniqExact\(/);
    assert.match(sql, /model_sessions AS/);
    assert.match(sql, /quantilesExactWeightedIf/);
    assert.equal(params.clientUser, "synthetic");
    assert.equal(params.clientModel, "fixture");
    assert.equal(params.clientBackend, "bedrock-mantle");
  }
});

test("verified effort source excludes raw bulk before dedup and reuses exact diagnostic weights", () => {
  const from = new Date("2026-10-01T00:00:15Z"), to = new Date("2026-10-26T00:00:45Z");
  const { sql, params } = buildCodexLogAggregateQuery(from, to,
    { user: "fixture'", model: "needle-model-quote'", backend: "bedrock-mantle" }, undefined,
    { profile: "effort", diagnosticSource: "states" });
  assert.match(sql, /FROM claude_code\.codex_diagnostic_events_v1 FINAL/);
  assert.match(sql, /FROM claude_code\.otel_logs\s+PREWHERE/);
  assert.match(sql, /NOT \(a\['event.name'\] IN \('codex.sse_event','codex.websocket_event'\)/);
  assert.match(sql, /finalizeAggregation\(Identities\) AS weight/);
  assert.match(sql, /uniqExact\(tuple\(compact_source.timestamp,compact_source.resource,compact_source.attributes\)\)/);
  assert.match(sql, /UNION ALL/);
  assert.match(sql, /AS prompt_length/);
  assert.match(sql, /AS input_number/);
  assert.doesNotMatch(sql, /fixture'|needle-model-quote'/);
  assert.equal(params.clientUser, "fixture'");
});

test("unverified effort queries retain the full raw source", () => {
  const { sql } = buildCodexLogAggregateQuery(new Date("2026-09-14T00:00:00Z"),
    new Date("2026-09-15T00:00:00Z"), {}, undefined, { profile: "effort", diagnosticSource: "raw" });
  assert.doesNotMatch(sql, /codex_diagnostic_events_v1|PREWHERE|UNION ALL/);
  assert.match(sql, /FROM claude_code\.otel_logs/);
});

test("diagnostic operation families select only consumed outcomes while retaining every event", () => {
  const from = new Date("2026-09-14T00:00:00Z"), to = new Date("2026-09-15T00:00:00Z");
  const tools = buildCodexLogAggregateQuery(from, to, {}, undefined, { profile: "tools" }).sql;
  const performance = buildCodexLogAggregateQuery(from, to, {}, undefined, { profile: "performance" }).sql;
  assert.match(tools, /if\(event = 'codex.tool_decision', tuple\('operations'/);
  assert.match(performance, /if\(is_request OR \(stream AND event_kind = 'response.failed'\), tuple\('operations'/);
  for (const sql of [tools, performance]) assert.match(sql, /if\(1, tuple\('event'/);
});

test("diagnostic raw fallback groups only displayed attributes and retains exact full identities", () => {
  const from = new Date("2026-10-01T00:00:15Z"), to = new Date("2026-10-26T00:00:45Z");
  const { sql } = buildCodexLogAggregateQuery(from, to, {}, undefined,
    { profile: "performance", diagnosticSource: "raw" });
  assert.match(sql, /'' AS identity_time/);
  assert.match(sql, /CAST\(map\(\), 'Map\(String,\s*String\)'\) AS compact_resource/);
  assert.match(sql, /mapApply/);
  assert.match(sql, /uniqExact\(tuple\(compact_source.timestamp,compact_source.resource,compact_source.attributes\)\)/);
  assert.doesNotMatch(sql, /if\(intermediate, '', timestamp\)/);
});

test("default and effort profiles keep their raw usage source even when diagnostic states are requested", () => {
  const from = new Date("2026-10-01T00:00:15Z"), to = new Date("2026-10-26T00:00:45Z");
  for (const profile of [undefined, "effort"]) {
    const { sql } = buildCodexLogAggregateQuery(from, to, {}, undefined,
      { profile, diagnosticSource: "states" });
    assert.match(sql, /FROM claude_code\.otel_logs/);
    if (profile === "effort") assert.match(sql, /codex_diagnostic_events_v1 FINAL/);
    else assert.doesNotMatch(sql, /codex_diagnostic_events_v1/);
  }
});
