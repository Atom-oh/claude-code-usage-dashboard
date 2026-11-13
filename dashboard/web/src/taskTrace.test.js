import { expect, test } from "vitest";
import { compactCount, contextSummary, cumulativeByLane, iconFor, laneName, laneOrder, modelBreakdown, modelKey, modelUsage, withLaneIdentity, contextLines } from "./taskTrace.js";

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

test("contextSummary: peak, main first/last, biggest compaction and limit shares", () => {
  const s = contextSummary({ points: [{ span: "a", lane: "main", start_ms: 0, tokens: 100 },
    { span: "b", lane: "ag", start_ms: 5, tokens: 900 }, { span: "c", lane: "main", start_ms: 9, tokens: 400 },
    { span: "d", lane: "main", start_ms: 3, tokens: null }], missing: 1, partial: true,
  compactions: [{ start_ms: 1, pre_tokens: 500, post_tokens: 100, trigger: "auto" },
    { start_ms: 2, pre_tokens: 900, post_tokens: 50, trigger: "manual" }, { start_ms: 3, pre_tokens: null, post_tokens: 1 }],
  limits: { context_window: 1800, auto_compact_token_limit: null } });
  expect(s.peak.span).toBe("b");
  expect([s.mainFirst, s.mainLast]).toEqual([100, 400]);
  expect(s.compactions).toBe(3);
  expect(s.biggestCompaction.trigger).toBe("manual");
  expect(s.windowShare).toBe(0.5);
  expect(s.limitShare).toBeNull();
  expect([s.points, s.missing, s.partial]).toEqual([3, 1, true]);
  const empty = contextSummary(null);
  expect([empty.peak, empty.compactions, empty.mainLast, empty.points]).toEqual([null, null, null, 0]);
});

test("modelUsage folds call sources into one row per model, most expensive first", () => {
  const rows = modelUsage([
    call("a", "main", "claude-haiku-5-5", "sdk", 0.01),
    call("b", "main", "claude-opus-5-5", "repl_main_thread", 1),
    call("c", "agent-1", "claude-haiku-5-5", "agent:builtin", 0.02),
    call("d", "agent-1", "claude-haiku-5-5", "agent:builtin", null),
    call("e", "main", null, "sdk", 0.5),
    { id: "t", lane: "main", kind: "tool", start_ms: 0, duration_ms: 1, attrs: { tool_name: "Bash" } },
  ]);
  expect(rows.map((r) => [r.model, r.calls])).toEqual([["claude-opus-5-5", 1], [null, 1], ["claude-haiku-5-5", 3]]);
  expect(rows[0].share).toBeCloseTo(1 / 1.53);
  expect(rows[2].cost_usd).toBeCloseTo(0.03);
  expect(rows[2].cost_partial).toBe(true);
  // A model whose calls all lack a cost keeps it unknown and has no share.
  const unknown = modelUsage([call("x", "main", "gpt-6.1", null, undefined)]);
  expect(unknown[0]).toMatchObject({ model: "gpt-6.1", calls: 1, cost_usd: null, cost_partial: true, share: null });
});

test("lanes that share a name get numbered names and distinct colours", () => {
  const lanes = withLaneIdentity([
    { id: "main", kind: "main", label: "main" },
    { id: "a", kind: "general-purpose", label: "general-purpose" },
    { id: "b", kind: "Explore", label: "Explore" },
    { id: "c", kind: "general-purpose", label: "general-purpose" },
    { id: "d", kind: "general-purpose", label: "general-purpose" },
  ]);
  expect(lanes.map(laneName)).toEqual(["메인 세션", "general-purpose #1", "Explore", "general-purpose #2", "general-purpose #3"]);
  const colors = lanes.map((l) => l.color);
  // The first lane of a kind keeps its kind colour; later same-kind lanes get their own shade.
  expect(colors[1]).toBe("var(--chart-3)");
  expect(colors[2]).toBe("var(--chart-2)");
  expect(new Set([colors[1], colors[3], colors[4]]).size).toBe(3);
  expect(colors[3]).toContain("var(--chart-3)");
  // A lane order without duplicates is unchanged.
  expect(withLaneIdentity([{ id: "x", kind: "custom", label: "reviewer" }]).map(laneName)).toEqual(["reviewer"]);
});

test("a lane's context line joins only its main call source; side calls stay unconnected", () => {
  const points = [
    { span: "s1", lane: "gp", start_ms: 1, tokens: 60000 }, { span: "s2", lane: "gp", start_ms: 2, tokens: 70000 },
    { span: "h1", lane: "gp", start_ms: 3, tokens: 1000 }, { span: "s3", lane: "gp", start_ms: 4, tokens: 80000 },
    { span: "m1", lane: "main", start_ms: 0, tokens: 5000 }, { span: "m2", lane: "main", start_ms: 5, tokens: 6000 },
  ];
  const source = { s1: "agent.builtin.general-purpose", s2: "agent.builtin.general-purpose", s3: "agent.builtin.general-purpose",
    h1: "agent_summary", m1: "repl_main_thread", m2: null };
  const lines = contextLines(points, (id) => source[id] ?? null);
  expect(lines.get("gp").line.map((p) => p.span)).toEqual(["s1", "s2", "s3"]);
  expect([...lines.get("gp").side]).toEqual(["h1"]);
  expect(lines.get("gp").source).toBe("agent.builtin.general-purpose");
  // A tie keeps the source of the lane's first call; an unknown source is its own group.
  expect(lines.get("main").line.map((p) => p.span)).toEqual(["m1"]);
  expect([...lines.get("main").side]).toEqual(["m2"]);
  // Without sources (Codex) every point of a lane is on its line.
  expect(contextLines(points, () => null).get("gp").line).toHaveLength(4);
});
