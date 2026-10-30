import { test } from "node:test";
import assert from "node:assert/strict";
import { foldSessionTurns, SESSION_TURNS_TOP } from "./sessionTurns.js";

const row = (session, user, group, model, reported_cost, input_tokens, cost_counter_rows, observed_usage_rows) => ({
  session, user, group, model, reported_cost, input_tokens, output_tokens: "0", cache_read_tokens: "0",
  cache_write_tokens: "0", cost_counter_rows, observed_usage_rows });
const log = (session, user, group, turns, model_calls, started) => ({ session, user, group, turns, model_calls, started });
const A = "a@example.invalid", B = "b@example.invalid", C = "c@example.invalid", D = "d@example.invalid";
const COUNTERS = [
  row("s1", A, "enterprise", "claude-sonnet-5", "0.5", "60", "2", "4"),
  row("s2", A, "enterprise", "claude-sonnet-5", "0.25", "40", "1", "2"),
  row("s3", B, "enterprise", "claude-sonnet-5", "0.75", "80", "1", "2"),
  row("s5", C, "bedrock", "claude-sonnet-5", "0", "20", "0", "1"),
  row("s7", C, "enterprise", "claude-sonnet-5", "0.125", "10", "1", "2"),
  row("s7", C, "enterprise", "claude-haiku-5-5", "0", "30", "0", "1"),
  row("s9", D, "enterprise", "claude-sonnet-5", "0", "0", "1", "1"),
  row("s10", D, "enterprise", "claude-sonnet-5", "0", "0", "0", "1"),
];
const LOGS = [
  log("s1", A, "enterprise", "3", "5", "2026-10-20T10:01:00Z"),
  log("s2", A, "enterprise", "1", "2", "2026-10-20T10:05:00Z"),
  log("s4", B, "enterprise", "2", "0", "2026-10-20T10:07:00Z"),
  log("s5", C, "bedrock", "1", "1", "2026-10-20T10:09:00Z"),
  log("s7", C, "enterprise", "3", "3", "2026-10-20T10:10:00Z"),
  log("s9", D, "enterprise", "2", "2", "2026-10-20T10:20:00Z"),
  log("s10", D, "enterprise", "1", "1", "2026-10-20T10:30:00Z"),
];

test("empty input has unavailable ratios, not zeros", () => {
  const empty = {
    summary: { sessions: 0, sessions_with_turns: 0, turns: 0, median_turns_per_session: null, p90_turns_per_session: null,
      known_cost: null, cost_partial: false, cost_per_turn: null, model_calls_per_turn: null,
      sessions_without_turns: 0, sessions_cost_unavailable: 0 },
    users: [], sessions: [],
  };
  assert.deepEqual(foldSessionTurns([], []), empty);
  assert.deepEqual(foldSessionTurns(undefined, undefined), empty);
});

test("summary counts excluded sessions and ratios use eligible sessions only", () => {
  // s3 has cost but no turns; s4 (logs only), s5 (tokens without a cost counter) and s10 (no in-window cost counter) are unavailable and excluded from cost per turn, while model calls per turn includes every session with turns.
  assert.deepEqual(foldSessionTurns(COUNTERS, LOGS).summary, {
    sessions: 8, sessions_with_turns: 7, turns: 13, median_turns_per_session: 2, p90_turns_per_session: 3,
    known_cost: 1.625, cost_partial: true, cost_per_turn: 0.875 / 9, model_calls_per_turn: 14 / 13,
    sessions_without_turns: 1, sessions_cost_unavailable: 3,
  });
});

test("users fold known costs and flag excluded or partial sessions", () => {
  assert.deepEqual(foldSessionTurns(COUNTERS, LOGS).users, [
    { user: A, sessions: 2, turns: 4, known_cost: 0.75, cost_partial: false, cost_per_turn: 0.75 / 4, cost_per_session: 0.375 },
    { user: B, sessions: 2, turns: 2, known_cost: 0.75, cost_partial: true, cost_per_turn: null, cost_per_session: 0.75 },
    { user: C, sessions: 2, turns: 4, known_cost: 0.125, cost_partial: true, cost_per_turn: 0.125 / 3, cost_per_session: 0.125 },
    { user: D, sessions: 2, turns: 3, known_cost: 0, cost_partial: true, cost_per_turn: 0, cost_per_session: 0 },
  ]);
});

