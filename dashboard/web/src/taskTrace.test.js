import { expect, test } from "vitest";
import { compactCount, cumulativeByLane, iconFor, laneName, laneOrder, modelBreakdown, modelKey } from "./taskTrace.js";

const lane = (id, kind = "general-purpose", extra = {}) => ({ id, label: kind, kind, spawned_by: null,
  llm_calls: 1, cost_usd: 1, cost_partial: false, ...extra });
const llm = (id, laneId, start, cost, duration = 10) => ({ id, parent: null, lane: laneId, kind: "llm", name: "llm_request",
  start_ms: start, duration_ms: duration, attrs: {}, cost_usd: cost });

test("laneOrder puts main first", () => {
  const lanes = [lane("b"), lane("a", "Explore"), lane("main", "main")];
  const spans = [llm("s1", "a", 50, 1), llm("s2", "b", 20, 1), llm("s3", "main", 0, 1)];
  expect(laneOrder(lanes, spans).map((l) => l.id)).toEqual(["main", "b", "a"]);
  // Without spans the given order is kept after main; lanes without spans sort last.
  expect(laneOrder(lanes).map((l) => l.id)).toEqual(["main", "b", "a"]);
  expect(laneOrder([lane("x"), lane("main", "main"), lane("y")], [llm("s", "y", 5, 1)]).map((l) => l.id))
    .toEqual(["main", "y", "x"]);
});

test("cumulativeByLane stacks lanes and is monotonic", () => {
  const lanes = [lane("main", "main"), lane("a")];
  const spans = [llm("m1", "main", 0, 1), llm("a1", "a", 40, 2), llm("m2", "main", 80, 0.5),
    { id: "t", lane: "main", kind: "tool", start_ms: 10, duration_ms: 5, attrs: {} }];
  const points = cumulativeByLane(spans, lanes, 10);
  expect(points).toHaveLength(11);
  expect(points[0].t_ms).toBe(0);
  const last = points.at(-1);
  expect(last.by_lane).toEqual({ main: 1.5, a: 2 });
  expect(last.total).toBeCloseTo(3.5);
  for (let i = 1; i < points.length; i++) {
    expect(points[i].t_ms).toBeGreaterThanOrEqual(points[i - 1].t_ms);
    expect(points[i].total).toBeGreaterThanOrEqual(points[i - 1].total);
    for (const id of ["main", "a"]) expect(points[i].by_lane[id]).toBeGreaterThanOrEqual(points[i - 1].by_lane[id]);
  }
  // A call counts once it has finished.
  const before = points.find((p) => p.t_ms < 50 && p.t_ms >= 10);
  expect(before.by_lane.a).toBe(0);
});

test("cumulativeByLane marks unknown lane null", () => {
  const lanes = [lane("main", "main"), lane("a")];
  const spans = [llm("m1", "main", 0, 1), llm("a1", "a", 50, null), llm("a0", "a", 10, 2)];
  const points = cumulativeByLane(spans, lanes, 10);
  const early = points.find((p) => p.t_ms >= 20 && p.t_ms < 60);
  expect(early.by_lane.a).toBe(2);
  expect(early.total).toBe(3);
  const last = points.at(-1);
  expect(last.by_lane).toHaveProperty("a", null);
  expect(last.by_lane.main).toBe(1);
  expect(last.total).toBeNull();
  // An unplaceable call with unknown time leaves the lane unknown throughout.
  const unplaced = cumulativeByLane([llm("x", "a", null, 1)], lanes, 4);
  expect(unplaced.every((p) => p.by_lane.a === null && p.by_lane.main === 0)).toBe(true);
  // A Codex sampling span with no linked completion has no cost key: not a priced call.
  const codex = cumulativeByLane([{ ...llm("c", "main", 0, 1) }, { id: "u", lane: "main", kind: "llm", start_ms: 5,
    duration_ms: 1, attrs: {} }], [lane("main", "main")], 2);
  expect(codex.at(-1).total).toBe(1);
});

test("iconFor maps mcp__slack__x to mcp", () => {
  expect(iconFor("mcp__slack__x")).toBe("mcp");
  expect(iconFor("Bash")).toBe("Bash");
  expect(iconFor("WebSearch")).toBe("WebSearch");
  expect(iconFor("wait")).toBe("wait");
  expect(iconFor("Explore", "agent")).toBe("Explore");
  expect(iconFor("pr-autofix-implementer", "agent")).toBe("custom");
  expect(iconFor("SomethingNew")).toBe("tool");
  expect(iconFor(undefined)).toBe("tool");
});

