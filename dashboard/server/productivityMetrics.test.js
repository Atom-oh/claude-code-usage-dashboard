import { test } from "node:test";
import assert from "node:assert/strict";
import { permissionOccupancy, PERMISSION_SPAN_LIMIT } from "./productivityMetrics.js";
import { activityDensitySql, toolOutcomesSql } from "./queries.js";

const span = (span_id, span_type, start_ms, duration_ms, overrides = {}) => ({
  group: "bedrock", trace_id: "trace", session_id: "session", span_id, span_type, start_ms, duration_ms, ...overrides,
});
const interaction = (overrides = {}) => span("root", "interaction", 100, 100, overrides);
const wait = (id, start, duration, overrides = {}) => span(id, "tool.blocked_on_user", start, duration, overrides);

test("permission occupancy unions nested and overlapping waits, deduplicates exports, and clips to the interaction", () => {
  const rows = [interaction(), wait("first", 90, 40), wait("overlap", 110, 50),
    wait("nested", 120, 10), wait("last", 180, 80), wait("first", 90, 40)];
  const [result] = permissionOccupancy(rows, 0, 1000).rows;
  assert.equal(result.blocked_ms, 80);
  assert.equal(result.interaction_ms, 100);
  assert.equal(result.blocked_share, 0.8);
  assert.equal(result.matched_interactions, 1);
});

test("permission occupancy clips the query end and weights by matched interaction time", () => {
  const rows = [interaction(), wait("first", 180, 80),
    interaction({ trace_id: "second", start_ms: 200, duration_ms: 200 }),
    wait("second", 220, 100, { trace_id: "second" })];
  const [result] = permissionOccupancy(rows, 0, 250).rows;
  assert.equal(result.blocked_ms, 50);
  assert.equal(result.interaction_ms, 150);
  assert.equal(result.blocked_share, 1 / 3);
});

test("missing waits remain unavailable, while an explicit zero duration is observed zero", () => {
  const missing = permissionOccupancy([interaction()], 0, 1000);
  assert.equal(missing.unsupported, false);
  assert.equal(missing.rows[0].blocked_share, null);
  assert.equal(missing.rows[0].blocked_ms, null);
  assert.equal(missing.rows[0].interaction_ms, null);
  assert.equal(missing.rows[0].coverage, 0);
  const [zero] = permissionOccupancy([interaction(), wait("zero", 120, 0)], 0, 1000).rows;
  assert.equal(zero.blocked_share, 0);
  assert.equal(zero.coverage, 1);
  assert.equal(permissionOccupancy([], 0, 1000).unsupported, true);
});

test("waits never cross session, trace or group boundaries and unmatched roots stay outside the denominator", () => {
  const rows = [interaction(), wait("matched", 120, 20),
    interaction({ span_id: "other", session_id: "other" }),
    wait("wrong-session", 120, 70, { session_id: "unrelated" }),
    wait("wrong-trace", 120, 70, { trace_id: "unrelated" }),
    wait("wrong-group", 120, 70, { group: "enterprise" })];
  const [result] = permissionOccupancy(rows, 0, 1000).rows;
  assert.equal(result.blocked_share, 0.2);
  assert.equal(result.interactions, 2);
  assert.equal(result.coverage, 0.5);
});

test("ambiguous overlapping interactions are excluded instead of double counting their waits", () => {
  const rows = [interaction(), interaction({ span_id: "nested", start_ms: 110, duration_ms: 50 }),
    wait("ambiguous", 120, 20)];
  const [result] = permissionOccupancy(rows, 0, 1000).rows;
  assert.equal(result.ambiguous_interactions, 2);
  assert.equal(result.matched_interactions, 0);
  assert.equal(result.blocked_share, null);
});

test("invalid spans and out-of-window interactions do not manufacture timing", () => {
  for (const overrides of [
    { duration_ms: -1 }, { duration_ms: null }, { duration_ms: Infinity },
    { start_ms: null }, { start_ms: -1 }, { start_ms: 1000 },
    { span_id: "" }, { trace_id: "" }, { session_id: "" },
  ]) {
    assert.equal(permissionOccupancy([interaction(overrides)], 0, 1000).unsupported, true);
  }
});

test("truncated or conflicting spans withhold the entire ratio", () => {
  assert.deepEqual(permissionOccupancy(Array(PERMISSION_SPAN_LIMIT + 1).fill(interaction()), 0, 1000),
    { unsupported: false, limited: true, rows: [] });
  assert.deepEqual(permissionOccupancy([interaction(), interaction({ duration_ms: 200 })], 0, 1000),
    { unsupported: false, limited: true, rows: [] });
});

test("activity density binds filters and keeps observation evidence separate from cumulative lookback", () => {
  const from = new Date("2026-09-14T10:00:00Z");
  const filters = { group: "bedrock", user: "' OR 1=1", model: "claude-sonnet-5" };
  for (const hours of [1, 24]) {
    const to = new Date(+from + hours * 3600000);
    const { sql, params } = activityDensitySql(from, to, filters);
    assert.equal(params.fUser, filters.user);
    assert.equal(params.fModel, filters.model);
    assert.ok(!sql.includes(filters.user));
    assert.match(sql, /GROUP BY "group", m.SessionId, m.UserEmail/);
    assert.match(sql, /has_commits AND has_time AND user_seconds > 0/);
    assert.match(sql, /observed_activity/);
    assert.match(sql, /SeriesKey/);
    assert.match(sql, /if\(temp = 2/);
    assert.match(sql, /nullIf\(user_hours, 0\)/);
  }
});

test("tool outcome SQL excludes unknown outcomes from the success denominator without a top-tool cap", () => {
  const { sql } = toolOutcomesSql(new Date(0), new Date(1000));
  assert.match(sql, /succeeded \/ nullIf\(succeeded \+ failed, 0\)/);
  assert.match(sql, /total - succeeded - failed AS unknown/);
  assert.match(sql, /'tool_result', 'claude_code.tool_result'/);
  assert.doesNotMatch(sql, /LIMIT/);
});
