import test from "node:test";
import assert from "node:assert/strict";
import { claudeCallKeySql, claudeTurnKeySql, turnsBackfillSql, turnsSchemaSql, turnsTransform } from "./sessionTurnsSchema.js";

const SEQ = "l.LogAttributes['event.sequence']";
const RECORD = "concat('r:', toString(l.Timestamp), ':', toString(cityHash64(toString(mapSort(l.LogAttributes)))))";
const SEQ_KEY = `concat('s:', ${SEQ}, ':', toString(l.Timestamp))`;

test("claude key builders match the existing sessionTurns keys", () => {
  assert.equal(claudeTurnKeySql("l."),
    `multiIf(l.PromptId != '', concat('p:', l.PromptId), ${SEQ} != '', ${SEQ_KEY}, ${RECORD})`);
  assert.equal(claudeCallKeySql("l."), `if(${SEQ} != '', ${SEQ_KEY}, ${RECORD})`);
  assert.doesNotMatch(claudeTurnKeySql("") + claudeCallKeySql(""), /l\./);
});

test("schema uses aggregating engine and log retention", () => {
  const local = turnsSchemaSql(), replicated = turnsSchemaSql({ replicated: true });
  assert.ok(local.includes("ENGINE = AggregatingMergeTree()"));
  assert.ok(local.includes("TTL hour + INTERVAL 90 DAY DELETE"));
  assert.ok(local.includes("ORDER BY (Client, SessionId, hour, Kind, Model, UserIdentity)"));
  assert.ok(replicated.includes("ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/session_turns_v1', '{replica}')"));
  assert.ok(replicated.includes("ON CLUSTER 'replicated'"));
  assert.ok(replicated.includes("hour + INTERVAL 45 DAY TO VOLUME 'cold'"));
  assert.ok(replicated.includes("storage_policy = 'hot_cold'"));
  assert.ok(local.includes("DEFINER = CURRENT_USER SQL SECURITY DEFINER"));
});

test("transform covers both clients", () => {
  const sql = turnsTransform();
  for (const part of ["'codex.user_prompt'", "'claude_code.api_request'", "'claude_code.user_prompt'",
    "uniqExactState(cityHash64(", "SessionId != ''", "LogAttributes['conversation.id']"])
    assert.ok(sql.includes(part), part);
});

test("backfill is bounded to one day", () => {
  const sql = turnsBackfillSql();
  assert.ok(sql.includes("dateDiff('second', {backfillFrom:DateTime('UTC')}, {backfillTo:DateTime('UTC')}) > 86400"));
  assert.ok(sql.includes("Timestamp >= {backfillFrom:DateTime('UTC')} AND Timestamp < {backfillTo:DateTime('UTC')}"));
  assert.ok(sql.includes("Session turns backfill requires a positive interval of at most one day"));
});
