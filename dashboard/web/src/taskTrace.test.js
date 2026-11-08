import { expect, test } from "vitest";
import { compactCount, cumulativeByLane, iconFor, laneName, laneOrder } from "./taskTrace.js";

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