test("sessions keep measured zero, partial and unavailable costs", () => {
  assert.deepEqual(foldSessionTurns(COUNTERS, LOGS).sessions, [
    { session: "s3", user: B, group: "enterprise", started: null, turns: 0, model_calls: 0, known_cost: 0.75, cost_partial: false, cost_per_turn: null },
    { session: "s1", user: A, group: "enterprise", started: "2026-10-20T10:01:00Z", turns: 3, model_calls: 5, known_cost: 0.5, cost_partial: false, cost_per_turn: 0.5 / 3 },
    { session: "s2", user: A, group: "enterprise", started: "2026-10-20T10:05:00Z", turns: 1, model_calls: 2, known_cost: 0.25, cost_partial: false, cost_per_turn: 0.25 },
    { session: "s7", user: C, group: "enterprise", started: "2026-10-20T10:10:00Z", turns: 3, model_calls: 3, known_cost: 0.125, cost_partial: true, cost_per_turn: 0.125 / 3 },
    { session: "s9", user: D, group: "enterprise", started: "2026-10-20T10:20:00Z", turns: 2, model_calls: 2, known_cost: 0, cost_partial: false, cost_per_turn: 0 },
    { session: "s4", user: B, group: "enterprise", started: "2026-10-20T10:07:00Z", turns: 2, model_calls: 0, known_cost: null, cost_partial: false, cost_per_turn: null },
    { session: "s10", user: D, group: "enterprise", started: "2026-10-20T10:30:00Z", turns: 1, model_calls: 1, known_cost: null, cost_partial: false, cost_per_turn: null },
    { session: "s5", user: C, group: "bedrock", started: "2026-10-20T10:09:00Z", turns: 1, model_calls: 1, known_cost: null, cost_partial: false, cost_per_turn: null },
  ]);
});

test("turn quantiles use the middle-pair median and nearest-rank p90", () => {
  const q = (ns) => foldSessionTurns([], ns.map((n, i) => log(`q${i}`, "", "enterprise", String(n), "0", null))).summary;
  const even = q([4, 1, 3, 2]);
  assert.equal(even.median_turns_per_session, 2.5);
  assert.equal(even.p90_turns_per_session, 4);
  const ten = q([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(ten.median_turns_per_session, 5.5);
  assert.equal(ten.p90_turns_per_session, 9);
  assert.equal(even.known_cost, null);
  assert.equal(even.sessions_cost_unavailable, 4);
});

test("top lists keep the configured limit", () => {
  const many = Array.from({ length: 25 }, (_, i) => row(`m${i}`, `u${String(i).padStart(2, "0")}@example.invalid`, "enterprise", "claude-sonnet-5", String(i + 1), "1", "1", "1"));
  const out = foldSessionTurns(many, []);
  assert.equal(out.users.length, SESSION_TURNS_TOP);
  assert.equal(out.users[0].user, "u24@example.invalid");
  assert.equal(out.users[19].user, "u05@example.invalid");
  assert.equal(out.sessions.length, 20);
  assert.equal(out.sessions[0].session, "m24");
  assert.deepEqual(foldSessionTurns(many, [], { limit: 5 }).sessions.map((s) => s.session), ["m24", "m23", "m22", "m21", "m20"]);
});

test("equal costs order by turns, then id", () => {
  const counters = ["x2", "x1", "x3"].map((id) => row(id, "t@example.invalid", "enterprise", "m", "1", "1", "1", "1"));
  const logs = [log("x3", "t@example.invalid", "enterprise", "2", "0", null)];
  assert.deepEqual(foldSessionTurns(counters, logs).sessions.map((s) => s.session), ["x3", "x1", "x2"]);
});

test("a partial session cost marks its user partial without exclusions", () => {
  const result = foldSessionTurns(
    [row("p1", "p@example.invalid", "enterprise", "claude-sonnet-5", "0.5", "10", "1", "1"),
     row("p1", "p@example.invalid", "enterprise", "claude-haiku-5-5", "0", "30", "0", "1")],
    [log("p1", "p@example.invalid", "enterprise", "2", "4", null)]);
  assert.equal(result.summary.cost_partial, true);
  assert.equal(result.summary.sessions_cost_unavailable, 0);
  assert.equal(result.summary.known_cost, 0.5);
  assert.deepEqual(result.users, [
    { user: "p@example.invalid", sessions: 1, turns: 2, known_cost: 0.5, cost_partial: true, cost_per_turn: 0.25, cost_per_session: 0.5 },
  ]);
});

test("model calls per turn ignores sessions without observed turns", () => {
  const { summary } = foldSessionTurns([], [
    log("m1", "m@example.invalid", "enterprise", "2", "3", null),
    log("m2", "m@example.invalid", "enterprise", "0", "5", null)]);
  assert.equal(summary.model_calls_per_turn, 1.5);
  assert.equal(summary.sessions, 2);
  assert.equal(summary.sessions_without_turns, 1);
});
