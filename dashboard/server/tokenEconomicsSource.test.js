import test from "node:test";
import assert from "node:assert/strict";
import { parseTurnsReadFrom, turnsReadiness, turnsSql } from "./tokenEconomicsSource.js";

const now = new Date("2026-11-11T00:00:00Z");
const boundary = new Date("2026-08-01T00:00:00Z");

test("parseTurnsReadFrom accepts only verified UTC timestamps", () => {
  assert.deepEqual(parseTurnsReadFrom("2026-11-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z"));
  assert.equal(parseTurnsReadFrom(undefined), null);
  assert.equal(parseTurnsReadFrom(""), null);
  assert.throws(() => parseTurnsReadFrom("2026-11-01"), /SESSION_TURNS_READ_FROM must be a verified UTC timestamp/);
  assert.throws(() => parseTurnsReadFrom("2026-02-31T00:00:00Z"), /SESSION_TURNS_READ_FROM is not a valid UTC timestamp/);
});

test("turnsReadiness reports not_backfilled before retention", () => {
  assert.equal(turnsReadiness(new Date("2026-11-04T00:00:00Z"), now, null), "not_backfilled");
  assert.equal(turnsReadiness(new Date("2026-10-31T23:00:00Z"), now, new Date("2026-11-01T00:00:00Z")), "not_backfilled");
  assert.equal(turnsReadiness(new Date("2026-08-12T00:00:00Z"), now, boundary), "retention");
  assert.equal(turnsReadiness(new Date("2026-11-04T00:00:00Z"), now, boundary), null);
  assert.equal(turnsReadiness(new Date("2026-11-01T00:00:00Z"), now, new Date("2026-11-01T00:00:00Z")), null);
});

test("turnsSql groups hour and window rows with bound params only", () => {
  const sql = turnsSql();
  assert.match(sql, /GROUPING SETS/);
  assert.match(sql, /uniqExactMerge\(Keys\)/);
  assert.match(sql, /FROM session_turns_v1/);
  assert.match(sql, /PREWHERE hour >= \{from:DateTime\} AND hour < \{to:DateTime\}/);
  assert.match(sql, /\{bucketSeconds:UInt32\}/);
  assert.match(sql, /Client IN \{clients:Array\(String\)\}/);
  assert.match(sql, /\{clientUser:String\} = '' OR positionCaseInsensitive\(UserIdentity, \{clientUser:String\}\) > 0/);
  assert.match(sql, /\{clientUserExact:String\} = '' OR UserIdentity = \{clientUserExact:String\}/);
  assert.doesNotMatch(sql, /\$\{|undefined/);
});
