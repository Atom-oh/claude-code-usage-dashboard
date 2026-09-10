import { expect, test } from "vitest";
import { asSpendRow, asSpendRows, sumSpend } from "./spend.js";

test("reported spend replaces view cost without mutating computed diagnostics", () => {
  const raw = { cost: 7817.28, reported_cost: 6647.79, display_cost: 6647.79, tokens: 1200 };
  const view = asSpendRow(raw);
  expect(view.cost).toBe(6647.79);
  expect(view.computed_cost).toBe(7817.28);
  expect(raw.cost).toBe(7817.28);
  expect(asSpendRow({ computed_cost: 7817.28, reported_cost: "6647.79" }).cost).toBe(6647.79);
  expect(asSpendRow({ cost: 12, computed_cost: 99, reported_cost: 7 }).computed_cost).toBe(99);
  expect(asSpendRow({ cost: null, unpriced: true, reported_cost: 7 }).cost).toBe(7);
});

test.each([undefined, null, "", " ", "not a number", NaN, Infinity, -1, "-1", false, []])(
  "invalid legacy reported value %j never falls back to computed cost",
  (reported_cost) => {
    expect(asSpendRow({ cost: 99, reported_cost, tokens: 12 }).cost).toBeNull();
  }
);

test("explicit unavailable display spend survives a positive reported aggregate", () => {
  const row = { cost: 99, reported_cost: 7, display_cost: null, reported_cost_status: "partial" };
  expect(asSpendRow(row)).toMatchObject({ cost: null, computed_cost: 99, reported_cost_status: "partial" });
  expect(asSpendRow({ ...row, display_cost: 4 }).cost).toBe(4);
});

test.each(["tokens", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"])(
  "zero report with positive %s is unavailable",
  (field) => {
    expect(asSpendRow({ cost: 99, reported_cost: "0", [field]: "12" }).cost).toBeNull();
    expect(asSpendRow({ cost: 99, reported_cost: 0, [field]: 0 }).cost).toBe(0);
  }
);

test("previous spend uses its own token evidence and never computed previous cost", () => {
  expect(asSpendRow({ cost: 99, reported_cost: 8, prev_cost: 50, prev_display_cost: 4 }).prev_cost).toBe(4);
  expect(asSpendRow({ reported_cost: 8, prev_cost: 50, prev_display_cost: null, prev_reported_cost: 4 }).prev_cost).toBeNull();
  expect(asSpendRow({ reported_cost: 8, prev_cost: 50 }).prev_cost).toBeNull();
  expect(asSpendRow({ reported_cost: 8, prev_reported_cost: "4" }).prev_cost).toBe(4);
  expect(asSpendRow({ tokens: 12, reported_cost: 8, prev_reported_cost: 0, prev_tokens: 0 }).prev_cost).toBe(0);
  expect(asSpendRow({ tokens: 0, reported_cost: 8, prev_reported_cost: 0, prev_input_tokens: 12 }).prev_cost).toBeNull();
});

test("adapted and folded rows can be adapted repeatedly without losing diagnostics or nulls", () => {
  const rows = [
    { cost: 7817.28, reported_cost: 6647.79, prev_cost: 99, prev_reported_cost: 4 },
    { cost: null, reported_cost: 7 },
    { cost: 8, reported_cost: 7, display_cost: null, reported_cost_status: "partial" },
  ];
  const once = asSpendRows(rows);
  expect(asSpendRows(once)).toEqual(once);
  expect(asSpendRows(JSON.parse(JSON.stringify(once)))).toEqual(once);
  expect(once[1].computed_cost).toBeNull();
  expect(asSpendRows()).toEqual([]);
});

test("sumSpend propagates unknown pieces and keeps valid zero and numeric strings", () => {
  expect(sumSpend([{ cost: 3 }, { cost: "4" }])).toBe(7);
  expect(sumSpend([{ cost: 3 }, { cost: null }])).toBeNull();
  expect(sumSpend([{ cost: 3 }, {}])).toBeNull();
  expect(sumSpend([{ cost: 3 }, { cost: "" }])).toBeNull();
  expect(sumSpend([{ cost: NaN }])).toBeNull();
  expect(sumSpend([{ cost: -1 }])).toBeNull();
  expect(sumSpend([{ cost: 0 }])).toBe(0);
  expect(sumSpend([])).toBe(0);
  expect(sumSpend([{ prev_cost: 3 }, { prev_cost: 4 }], "prev_cost")).toBe(7);
});
