import { expect, test } from "vitest";
import { asSpendRows } from "../spend.js";
import { mergeUserModelRows, mergeUserRows, groupTotalsText, groupModelSegments } from "./Cost.jsx";

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
  expect(merged[0]).toMatchObject({ cost: 16, computed_cost: 19.55, reported_cost: 16, tokens: 1500 });
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

test("a missing piece poisons user, model and group spend while retaining tokens", () => {
  const rows = [...ROWS, { ...ROWS[0], reported_cost: 9, display_cost: null, reported_cost_status: "partial" }];
  const a = mergeUserRows(rows)[0];
  expect(a.cost).toBeNull();
  expect(a.groups.bedrock.models["claude-sonnet-5"].cost).toBeNull();
  expect(mergeUserModelRows(rows)[0].cost).toBeNull();
  expect(mergeUserModelRows([...rows].reverse()).find((r) => r.user === "a@x.com" && r.model === "claude-sonnet-5").cost).toBeNull();
  expect(groupModelSegments(a.groups, "bedrock", "cost")).toBeNull();
  expect(groupTotalsText(a.groups, "cost")).toContain("bedrock 확인 필요");
  expect(groupModelSegments(a.groups, "bedrock", "tokens").total).toBe(2300);
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
});
