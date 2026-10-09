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
