import { expect, test } from "vitest";
import { isZeroTokenModel, withoutZeroTokenModels } from "./modelRows.js";

test("known zero tokens without cost are hidden", () => {
  expect(isZeroTokenModel({ model: "a", tokens: 0, cost: 0 })).toBe(true);
  expect(isZeroTokenModel({ model: "a", observed_tokens: 0, cost_usd: null })).toBe(true);
  expect(isZeroTokenModel({ model: "a", tokens: "0", input_tokens: 0, output_tokens: 0 })).toBe(true);
});

test("usage, positive cost and unknown tokens stay visible", () => {
  expect(isZeroTokenModel({ model: "a", tokens: 5, cost: 0 })).toBe(false);
  expect(isZeroTokenModel({ model: "a", tokens: 0, cost: 0.01 })).toBe(false);
  expect(isZeroTokenModel({ model: "a", observed_tokens: null, cost_usd: null })).toBe(false);
  expect(isZeroTokenModel({ model: "a" })).toBe(false);
});

test("filtering keeps order and tolerates missing data", () => {
  const rows = [{ model: "a", tokens: 1 }, { model: "b", tokens: 0 }, { model: "c", tokens: null }];
  expect(withoutZeroTokenModels(rows).map((r) => r.model)).toEqual(["a", "c"]);
  expect(withoutZeroTokenModels(undefined)).toEqual([]);
});
