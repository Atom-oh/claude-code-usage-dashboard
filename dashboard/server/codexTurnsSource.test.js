import test from "node:test";
import assert from "node:assert/strict";
import { codexTurnSql } from "./taskTraces.js";
import {
  TURN_LOOKBACK_MS, parseCodexTurnsReadFrom, rollupHasTurn, rollupOwnerSql, rollupTurnSql,
  turnIdMs, turnsSourceForList, turnsSourceForTurn,
} from "./codexTurnsSource.js";

const HOUR = 3600000, DAY = 24 * HOUR;
const boundary = new Date("2026-10-01T00:00:00Z");
const from = new Date("2026-10-20T00:00:00Z"), to = new Date("2026-10-21T00:00:00Z");
const q = { userExact: "synthetic@example.test" };
const v7 = ms => { const hex = ms.toString(16).padStart(12, "0"); return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`; };

test("CODEX_TURNS_READ_FROM is a verified hour-aligned UTC timestamp", () => {
  assert.equal(parseCodexTurnsReadFrom(undefined), null);
  assert.equal(parseCodexTurnsReadFrom(""), null);
  assert.equal(+parseCodexTurnsReadFrom("2026-10-01T05:00:00Z"), Date.parse("2026-10-01T05:00:00Z"));
  for (const bad of ["2026-10-01", "2026-10-01T05:00:00.000Z", "2026-10-01T05:00:00+00:00", 5, "2026-02-31T05:00:00Z"])
    assert.throws(() => parseCodexTurnsReadFrom(bad), /CODEX_TURNS_READ_FROM/);
  for (const misaligned of ["2026-10-01T05:30:00Z", "2026-10-01T05:00:01Z"])
    assert.throws(() => parseCodexTurnsReadFrom(misaligned), /hour-aligned/);
});

test("the list uses the rollup only when its 7-day lookback is inside the verified range", () => {
  assert.equal(TURN_LOOKBACK_MS, 7 * DAY);
  assert.equal(turnsSourceForList(from, null), "raw");
  assert.equal(turnsSourceForList(from, boundary), "rollup");
  assert.equal(turnsSourceForList(new Date(+boundary + 7 * DAY), boundary), "rollup");
  assert.equal(turnsSourceForList(new Date(+boundary + 7 * DAY - 1), boundary), "raw");
  assert.equal(turnsSourceForList(new Date(+boundary - DAY), boundary), "raw");
});

test("a detail uses the rollup only for a plausible UUIDv7 id at or after the boundary", () => {
  const page = { from, to };
  const at = ms => v7(Date.parse("2026-10-20T12:00:00Z") + ms);
  assert.equal(turnsSourceForTurn(at(0), null, page), "raw");
  assert.equal(turnsSourceForTurn(at(0), boundary, page), "rollup");
  assert.equal(turnsSourceForTurn(at(0), boundary), "raw", "no page: not provably plausible");
  for (const id of ["auto-compact-3", "", "5b1c2d3e-4f50-4a61-8b72-0c1d2e3f4a5b", undefined, null])
    assert.equal(turnsSourceForTurn(id, boundary, page), "raw", String(id));
  assert.equal(turnsSourceForTurn(v7(+from - 7 * DAY), boundary, page), "rollup");
  assert.equal(turnsSourceForTurn(v7(+from - 7 * DAY - 1), boundary, page), "raw");
  assert.equal(turnsSourceForTurn(v7(+to + DAY), boundary, page), "rollup");
  assert.equal(turnsSourceForTurn(v7(+to + DAY + 1), boundary, page), "raw");
  assert.equal(turnsSourceForTurn(v7(Date.parse("2026-09-30T23:59:59Z")), boundary,
    { from: new Date("2026-10-02T00:00:00Z"), to: new Date("2026-10-03T00:00:00Z") }), "raw", "before the boundary");
  assert.equal(turnIdMs(v7(1234567890123)), 1234567890123);
  assert.equal(turnIdMs("auto-compact-3"), null);
});

test("a detail falls back to raw when the rollup has no row for the id", () => {
  assert.equal(rollupHasTurn([{ turn_id: "a" }], "a"), true);
  assert.equal(rollupHasTurn([{ turn_id: "b" }], "a"), false);
  assert.equal(rollupHasTurn([], "a"), false);
});

test("rollup rows carry codexTurnSql's columns plus spawn calls and the version rule", () => {
  const rollup = rollupTurnSql(from, to, q);
  const raw = codexTurnSql(from, to, q);
  const rawNames = ["turn_id", "in_bucket", "conversation_id", "started_at", "start_ms", "end_ms", "sampling_calls",
    "legacy_calls", "sampling_tries", "compactions", "app_version", "llm_calls", "sampling_span", "models"];
  assert.deepEqual(rawNames.filter(name => !new RegExp(`\\bAS ${name}\\b|^SELECT ${name},`, "m").test(raw.sql)), []);
  for (const name of [...rawNames, "spawn_calls", "names_turn"])
    assert.match(rollup.sql, new RegExp(`\\bAS ${name}\\b|SELECT ${name},|\\b${name},\\s`), name);
  assert.match(rollup.sql, /uniqExactMerge\(SpawnCalls\) AS spawn_calls/);
  assert.match(rollup.sql, /max\(NamesTurnOnTools\) AS names_turn/);
  assert.doesNotMatch(rollup.sql, /namesTurnOnTools|AppVersion[^)]*>=|otel_traces/);
});

test("rollup reads bind the owner and every value", () => {
  const { sql, params } = rollupTurnSql(from, to, q, { conversationId: "conv-a", turnId: "t-1",
    startFrom: 1000, startTo: 2000, hourFrom: new Date("2026-10-20T05:00:00Z") });
  assert.equal(params.userExact, q.userExact);
  assert.match(sql, /UserIdentity = \{userExact:String\}/);
  assert.match(sql, /TurnId = \{turnId:String\}/);
  assert.match(sql, /\{conversationId:String\}/);
  assert.match(sql, /\{startFrom:Int64\}/);
  assert.match(sql, /\{startTo:Int64\}/);
  assert.equal(params.turnId, "t-1");
  assert.equal(params.conversationId, "conv-a");
  assert.equal(params.startFrom, 1000);
  assert.equal(params.startTo, 2000);
  assert.equal(params.hourFrom, "2026-10-20 05:00:00");
  assert.doesNotMatch(sql, /synthetic@example|conv-a|t-1/);
  assert.match(sql, /GROUP BY TurnId/);
  assert.match(sql, /LIMIT 5001/);
  const many = rollupTurnSql(from, to, q, { conversationIds: ["c1", "c2"] });
  assert.match(many.sql, /\{conversationIds:Array\(String\)\}/);
  assert.deepEqual(many.params.conversationIds, ["c1", "c2"]);
});

test("the default hour range is the list lookback; a v7 id pins its own hour", () => {
  const list = rollupTurnSql(from, to, q);
  assert.equal(list.params.hourFrom, "2026-10-13 00:00:00");
  assert.equal(list.params.hourTo, "2026-10-22 00:00:00");
  const id = v7(Date.parse("2026-10-20T12:34:56Z"));
  const detail = rollupTurnSql(from, to, q, { turnId: id });
  assert.equal(detail.params.hourFrom, "2026-10-20 12:00:00");
  assert.equal(detail.params.hourTo, "2026-10-20 13:00:00");
  const explicit = rollupTurnSql(from, to, q, { turnId: id, hourFrom: new Date("2026-10-20T12:00:00Z") });
  assert.equal(explicit.params.hourTo, "2026-10-22 00:00:00");
});

test("a read over an hour range also merges the id-hour row of a UUIDv7 turn keyed before it", () => {
  // A span starting over 7 days after its v7 id keeps its own hour, so a turn's later rows can lie
  // in the range while its id-hour row (and true start) lies before it. Every read over a range
  // looks that row up by (TurnHour, TurnId), owner bound, so such a turn merges whole.
  const list = rollupTurnSql(from, to, q);
  const range = "TurnHour >= {hourFrom:DateTime} AND TurnHour < {hourTo:DateTime}";
  assert.ok(list.sql.split(range).length - 1 >= 2, "the range bounds both the rows and the id-hour lookup");
  assert.match(list.sql, /\(TurnHour, TurnId\) IN \(/);
  assert.match(list.sql, /match\(TurnId, '\^\[0-9a-fA-F\]\{8\}-/);
  assert.ok(list.sql.split("UserIdentity = {userExact:String}").length - 1 >= 2, "the lookup is owner bound");
  assert.doesNotMatch(list.sql, /synthetic@example/);
  for (const options of [{ conversationIds: ["c1"], hourFrom: new Date("2026-10-01T00:00:00Z") },
    { conversationId: "c1", startFrom: 1, startTo: 2, hourFrom: new Date("2026-10-01T00:00:00Z") },
    { conversationId: "c1", turnId: v7(Date.parse("2026-10-20T12:34:56Z")), hourFrom: new Date("2026-10-13T12:00:00Z") }])
    assert.match(rollupTurnSql(from, to, q, options).sql, /\(TurnHour, TurnId\) IN \(/, JSON.stringify(options));
  // Pinned to one id hour: that row is the read.
  const pinned = rollupTurnSql(from, to, q, { turnId: v7(Date.parse("2026-10-20T12:34:56Z")) });
  assert.doesNotMatch(pinned.sql, /\(TurnHour, TurnId\) IN/);
});

test("the owner read is keyed by the id's hour, without a user filter", () => {
  const id = v7(Date.parse("2026-10-20T12:34:56Z"));
  const { sql, params } = rollupOwnerSql(id);
  assert.deepEqual(params, { turnId: id, turnHour: "2026-10-20 12:00:00" });
  assert.match(sql, /TurnHour = \{turnHour:DateTime\}/);
  assert.match(sql, /TurnId = \{turnId:String\}/);
  assert.match(sql, /LIMIT 2/);
  assert.doesNotMatch(sql, /userExact/);
  assert.throws(() => rollupOwnerSql("auto-compact-3"), /UUIDv7/);
  assert.throws(() => rollupOwnerSql("ffffffff-ffff-7fff-bfff-ffffffffffff"), /representable/);
  const garbage = rollupTurnSql(from, to, q, { turnId: "ffffffff-ffff-7fff-bfff-ffffffffffff" });
  assert.equal(garbage.params.hourFrom, "2026-10-13 00:00:00", "an unrepresentable id hour uses the default range");
});
