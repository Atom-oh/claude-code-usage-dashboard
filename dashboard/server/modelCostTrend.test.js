// Input rows are pre-aggregated per (day, group, model) by costByModelDailySql, which classifies
// each session scope in ClickHouse. The fold maps one row to one output row; the per-session
// rules themselves are pinned by the SQL text tests in queries.test.js and the live subtest in
// clientSql.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldModelCostCells, MODEL_COST_ROW_LIMIT } from "./modelCostTrend.js";
import { withComputedCost } from "./pricing.js";
import { ValidationError } from "./http.js";

const D = "2026-09-14 10:00:00";
const cell = (patch = {}) => ({ day: D, group: "bedrock", model: "claude-sonnet-5",
  known_report: 0, usable_scopes: 1, report_missing: 0, report_zero_with_tokens: 0,
  input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  observed_token_sum: 0, observed_token_scopes: 1, unobserved_token_scopes: 0, ...patch });

test("a positive report beside an unusable session keeps the known sum and marks it partial", () => {
  const out = foldModelCostCells([
    cell({ known_report: 5, report_missing: 1, input_tokens: 140, output_tokens: 30, observed_token_sum: 170, observed_token_scopes: 2 }),
  ]);
  assert.equal(out.length, 1);
  const row = out[0];
  assert.equal(row.reported_cost, 5);
  assert.equal(row.reported_partial, true);
  assert.equal(row.reported_unavailable, 1);
  assert.deepEqual(row.reported_reasons, { report_missing: 1, report_zero_with_tokens: 0 });
  assert.equal(row.reported_all_unavailable, false);
  assert.equal(row.input_tokens, 140);
  assert.equal(row.output_tokens, 30);
  assert.equal(row.observed_tokens, 170);
  assert.equal(row.tokens_partial, false);
});

test("a usable zero report beside a zero-with-tokens session reports a known 0 and marks it partial", () => {
  const out = foldModelCostCells([
    cell({ report_zero_with_tokens: 1, input_tokens: 50, observed_token_sum: 50, observed_token_scopes: 2 }),
  ]);
  assert.equal(out.length, 1);
  const row = out[0];
  assert.equal(row.reported_cost, 0);
  assert.equal(row.reported_partial, true);
  assert.equal(row.reported_unavailable, 1);
  assert.deepEqual(row.reported_reasons, { report_missing: 0, report_zero_with_tokens: 1 });
  assert.equal(row.reported_all_unavailable, false);
  assert.equal(row.input_tokens, 50);
});

test("a cell with no usable session reports null although known_report is 0", () => {
  const out = foldModelCostCells([
    cell({ usable_scopes: 0, report_missing: 1, report_zero_with_tokens: 1, input_tokens: 10, observed_token_sum: 10, observed_token_scopes: 2 }),
  ]);
  assert.equal(out.length, 1);
  const row = out[0];
  assert.equal(row.reported_cost, null);
  assert.equal(row.reported_all_unavailable, true);
  assert.equal(row.reported_partial, true);
  assert.equal(row.reported_unavailable, 2);
  assert.deepEqual(row.reported_reasons, { report_missing: 1, report_zero_with_tokens: 1 });
});

test("a token-only cell is report_missing and keeps its tokens", () => {
  const out = foldModelCostCells([
    cell({ usable_scopes: 0, report_missing: 1, input_tokens: 9, observed_token_sum: 9 }),
  ]);
  assert.equal(out.length, 1);
  const row = out[0];
  assert.equal(row.reported_cost, null);
  assert.equal(row.reported_all_unavailable, true);
  assert.deepEqual(row.reported_reasons, { report_missing: 1, report_zero_with_tokens: 0 });
  assert.equal(row.input_tokens, 9);
});

