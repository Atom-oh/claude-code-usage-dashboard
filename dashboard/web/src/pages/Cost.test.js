import { expect, test } from "vitest";
import { asSpendRows } from "../spend.js";
import { mergeUserModelRows, mergeUserRows, groupTotalsText, groupModelSegments, modelUserShares } from "./Cost.jsx";

const ROWS = [
  { user: "a@x.com", group: "bedrock", model: "claude-sonnet-5", cost: 12.34, reported_cost: 10, tokens: 1000, unpriced: false },
  { user: "a@x.com", group: "enterprise", model: "claude-sonnet-5", cost: 7.21, reported_cost: 6, tokens: 500, unpriced: false },
  { user: "a@x.com", group: "bedrock", model: "claude-opus-5", cost: 3, reported_cost: 2, tokens: 300, unpriced: false },
  { user: "b@x.com", group: "bedrock", model: "titan-text-lite", cost: null, reported_cost: 7, tokens: 700, unpriced: true },
  { user: "b@x.com", group: "unknown", model: "titan-text-lite", cost: null, reported_cost: 3, tokens: 300, unpriced: true },
];

test("user×model fold selects reported spend across groups and retains computed diagnostics", () => {
  const merged = mergeUserModelRows(ROWS);
  expect(merged).toHaveLength(3);
  expect(merged[0]).toMatchObject({ cost: 16, cost_partial: false, computed_cost: 19.55, reported_cost: 16, tokens: 1500 });
  expect(merged[0].groups.bedrock).toMatchObject({ cost: 10, tokens: 1000 });
  expect(merged[0].groups.enterprise).toMatchObject({ cost: 6, tokens: 500 });
  expect(merged[2]).toMatchObject({ cost: 10, computed_cost: null, unpriced: true, tokens: 1000 });
  expect(Object.keys(merged[1].groups)).toEqual(["bedrock"]);
});

