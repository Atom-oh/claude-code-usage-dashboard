import { expect, test } from "vitest";
import { asSpendRow, asSpendRows, sumKnownSpend, sumSpend } from "./spend.js";

test("reported spend replaces view cost without mutating computed diagnostics", () => {
  const raw = { cost: 7817.28, reported_cost: 6647.79, tokens: 1200 };
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

test("a consumer unpriced flag survives a positive reported subtotal", () => {
  const row = { cost: 99, reported_cost: 7, reported_unpriced: true };
  expect(asSpendRow(row)).toMatchObject({ cost: null, computed_cost: 99, reported_unpriced: true });
  expect(asSpendRow({ ...row, reported_unpriced: false }).cost).toBe(7);
});

test("the frontend selects reported_cost directly and ignores obsolete server display fields", () => {
  const view = asSpendRow({ cost: 99, reported_cost: 7, display_cost: 4, reported_cost_status: "partial" });
  expect(view.cost).toBe(7);
  expect(asSpendRow({ cost: 99, reported_cost: 7 }).display_cost).toBeUndefined();
});

test.each(["tokens", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"])(
  "zero report with positive %s is unavailable",
  (field) => {
    expect(asSpendRow({ cost: 99, reported_cost: "0", [field]: "12" }).cost).toBeNull();
    expect(asSpendRow({ cost: 99, reported_cost: 0, [field]: 0 }).cost).toBe(0);
  }
);

test("previous spend uses its own token evidence and never computed previous cost", () => {
  expect(asSpendRow({ cost: 99, reported_cost: 8, prev_cost: 50, prev_reported_cost: 4 }).prev_cost).toBe(4);
  expect(asSpendRow({ reported_cost: 8, prev_cost: 50, prev_reported_unpriced: true, prev_reported_cost: 4 }).prev_cost).toBeNull();
  expect(asSpendRow({ reported_cost: 8, prev_cost: 50 }).prev_cost).toBeNull();
  expect(asSpendRow({ reported_cost: 8, prev_reported_cost: "4" }).prev_cost).toBe(4);
  expect(asSpendRow({ tokens: 12, reported_cost: 8, prev_reported_cost: 0, prev_tokens: 0 }).prev_cost).toBe(0);
  expect(asSpendRow({ tokens: 0, reported_cost: 8, prev_reported_cost: 0, prev_input_tokens: 12 }).prev_cost).toBeNull();
});

test("adapted and folded rows can be adapted repeatedly without losing diagnostics or nulls", () => {
  const rows = [
    { cost: 7817.28, reported_cost: 6647.79, prev_cost: 99, prev_reported_cost: 4 },
    { cost: null, reported_cost: 7 },
    { cost: 8, reported_cost: 7, reported_unpriced: true },
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

test("sumKnownSpend sums usable pieces, discloses exclusions and stays null only when all are unusable", () => {
  expect(sumKnownSpend([{ cost: 3 }, { cost: "4" }])).toEqual({ total: 7, partial: false });
  expect(sumKnownSpend([{ cost: 3 }, { cost: null }])).toEqual({ total: 3, partial: true });
  expect(sumKnownSpend([{ cost: null }, { cost: 3 }])).toEqual({ total: 3, partial: true });
  expect(sumKnownSpend([{ cost: 3 }, {}])).toEqual({ total: 3, partial: true });
  expect(sumKnownSpend([{ cost: 3 }, { cost: "" }, { cost: NaN }, { cost: -1 }])).toEqual({ total: 3, partial: true });
  expect(sumKnownSpend([{ cost: null }, { cost: "" }, { cost: -1 }])).toEqual({ total: null, partial: false });
  expect(sumKnownSpend([{ cost: 0 }, { cost: null }])).toEqual({ total: 0, partial: true });
  expect(sumKnownSpend([{ cost: 0 }])).toEqual({ total: 0, partial: false });
  expect(sumKnownSpend([])).toEqual({ total: 0, partial: false });
  expect(sumKnownSpend()).toEqual({ total: 0, partial: false });
  expect(sumKnownSpend([{ prev_cost: 3 }, { prev_cost: null }], "prev_cost")).toEqual({ total: 3, partial: true });
  expect(sumKnownSpend([{ cost: Number.MAX_VALUE }, { cost: Number.MAX_VALUE }])).toEqual({ total: null, partial: false });
});

test("sumKnownSpend carries a usable partial piece and ignores the flag on an unusable one", () => {
  expect(sumKnownSpend([{ cost: 5, cost_partial: true }, { cost: 1 }])).toEqual({ total: 6, partial: true });
  expect(sumKnownSpend([{ cost: 5, cost_partial: false }, { cost: 1 }])).toEqual({ total: 6, partial: false });
  expect(sumKnownSpend([{ cost: null, cost_partial: true }])).toEqual({ total: null, partial: false });
  // A re-adapted partial fold keeps both its known subtotal and its disclosure.
  const view = asSpendRow({ cost: 5, cost_partial: true, computed_cost: 9, reported_cost: 5, tokens: 10 });
  expect(view).toMatchObject({ cost: 5, cost_partial: true, computed_cost: 9 });
  expect(sumKnownSpend([view, { cost: 2 }])).toEqual({ total: 7, partial: true });
  // sumSpend keeps its strict propagation for the pages that still use it.
  expect(sumSpend([{ cost: 5, cost_partial: true }, { cost: null }])).toBeNull();
});

test("a server known subtotal marks the adapted row partial and strict totals withhold it", () => {
  const group = asSpendRow({ group: "bedrock", reported_cost: 12, reported_partial: true, input_tokens: 10 });
  expect(group).toMatchObject({ cost: 12, cost_partial: true, reported_unpriced: false });
  expect(asSpendRow({ reported_cost: 12 }).cost_partial).toBe(false);
  // An all-unknown group stays unavailable without a partial flag.
  expect(asSpendRow({ reported_cost: null, reported_partial: false })).toMatchObject({ cost: null, cost_partial: false });
  expect(sumKnownSpend([group, asSpendRow({ reported_cost: 3 })])).toEqual({ total: 15, partial: true });
  expect(sumSpend([group, asSpendRow({ reported_cost: 3 })])).toBeNull();
  expect(sumSpend([group], "computed_cost")).toBeNull();
  expect(sumSpend([{ computed_cost: 4, cost_partial: true }], "computed_cost")).toBe(4);
});
