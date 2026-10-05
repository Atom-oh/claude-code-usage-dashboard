import { expect, test } from "vitest";
import { isZeroTokenModel, withoutZeroTokenModels } from "./modelRows.js";

test("complete known-zero usage without cost is hidden", () => {
  expect(isZeroTokenModel({ model: "a", tokens: 0, cost: 0 })).toBe(true);
  expect(isZeroTokenModel({ model: "a", tokens: 0, observed_tokens: 0, cost_usd: null, unpriced: 0 })).toBe(true);
  expect(isZeroTokenModel({ model: "a", tokens: "0", input_tokens: 0, output_tokens: 0 })).toBe(true);
});

test("usage, positive cost and unknown totals stay visible", () => {
  expect(isZeroTokenModel({ model: "a", tokens: 5, cost: 0 })).toBe(false);
  expect(isZeroTokenModel({ model: "a", tokens: 0, cost: 0.01 })).toBe(false);
  expect(isZeroTokenModel({ model: "a", observed_tokens: null, cost_usd: null })).toBe(false);
  expect(isZeroTokenModel({ model: "a" })).toBe(false);
});

test("partial or unpriced rows stay visible even when the known parts are zero", () => {
  // Unknown input with known zero output: null totals, a zero component and an unpriced count.
  expect(isZeroTokenModel({ tokens: null, observed_tokens: null, output_tokens: 0, unpriced: 1 })).toBe(false);
  expect(isZeroTokenModel({ tokens: 0, observed_tokens: 0, tokens_partial: true })).toBe(false);
  expect(isZeroTokenModel({ tokens: 0, observed_tokens: 0, cost_partial: true })).toBe(false);
  expect(isZeroTokenModel({ tokens: 0, unpriced: true })).toBe(false);
  expect(isZeroTokenModel({ tokens: 0, cost: null, reported_unpriced: true })).toBe(false);
  expect(isZeroTokenModel({ tokens: 0, observed_tokens: null })).toBe(false);
});

test("filtering keeps order and tolerates missing data", () => {
  const rows = [{ model: "a", tokens: 1 }, { model: "b", tokens: 0 }, { model: "c", tokens: null }];
  expect(withoutZeroTokenModels(rows).map((r) => r.model)).toEqual(["a", "c"]);
  expect(withoutZeroTokenModels(undefined)).toEqual([]);
});
