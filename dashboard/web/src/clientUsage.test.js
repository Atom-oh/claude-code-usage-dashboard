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

test("chart folds only additive time measures, preserving incomplete costs and disjoint clients", () => {
  const result = clientTimeline([
    { t: "2026-09-01T01:00:00.000Z", client: "codex", tokens: 270, cost_usd: 0.0042395, reasoning_tokens: 15 },
    { t: "2026-09-01T00:00:00.000Z", client: "claude", tokens: 20, cost_usd: 0 },
    { t: "2026-09-01T01:00:00.000Z", client: "codex", tokens: 10, cost_usd: null },
    { t: "2026-09-01T00:00:00.000Z", client: "codex", tokens: null, cost_usd: null },
  ]);
  expect(result).toEqual([
    { t: "2026-09-01 00:00:00", claude_tokens: 20, claude_cost: 0, codex_tokens: null, codex_cost: null },
    { t: "2026-09-01 01:00:00", codex_tokens: 280, codex_cost: null },
  ]);
});
