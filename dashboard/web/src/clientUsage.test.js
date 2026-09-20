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

test.each([false, true])("known token and cost folding excludes unknown rows in either order: reverse=%s", (reverse) => {
  const rows = [
    { t: "2026-09-01T00:00:00Z", client: "codex", tokens: 10, cost_usd: 0.01 },
    { t: "2026-09-01 00:00:00", client: "codex", tokens: null, cost_usd: null },
    { t: "2026-09-01 00:00:00", client: "codex", tokens: 20, cost_usd: 0.02 },
    { t: "2026-09-01 01:00:00", client: "codex", tokens: null, cost_usd: null },
    { t: "2026-09-01 01:00:00", client: "codex", tokens: 0, cost_usd: 0 },
  ];
  expect(clientTimeline(reverse ? rows.reverse() : rows)).toEqual([
    { t: "2026-09-01 00:00:00", codex_tokens: 30, codex_cost: 0.03 },
    { t: "2026-09-01 01:00:00", codex_tokens: 0, codex_cost: 0 },
  ]);
});

test.each([false, true])("observed chart subtotals keep explicit unknown gaps and partial zero: reverse=%s", (reverse) => {
  const rows = [
    { t: "2026-09-01T00:00:00Z", client: "codex", tokens: null, observed_tokens: 148, tokens_partial: true, cost_usd: 0.01 },
    { t: "2026-09-01T00:00:00Z", client: "codex", tokens: 999, observed_tokens: null, tokens_partial: true, cost_usd: null },
    { t: "2026-09-01T01:00:00Z", client: "codex", tokens: 999, observed_tokens: null, tokens_partial: true, cost_usd: null },
    { t: "2026-09-01T03:00:00Z", client: "codex", tokens: null, observed_tokens: 0, tokens_partial: true, cost_usd: 0 },
    { t: "2026-09-01T03:00:00Z", client: "codex", tokens: null, observed_tokens: null, tokens_partial: true, cost_usd: null },
  ];
  expect(clientTimeline(reverse ? rows.reverse() : rows, { bucketHours: 1 })).toEqual([
    { t: "2026-09-01 00:00:00", codex_tokens: 148, codex_cost: 0.01 },
    { t: "2026-09-01 01:00:00", codex_tokens: null, codex_cost: null },
    { t: "2026-09-01 02:00:00" },
    { t: "2026-09-01 03:00:00", codex_tokens: 0, codex_cost: 0 },
  ]);
});

test.each([undefined, "", " ", false, NaN, Infinity, -1])("invalid cost %j is not a measured zero", (cost_usd) => {
  expect(clientTimeline([{ t: "2026-09-01T00:00:00Z", client: "codex", tokens: null, cost_usd }])[0].codex_cost).toBeNull();
});

test.each([1.5, Number.MAX_SAFE_INTEGER + 1, "1.5", "9007199254740993"])(
  "fractional or unsafe observed token count %j is unavailable without canonical fallback",
  (observed_tokens) => {
    expect(clientTimeline([{ t: "2026-09-01T00:00:00Z", client: "codex",
      tokens: 270, observed_tokens, cost_usd: 0.01 }])[0])
      .toMatchObject({ codex_tokens: null, codex_cost: 0.01 });
  },
);

test("missing whole buckets break a series without inventing zero usage", () => {
  expect(clientTimeline([
    { t: "2026-09-01T00:22:00Z", client: "codex", tokens: 0, cost_usd: 0 },
    { t: "2026-09-01T01:00:00Z", client: "codex", tokens: 10, cost_usd: 1 },
    { t: "2026-09-01T10:00:00Z", client: "codex", tokens: 20, cost_usd: 2 },
  ], { bucketHours: 1 })).toEqual([
    { t: "2026-09-01 00:22:00", codex_tokens: 0, codex_cost: 0 },
    { t: "2026-09-01 01:00:00", codex_tokens: 10, codex_cost: 1 },
    { t: "2026-09-01 02:00:00" },
    { t: "2026-09-01 10:00:00", codex_tokens: 20, codex_cost: 2 },
  ]);
});

test("minute gaps use the actual bucket size and preserve a partial first minute", () => {
  expect(clientTimeline([
    { t: "2026-09-01T00:00:30Z", client: "codex", tokens: 5, cost_usd: 0.1 },
    { t: "2026-09-01T00:01:00Z", client: "codex", tokens: 6, cost_usd: 0.2 },
    { t: "2026-09-01T00:05:00Z", client: "codex", tokens: 7, cost_usd: 0.3 },
  ], { bucketHours: 1 / 60 })).toEqual([
    { t: "2026-09-01 00:00:30", codex_tokens: 5, codex_cost: 0.1 },
    { t: "2026-09-01 00:01:00", codex_tokens: 6, codex_cost: 0.2 },
    { t: "2026-09-01 00:02:00" },
    { t: "2026-09-01 00:05:00", codex_tokens: 7, codex_cost: 0.3 },
  ]);
});

test("bounded hourly observations show no recorded activity as zero but preserve explicit unknown usage", () => {
  const result = clientTimeline([
    { client: "claude", t: "2026-09-01T00:22:00Z", observed_tokens: 10, cost_usd: 1 },
    { client: "codex", t: "2026-09-01T01:00:00Z", observed_tokens: 20, cost_usd: 2 },
    { client: "codex", t: "2026-09-01T03:00:00Z", observed_tokens: null, cost_usd: null },
  ], { bucketHours: 1, effectiveRange: {
    from: "2026-09-01T00:22:00Z", to: "2026-09-01T05:22:00Z",
  } });
  expect(result.map(row => row.t)).toEqual([
    "2026-09-01 00:22:00", "2026-09-01 01:00:00", "2026-09-01 02:00:00",
    "2026-09-01 03:00:00", "2026-09-01 04:00:00", "2026-09-01 05:00:00",
  ]);
  expect(result.map(row => row.claude_tokens)).toEqual([10, 0, 0, 0, 0, 0]);
  expect(result.map(row => row.codex_tokens)).toEqual([0, 20, 0, null, 0, 0]);
  expect(result.map(row => row.codex_cost)).toEqual([0, 2, 0, null, 0, 0]);
  expect(result[2].empty_clients).toEqual(["claude", "codex"]);
  expect(result[3].empty_clients).toEqual(["claude"]);
});

test("minute observation grids retain partial boundaries, and no source rows remain unavailable", () => {
  const effectiveRange = { from: "2026-09-01T00:00:30Z", to: "2026-09-01T00:03:20Z" };
  const result = clientTimeline([
    { client: "codex", t: "2026-09-01T00:01:00Z", observed_tokens: 5, cost_usd: 1 },
  ], { bucketHours: 1 / 60, effectiveRange });
  expect(result.map(row => row.t)).toEqual([
    "2026-09-01 00:00:30", "2026-09-01 00:01:00", "2026-09-01 00:02:00", "2026-09-01 00:03:00",
  ]);
  expect(result.map(row => row.codex_tokens)).toEqual([0, 5, 0, 0]);
  expect(result.some(row => Object.hasOwn(row, "claude_tokens"))).toBe(false);
  expect(clientTimeline([], { bucketHours: 1 / 60, effectiveRange })).toEqual([]);
});