test("report-only scopes are usable and mark observed tokens partial", () => {
  const first = foldModelCostCells([cell({ known_report: 3, observed_token_scopes: 0, unobserved_token_scopes: 1 })]);
  assert.equal(first.length, 1);
  assert.equal(first[0].reported_cost, 3);
  assert.equal(first[0].reported_partial, false);
  assert.equal(first[0].reported_unavailable, 0);
  assert.equal(first[0].observed_tokens, null);
  assert.equal(first[0].tokens_partial, true);

  const second = foldModelCostCells([cell({ model: "claude-opus-5", observed_token_scopes: 0, unobserved_token_scopes: 1 })]);
  assert.equal(second.length, 1);
  assert.equal(second[0].reported_cost, 0);
  assert.equal(second[0].reported_partial, false);
  assert.equal(second[0].reported_all_unavailable, false);
  assert.deepEqual(second[0].reported_reasons, { report_missing: 0, report_zero_with_tokens: 0 });

  const third = foldModelCostCells([
    cell({ known_report: 3, input_tokens: 10, observed_token_sum: 10, observed_token_scopes: 1, unobserved_token_scopes: 1 }),
  ]);
  assert.equal(third.length, 1);
  assert.equal(third[0].observed_tokens, 10);
  assert.equal(third[0].tokens_partial, true);
});

test("a row with no observed scope is skipped instead of becoming a known $0", () => {
  const out = foldModelCostCells([
    cell({ model: "claude-haiku-4-5", usable_scopes: 0, known_report: 7, input_tokens: 999, observed_token_sum: 999 }),
    cell({ known_report: 2, input_tokens: 10, observed_token_sum: 10 }),
  ]);
  assert.equal(out.length, 1);
  const row = out[0];
  assert.equal(row.model, "claude-sonnet-5");
  assert.equal(out.some((r) => r.model === "claude-haiku-4-5"), false);
  assert.equal(row.reported_cost, 2);
  assert.equal(row.input_tokens, 10);
  assert.equal(row.observed_tokens, 10);
});

test("numeric strings from the driver are read as numbers", () => {
  const out = foldModelCostCells([
    cell({ known_report: "5.5", usable_scopes: "2", report_missing: "0", report_zero_with_tokens: "0",
      input_tokens: "100", output_tokens: "20", cache_read_tokens: "30", cache_write_tokens: "40",
      observed_token_sum: "190", observed_token_scopes: "2", unobserved_token_scopes: "0" }),
  ]);
  assert.equal(out.length, 1);
  const row = out[0];
  assert.equal(row.reported_cost, 5.5);
  assert.equal(typeof row.reported_cost, "number");
  assert.equal(row.input_tokens, 100);
  assert.equal(typeof row.input_tokens, "number");
  assert.equal(row.cache_read_tokens, 30);
  assert.equal(row.cache_write_tokens, 40);
  assert.equal(row.observed_tokens, 190);
  assert.equal(row.reported_unavailable, 0);
});

test("computed cost on summed tokens equals the sum of per-session estimates and an unpriced model nulls only the estimate", () => {
  const a = { model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 200, cache_read_tokens: 300, cache_write_tokens: 400 };
  const b = { model: "claude-sonnet-5", input_tokens: 500, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0 };
  const out = foldModelCostCells([
    cell({ known_report: 1, report_missing: 1, input_tokens: 1500, output_tokens: 250, cache_read_tokens: 300, cache_write_tokens: 400 }),
  ]);
  assert.equal(out.length, 1);
  const expected = withComputedCost([a])[0].cost + withComputedCost([b])[0].cost;
  assert.ok(expected > 0);
  assert.equal(out[0].unpriced, false);
  assert.ok(Math.abs(out[0].cost - expected) < 1e-12, `cost ${out[0].cost} should equal ${expected}`);

  const unpriced = foldModelCostCells([cell({ model: "fixture-unpriced-model", known_report: 1, input_tokens: 10 })]);
  assert.equal(unpriced.length, 1);
  assert.equal(unpriced[0].cost, null);
  assert.equal(unpriced[0].unpriced, true);
  assert.equal(unpriced[0].reported_cost, 1);
});

