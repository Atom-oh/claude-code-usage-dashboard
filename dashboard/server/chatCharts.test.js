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

test("dashboard rows without observations chart as unknown while idle observed zeros stay zero", () => {
  const chart = buildChatChart({ ...spec, type: "bar", x: "label", x_type: "category", series: [{ key: "cost_usd", label: "Cost" }] },
    new Map([["query_1", { source: "dashboard", rows: [
      { label: "claude · anthropic", cost_usd: 1.5, cost_basis: "client_reported", observed_records: 3 },
      { label: "codex · unknown", cost_usd: 0, cost_basis: "aws_list_estimate", observed_records: 0 },
      { label: "claude · 2026-11-06 01:00:00", cost_usd: 0, cost_basis: "client_reported", observed_records: 0, timeline_observed: true },
    ] }]]));
  assert.deepEqual(chart.data.map(row => row.cost_usd), [1.5, null, 0]);
  assert.equal(chart.coverage, "canonical");
  // SQL results carry no fold markers; a column that happens to be named observed_records changes nothing.
  assert.deepEqual(buildChatChart(spec, results([{ t: "one", cost: 0, observed_records: 0 }])).data.map(row => row.cost), [0]);
});

test("partial and cost basis disclosure cover stored rows beyond the charted points", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ t: String(i), cost: i, cost_basis: "client_reported",
    ...(i === 55 ? { cost_basis: "computed_estimate", cost_partial: true } : {}) }));
  const chart = buildChatChart(spec, results(rows));
  assert.equal(chart.data.length, 50);
  assert.equal(chart.truncated, true);
  assert.equal(chart.partial, true);
  assert.deepEqual(chart.cost_bases, ["client_reported", "computed_estimate"]);
});

test("integers beyond the safe range are unknown points, not rounded values", () => {
  const chart = buildChatChart(spec, results([
    { t: "safe", cost: String(Number.MAX_SAFE_INTEGER) }, { t: "unsafe", cost: "9007199254740993" },
    { t: "number", cost: Number.MAX_SAFE_INTEGER + 2 }, { t: "decimal", cost: "0.000001" },
  ]));
  assert.deepEqual(chart.data.map(row => row.cost), [Number.MAX_SAFE_INTEGER, null, null, 0.000001]);
});

test("rejection-only Codex groups stay recorded zeros and mark the chart partial unless the rejected count is plotted (ADR-016)", () => {
  const rows = [
    { label: "codex · 2026-11-06 01:00:00", cost_usd: 0, cost_basis: "aws_list_estimate", cost_partial: false, observed_tokens: 0,
      tokens_partial: false, sessions: 1, rejected_requests: 3, request_rejections_only: true, observed_records: 3 },
    { label: "codex · 2026-11-06 02:00:00", cost_usd: 0.5, cost_basis: "aws_list_estimate", cost_partial: false, observed_tokens: 40,
      tokens_partial: false, sessions: 1, rejected_requests: 0, request_rejections_only: false, observed_records: 2 },
  ];
  const chart = (unit, keys) => buildChatChart({ ...spec, type: "bar", x: "label", x_type: "category", unit,
    series: keys.map(key => ({ key, label: key })) }, new Map([["query_1", { rows, source: "dashboard" }]]));
  const cost = chart("usd", ["cost_usd"]);
  assert.deepEqual(cost.data.map(row => row.cost_usd), [0, 0.5]);
  assert.deepEqual(Object.keys(cost.data[0]), ["label", "cost_usd"]);
  assert.equal(cost.partial, true);
  assert.equal(cost.coverage, "canonical");
  assert.equal(chart("tokens", ["observed_tokens"]).partial, true);
  const counts = chart("count", ["sessions", "rejected_requests"]);
  assert.deepEqual(counts.data.map(row => row.rejected_requests), [3, 0]);
  assert.equal(counts.partial, false);
  assert.equal(buildChatChart(spec, results([{ t: "one", cost: 0, request_rejections_only: true }])).partial, false);
});

test("a truncated usage result consults the stored totals' partial flags for rows the cap removed", () => {
  const rows = [{ t: "one", cost_usd: 1, cost_basis: "aws_list_estimate", cost_partial: false, tokens_partial: false, observed_records: 1 }];
  const build = (truncated, totals) => buildChatChart({ ...spec, series: [{ key: "cost_usd", label: "Cost" }] },
    new Map([["query_1", { rows, source: "dashboard", truncated, ...(totals ? { totals } : {}) }]]));
  assert.equal(build(true, { cost_usd: 3, cost_partial: true, tokens_partial: false }).partial, true);
  assert.equal(build(true, { cost_usd: 3, cost_partial: false, tokens_partial: true }).partial, true);
  assert.equal(build(true, { cost_usd: 3, cost_partial: false, tokens_partial: false }).partial, false);
  assert.equal(build(false, { cost_usd: 3, cost_partial: true }).partial, false);
  assert.equal(build(true).partial, false);
  assert.equal(build(true).truncated, true);
});
