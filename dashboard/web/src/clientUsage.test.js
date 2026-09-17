import { expect, test } from "vitest";
import { formatClientCost, formatObserved, clientTimeline } from "./clientUsage.js";

test("observed formatting distinguishes unknown and zero, retaining tiny positive USD amounts", () => {
  expect(formatObserved(null)).toBe("—");
  expect(formatObserved(undefined)).toBe("—");
  expect(formatObserved(0)).toBe("0");
  expect(formatClientCost(null)).toBe("—");
  expect(formatClientCost(0)).toBe("$0");
  expect(formatClientCost(0.0042395)).toBe("$0.0042395");
  expect(formatClientCost(0.0000000000123)).toBe("$0.0000000000123");
  expect(formatClientCost("bad")).toBe("—");
});

test("signed diagnostic measurements remain visible outside nonnegative usage rollups", () => {
  expect(formatObserved(-1.5)).toBe("-1.5");
});

test("chart sums known costs, retaining all-unknown costs and disjoint clients", () => {
  const result = clientTimeline([
    { t: "2026-09-01T01:00:00.000Z", client: "codex", tokens: 270, cost_usd: 0.0042395, reasoning_tokens: 15 },
    { t: "2026-09-01T00:00:00.000Z", client: "claude", tokens: 20, cost_usd: 0 },
    { t: "2026-09-01T01:00:00.000Z", client: "codex", tokens: 10, cost_usd: null },
    { t: "2026-09-01T00:00:00.000Z", client: "codex", tokens: null, cost_usd: null },
  ]);
  expect(result).toEqual([
    { t: "2026-09-01 00:00:00", claude_tokens: 20, claude_cost: 0, codex_tokens: null, codex_cost: null },
    { t: "2026-09-01 01:00:00", codex_tokens: 280, codex_cost: 0.0042395 },
  ]);
});

test.each([false, true])("known-cost folding is order independent and tokens still propagate null: reverse=%s", (reverse) => {
  const rows = [
    { t: "2026-09-01T00:00:00Z", client: "codex", tokens: 10, cost_usd: 0.01 },
    { t: "2026-09-01 00:00:00", client: "codex", tokens: null, cost_usd: null },
    { t: "2026-09-01 00:00:00", client: "codex", tokens: 20, cost_usd: 0.02 },
    { t: "2026-09-01 01:00:00", client: "codex", tokens: null, cost_usd: null },
    { t: "2026-09-01 01:00:00", client: "codex", tokens: 0, cost_usd: 0 },
  ];
  expect(clientTimeline(reverse ? rows.reverse() : rows)).toEqual([
    { t: "2026-09-01 00:00:00", codex_tokens: null, codex_cost: 0.03 },
    { t: "2026-09-01 01:00:00", codex_tokens: null, codex_cost: 0 },
  ]);
});

test.each([undefined, "", " ", false, NaN, Infinity, -1])("invalid cost %j is not a measured zero", (cost_usd) => {
  expect(clientTimeline([{ t: "2026-09-01T00:00:00Z", client: "codex", tokens: null, cost_usd }])[0].codex_cost).toBeNull();
});