test("laneName labels unresolved custom lanes neutrally", () => {
  expect(laneName({ id: "main", kind: "main", label: "main" })).toBe("메인 세션");
  expect(laneName({ id: "x", kind: "custom", label: null })).toBe("서브에이전트");
  expect(laneName({ id: "x", kind: "custom", label: "reviewer" })).toBe("reviewer");
  expect(laneName({ id: "x", kind: "Explore", label: "Explore" })).toBe("Explore");
});

test("compactCount abbreviates large counts", () => {
  expect(compactCount(950)).toBe("950");
  expect(compactCount(612000)).toBe("612K");
  expect(compactCount(173300000)).toBe("173.3M");
  expect(compactCount(null)).toBeNull();
});

const call = (id, laneId, model, source, cost, tokens = { input: 1, cache_read: 2, cache_write: 3, output: 4 }) => {
  const s = { id, parent: null, lane: laneId, kind: "llm", name: "llm_request", start_ms: 0, duration_ms: 1,
    attrs: { ...(model ? { model } : {}), ...(source ? { query_source_safe: source } : {}) }, tokens };
  return cost === undefined ? s : { ...s, cost_usd: cost };
};

test("modelBreakdown groups llm calls by model and call source, most calls first", () => {
  const spans = [
    call("a", "main", "claude-opus-5-5", "repl_main_thread", 1),
    call("b", "agent-1", "claude-sonnet-5", "sdk", 0.25),
    call("c", "main", "claude-opus-5-5", "repl_main_thread", 2),
    call("d", "agent-2", "claude-sonnet-5", "model_validation", 0.5),
    call("e", "agent-1", "claude-sonnet-5", "sdk", 0.25),
    call("f", "agent-2", "claude-sonnet-5", "sdk", 0),
    { id: "t", lane: "main", kind: "tool", start_ms: 0, duration_ms: 1, attrs: { tool_name: "Bash" } },
  ];
  const rows = modelBreakdown(spans);
  expect(rows.map((r) => [r.model, r.source, r.calls])).toEqual([
    ["claude-sonnet-5", "sdk", 3], ["claude-opus-5-5", "repl_main_thread", 2], ["claude-sonnet-5", "model_validation", 1]]);
  expect(rows[0].lanes).toEqual(["agent-1", "agent-2"]);
  expect(rows[0].cost_usd).toBeCloseTo(0.5);
  expect(rows[0].cost_partial).toBe(false);
  expect(rows[0].observed_tokens).toBe(30);
  expect(rows[1].cost_usd).toBe(3);
  expect(rows[0].key).toBe(modelKey(spans[1]));
  expect(rows[0].key).not.toBe(modelKey(spans[3]));
});

test("modelBreakdown keeps unknown cost null and flags partial sums", () => {
  const rows = modelBreakdown([
    call("a", "main", "gpt-6.1", null, undefined), // Codex sampling span without a linked completion
    call("b", "main", "gpt-6.1", null, null),
    call("c", "main", "claude-opus-5-5", null, 1, { input: null, cache_read: 2, cache_write: 3, output: 4 }),
    call("d", "main", "claude-opus-5-5", null, null),
    call("e", "main", null, null, 0.1),
  ]);
  const gpt = rows.find((r) => r.model === "gpt-6.1");
  expect(gpt).toMatchObject({ source: null, calls: 2, cost_usd: null, cost_partial: true, observed_tokens: 20 });
  const opus = rows.find((r) => r.model === "claude-opus-5-5");
  expect(opus).toMatchObject({ cost_usd: 1, cost_partial: true, observed_tokens: 10, tokens_partial: true });
  // A call without a model forms its own unknown-model group, sorted after known labels on ties.
  expect(rows.at(-1)).toMatchObject({ model: null, calls: 1, cost_usd: 0.1, cost_partial: false });
  expect(modelBreakdown([])).toEqual([]);
});

test("modelBreakdown labels a Codex call by its linked completion model when the span has none", () => {
  const span = { ...call("s", "main", null, null, 0.2), completion: { model: "gpt-6.1", count: 1 } };
  expect(modelBreakdown([span])[0]).toMatchObject({ model: "gpt-6.1", source: null, calls: 1 });
});
