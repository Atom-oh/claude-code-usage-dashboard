import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatChart } from "./chatCharts.js";

const spec = { result_id: "query_1", type: "line", title: "Cost trend", x: "t",
  series: [{ key: "cost", label: "Cost" }], unit: "usd", x_type: "time" };
const results = rows => new Map([["query_1", { rows, truncated: false }]]);

test("chart rows come only from stored results and preserve unknown/zero", () => {
  const chart = buildChatChart(spec, results([{ t: "2026-11-07 01:00:00", cost: null }, { t: "2026-11-07 02:00:00", cost: "0" }]));
  assert.deepEqual(chart.data.map(r => r.cost), [null, 0]);
  assert.throws(() => buildChatChart({ ...spec, data: [{ cost: 999 }] }, results([])), /metadata/);
  assert.throws(() => buildChatChart({ ...spec, result_id: "missing" }, results([])), /result_id/);
});

test("chart limits truncate whole points and preserve source truncation", () => {
  const chart = buildChatChart(spec, results(Array.from({ length: 60 }, (_, i) => ({ t: String(i), cost: i }))));
  assert.equal(chart.data.length, 50);
  assert.equal(chart.truncated, true);
  assert.throws(() => buildChatChart({ ...spec, series: Array(4).fill(spec.series[0]) }, results([])));
});

test("malformed numeric values, missing columns and executable templates are rejected", () => {
  for (const cost of [undefined, "", false, NaN, Infinity, [], {}, "NaN"])
    assert.throws(() => buildChatChart(spec, results([{ t: "category", cost }])));
  assert.throws(() => buildChatChart(spec, results([{ t: "category" }])), /column/);
  assert.throws(() => buildChatChart({ ...spec, type: "script" }, results([])));
});

test("stacked token charts cannot double-add inclusive parents and subsets", () => {
  const row = { t: "synthetic", input_tokens: 20, cache_read_tokens: 5, cache_write_tokens: 2,
    output_tokens: 10, reasoning_tokens: 3, tokens: 30, observed_tokens: 30 };
  for (const keys of [
    ["input_tokens", "cache_read_tokens"], ["output_tokens", "reasoning_tokens"],
    ["tokens", "input_tokens"], ["observed_tokens", "cache_write_tokens"], ["tokens", "observed_tokens"],
  ]) {
    assert.throws(() => buildChatChart({ ...spec, type: "stacked_bar", unit: "tokens",
      series: keys.map(key => ({ key, label: key })) }, results([row])), /overlap/);
  }
  assert.doesNotThrow(() => buildChatChart({ ...spec, type: "stacked_bar", unit: "tokens",
    series: ["input_tokens", "output_tokens"].map(key => ({ key, label: key })) }, results([row])));
});

test("duplicate categories need an unambiguous source column", () => {
  assert.throws(() => buildChatChart(spec, results([{ t: "same", cost: 1 }, { t: "same", cost: 2 }])), /unique/);
});

test("chart metadata carries cost basis and canonical coverage", () => {
  const chart = buildChatChart({ ...spec, series: [{ key: "cost_usd", label: "Cost" }] }, new Map([["query_1", { rows: [
    { t: "one", cost_usd: 1, cost_basis: "client_reported" },
    { t: "two", cost_usd: null, cost_basis: "aws_list_estimate", cost_partial: true },
  ], source: "dashboard", quality: { missing_usage: 2 } }]]));
  assert.deepEqual(chart.cost_bases, ["client_reported", "aws_list_estimate"]);
  assert.equal(chart.partial, true);
  assert.equal(chart.coverage, "canonical");
  assert.equal(buildChatChart(spec, results([{ t: "one", cost: 1 }])).coverage, "unverified");
});

test("canonical chart units must match every selected column", () => {
  const rows = [{ t: "one", cost_usd: 1, observed_tokens: 10, input_tokens: 6, sessions: 2 }];
  const canonical = new Map([["query_1", { rows, source: "dashboard" }]]);
  const selected = (unit, keys) => ({ ...spec, unit, series: keys.map(key => ({ key, label: key })) });
  for (const [unit, keys] of [
    ["usd", ["observed_tokens"]], ["tokens", ["cost_usd"]], ["percent", ["sessions"]],
    ["usd", ["cost_usd", "input_tokens"]], ["count", ["unrecognized"]],
  ]) assert.throws(() => buildChatChart(selected(unit, keys), canonical), /unit/i);
  for (const [unit, keys] of [["usd", ["cost_usd"]], ["tokens", ["observed_tokens", "input_tokens"]], ["count", ["sessions"]]])
    assert.doesNotThrow(() => buildChatChart(selected(unit, keys), canonical));
});

test("SQL charts cannot relabel known token and cost columns", () => {
  for (const [key, unit] of [["input_tokens", "usd"], ["tokens", "usd"], ["cost_usd", "tokens"]])
    assert.throws(() => buildChatChart({ ...spec, unit, series: [{ key, label: key }] },
      results([{ t: "one", [key]: 3 }])), /unit/i);
});