test("user folds and model bars include positive reports for models without a price", () => {
  const [a, b] = mergeUserRows(ROWS);
  expect(a.cost).toBe(18);
  expect(a.computed_cost).toBeCloseTo(22.55);
  expect(a.groups.bedrock.models["claude-sonnet-5"]).toMatchObject({ cost: 10, tokens: 1000 });
  expect(b.cost).toBe(10);
  expect(groupModelSegments(b.groups, "bedrock", "cost").total).toBe(7);
  expect(groupModelSegments(b.groups, "bedrock", "tokens").total).toBe(700);
  const line = groupModelSegments(a.groups, "bedrock", "cost");
  expect(line.segs.map((x) => x.model)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  expect(line.total).toBe(12);
  expect(groupTotalsText(a.groups, "cost")).toBe("bedrock $12 · enterprise $6");
  expect(groupTotalsText(b.groups, "cost")).toBe("bedrock $7 · 미분류 $3");
});

// ADR-013: an unusable piece (a zero report with tokens, or a model without any usable report) is
// excluded from the known subtotal and disclosed as partial; it never counts as $0.
const UNLISTED = { user: "a@x.com", group: "bedrock", model: "unlisted-model", cost: null, reported_cost: null, tokens: 400, unpriced: true };

test("an unusable piece leaves known user, model and group subtotals marked partial while retaining tokens", () => {
  const rows = [...ROWS, { ...ROWS[0], reported_cost: 0 }, UNLISTED];
  const a = mergeUserRows(rows)[0];
  expect(a).toMatchObject({ cost: 18, cost_partial: true, reported_cost: 18, reported_unpriced: false, tokens: 3200 });
  expect(a.groups.bedrock.models["claude-sonnet-5"]).toMatchObject({ cost: 10, cost_partial: true });
  expect(a.groups.bedrock.models["claude-opus-5"]).toMatchObject({ cost: 2, cost_partial: false });
  expect(a.groups.bedrock.models["unlisted-model"]).toMatchObject({ cost: null, cost_partial: false, reported_unpriced: true });
  expect(a.groups.enterprise.models["claude-sonnet-5"]).toMatchObject({ cost: 6, cost_partial: false });
  const merged = mergeUserModelRows(rows);
  expect(merged[0]).toMatchObject({ model: "claude-sonnet-5", cost: 16, cost_partial: true });
  expect(merged[0].groups.bedrock).toMatchObject({ cost: 10, cost_partial: true });
  expect(merged[0].groups.enterprise).toMatchObject({ cost: 6, cost_partial: false });
  expect(merged.find((r) => r.model === "unlisted-model")).toMatchObject({ cost: null, cost_partial: false });
  expect(mergeUserModelRows([...rows].reverse()).find((r) => r.user === "a@x.com" && r.model === "claude-sonnet-5")).toMatchObject({ cost: 16, cost_partial: true });
  const line = groupModelSegments(a.groups, "bedrock", "cost");
  expect(line.segs.map((x) => [x.model, x.value])).toEqual([["claude-opus-5", 2], ["claude-sonnet-5", 10]]);
  expect(line).toMatchObject({ total: 12, partial: true });
  expect(groupModelSegments(a.groups, "enterprise", "cost")).toMatchObject({ total: 6, partial: false });
  expect(groupTotalsText(a.groups, "cost")).toBe("bedrock $12 (부분합) · enterprise $6");
  expect(groupModelSegments(a.groups, "bedrock", "tokens")).toMatchObject({ total: 2700, partial: false });
  expect(groupTotalsText(a.groups, "tokens")).toBe("bedrock 2,700토큰 · enterprise 500토큰");
  const readapted = asSpendRows(mergeUserRows(rows))[0];
  expect(readapted).toMatchObject({ cost: 18, cost_partial: true });
});

test("a user whose every piece is unusable stays unavailable rather than $0", () => {
  const rows = [
    { user: "c", group: "bedrock", model: "m1", cost: 4, reported_cost: 0, tokens: 10 },
    { user: "c", group: "bedrock", model: "m2", cost: null, reported_cost: null, tokens: 5, unpriced: true },
  ];
  const [c] = mergeUserRows(rows);
  expect(c).toMatchObject({ cost: null, cost_partial: false, reported_cost: null, reported_unpriced: true, tokens: 15 });
  expect(groupModelSegments(c.groups, "bedrock", "cost")).toBeNull();
  expect(groupTotalsText(c.groups, "cost")).toBe("bedrock 확인 필요");
  expect(groupModelSegments(c.groups, "bedrock", "tokens").total).toBe(15);
  expect(mergeUserModelRows(rows).map((r) => [r.cost, r.cost_partial])).toEqual([[null, false], [null, false]]);
  expect(asSpendRows([c])[0].cost).toBeNull();
});

test("folds accept adapted rows and preserve their selected totals on another adaptation", () => {
  expect(mergeUserRows(asSpendRows(ROWS))).toEqual(mergeUserRows(ROWS));
  expect(mergeUserModelRows(asSpendRows(ROWS))).toEqual(mergeUserModelRows(ROWS));
  const users = mergeUserRows(ROWS);
  expect(asSpendRows(users).map((r) => [r.cost, r.computed_cost])).toEqual(
    users.map((r) => [r.cost, r.computed_cost])
  );
});

test("zero reported spend is valid only when token usage is absent", () => {
  const rows = [
    { user: "missing", group: "bedrock", model: "known", cost: 1, reported_cost: 0, tokens: 12 },
    { user: "free", group: "bedrock", model: "known", cost: 0, reported_cost: 0, tokens: 0 },
  ];
  expect(mergeUserRows(rows).map((r) => r.cost)).toEqual([null, 0]);
  expect(mergeUserModelRows(rows).map((r) => r.cost)).toEqual([null, 0]);
  expect(mergeUserRows(rows).map((r) => r.cost_partial)).toEqual([false, false]);
  // A measured zero stays zero beside an excluded piece, and the exclusion is disclosed.
  const mixed = mergeUserRows(rows.map((r) => ({ ...r, user: "mixed" })));
  expect(mixed).toHaveLength(1);
  expect(mixed[0]).toMatchObject({ cost: 0, cost_partial: true });
});

test("model user shares divide by the model total and disclose unattributed spend only when complete", () => {
  const merged = mergeUserModelRows([
    ...ROWS,
    { user: "c@x.com", group: "bedrock", model: "claude-sonnet-5", cost: 1, reported_cost: 4, tokens: 100, unpriced: false },
  ]);
  const shares = modelUserShares(merged, { model: "claude-sonnet-5", cost: 25, cost_partial: false });
  expect(shares.rows.map((r) => [r.user, r.cost, r.share])).toEqual([["a@x.com", 16, 64], ["c@x.com", 4, 16]]);
  expect(shares.unattributed).toEqual({ cost: 5, share: 20 });
  expect(shares.partial).toBe(false);

  const partial = modelUserShares(merged, { model: "claude-sonnet-5", cost: 25, cost_partial: true });
  expect(partial.partial).toBe(true);
  expect(partial.unattributed).toBeNull();

  const unknownTotal = modelUserShares(merged, { model: "claude-sonnet-5", cost: null, cost_partial: false });
  expect(unknownTotal.rows.every((r) => r.share === null)).toBe(true);
  expect(modelUserShares(merged, { model: "missing", cost: 1 }).rows).toEqual([]);
});