test("output rows sort by day, group, model", () => {
  const out = foldModelCostCells([
    cell({ day: "2026-09-14 11:00:00", model: "b", known_report: 1 }),
    cell({ group: "enterprise", model: "a", known_report: 1 }),
    cell({ model: "b", known_report: 1 }),
    cell({ model: "a", known_report: 1 }),
  ]);
  assert.deepEqual(out.map((r) => [r.day, r.group, r.model]), [
    [D, "bedrock", "a"],
    [D, "bedrock", "b"],
    [D, "enterprise", "a"],
    ["2026-09-14 11:00:00", "bedrock", "b"],
  ]);
});

test("output rows carry exactly the 16 contract keys and none of the SQL input names", () => {
  const out = foldModelCostCells([cell({ known_report: 1, input_tokens: 10, observed_token_sum: 10 })]);
  assert.equal(out.length, 1);
  const row = out[0];
  assert.deepEqual(Object.keys(row).sort(), [
    "cache_read_tokens", "cache_write_tokens", "cost", "day", "group", "input_tokens", "model",
    "observed_tokens", "output_tokens", "reported_all_unavailable", "reported_cost", "reported_partial",
    "reported_reasons", "reported_unavailable", "tokens_partial", "unpriced",
  ]);
  for (const key of ["known_report", "usable_scopes", "report_missing", "report_zero_with_tokens",
    "observed_token_sum", "observed_token_scopes", "unobserved_token_scopes", "session", "reported_unpriced"]) {
    assert.ok(!(key in row), key);
  }
});

test("the row limit maps exactly 50000 rows one-to-one and rejects one more with a 400", () => {
  assert.equal(MODEL_COST_ROW_LIMIT, 50000);
  const out = foldModelCostCells(Array(50000).fill(cell({ known_report: 1 })));
  assert.equal(out.length, 50000);
  assert.equal(out[0].reported_cost, 1);
  assert.throws(
    () => foldModelCostCells(Array(50001).fill(cell({ known_report: 1 }))),
    (err) => err instanceof ValidationError && err.status === 400 && /too much model cost data/.test(err.message),
  );
});

test("invalid token or report values null the field without inventing a report or an estimate", () => {
  const out = foldModelCostCells([
    cell({ known_report: 2, input_tokens: null, observed_token_sum: 5, observed_token_scopes: 1, unobserved_token_scopes: 1 }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].reported_cost, 2);
  assert.equal(out[0].reported_partial, false);
  assert.equal(out[0].input_tokens, null);
  assert.equal(out[0].cost, null);
  assert.equal(out[0].observed_tokens, 5);
  assert.equal(out[0].tokens_partial, true);

  const garbage = foldModelCostCells([cell({ known_report: "garbage" })]);
  assert.equal(garbage.length, 1);
  assert.equal(garbage[0].reported_cost, null);
  assert.equal(garbage[0].reported_partial, true);
  assert.equal(garbage[0].reported_all_unavailable, false);
  assert.equal(garbage[0].reported_unavailable, 0);

  const negative = foldModelCostCells([cell({ known_report: -1 })]);
  assert.equal(negative.length, 1);
  assert.equal(negative[0].reported_cost, null);
  assert.equal(negative[0].reported_partial, true);
  assert.equal(negative[0].reported_all_unavailable, false);
  assert.equal(negative[0].reported_unavailable, 0);
});

test("a non-finite known sum reports null and partial without counting unavailable sessions", () => {
  const out = foldModelCostCells([cell({ known_report: Number.MAX_VALUE })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].reported_cost, null);
  assert.equal(out[0].reported_partial, true);
  assert.equal(out[0].reported_all_unavailable, false);
  assert.equal(out[0].reported_unavailable, 0);
});

test("an unsafe observed token sum reports null and partial", () => {
  const out = foldModelCostCells([cell({ observed_token_sum: 2 ** 53, observed_token_scopes: 1 })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].observed_tokens, null);
  assert.equal(out[0].tokens_partial, true);
});

test("an empty input folds to an empty array", () => {
  assert.deepEqual(foldModelCostCells([]), []);
});
