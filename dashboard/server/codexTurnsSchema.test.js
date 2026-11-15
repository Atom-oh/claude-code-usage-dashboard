import test from "node:test";
import assert from "node:assert/strict";
import {
  TURNS_ROLLUP_COLUMNS, TURNS_ROLLUP_TABLE, codexTurnsBackfillSql, codexTurnsSchemaSql,
  codexTurnSpans, codexTurnsTransform, codexTurnsVerifySql, namesTurnOnToolsSql, turnHourSql, turnHourMs,
  TURN_ID_MAX_AGE_MS, TURN_ID_MAX_LEAD_MS,
} from "./codexTurnsSchema.js";
import { TURN_SPAN } from "./taskTraces.js";
import { SPAWN_SPANS } from "./codexAgents.js";

const FROM = "{backfillFrom:DateTime('UTC')}", TO = "{backfillTo:DateTime('UTC')}";
const VFROM = "{verifyFrom:DateTime('UTC')}", VTO = "{verifyTo:DateTime('UTC')}";

test("table columns are the spec's turn row plus the retry, compaction, spawn and version columns", () => {
  assert.equal(TURNS_ROLLUP_TABLE, "codex_turns_v1");
  assert.deepEqual(TURNS_ROLLUP_COLUMNS, [
    ["TurnHour", "DateTime"], ["UserIdentity", "String"], ["TurnId", "String"],
    ["Conversations", "AggregateFunction(groupUniqArray, String)"],
    ["StartTs", "SimpleAggregateFunction(min, DateTime64(9))"],
    ["EndTs", "SimpleAggregateFunction(max, DateTime64(9))"],
    ["SamplingSpans", "AggregateFunction(uniqExact, UInt64)"],
    ["LegacySpans", "AggregateFunction(uniqExact, UInt64)"],
    ["SamplingModels", "AggregateFunction(groupUniqArray, String)"],
    ["LegacyModels", "AggregateFunction(groupUniqArray, String)"],
    ["SamplingTries", "AggregateFunction(uniqExact, UInt64)"],
    ["Compactions", "AggregateFunction(uniqExact, UInt64)"],
    ["SpawnCalls", "AggregateFunction(uniqExact, UInt64)"],
    ["NamesTurnOnTools", "SimpleAggregateFunction(max, UInt8)"],
    ["AppVersion", "SimpleAggregateFunction(max, String)"],
  ]);
});

test("DDL has the spec's engine, partition, order, retention and storage policy", () => {
  const local = codexTurnsSchemaSql(), replicated = codexTurnsSchemaSql({ replicated: true });
  for (const sql of [local, replicated]) {
    assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS claude_code.codex_turns_v1"));
    assert.ok(sql.includes("PARTITION BY toYYYYMM(TurnHour)"));
    assert.ok(sql.includes("ORDER BY (UserIdentity, TurnHour, TurnId)"));
    assert.ok(sql.includes("TurnHour + INTERVAL 90 DAY DELETE"));
    assert.ok(sql.includes("CREATE MATERIALIZED VIEW IF NOT EXISTS claude_code.codex_turns_v1_mv"));
    assert.ok(sql.includes("TO claude_code.codex_turns_v1\n"));
    assert.ok(sql.includes("DEFINER = CURRENT_USER SQL SECURITY DEFINER"));
  }
  assert.ok(local.includes("ENGINE = AggregatingMergeTree()"));
  assert.doesNotMatch(local, /ON CLUSTER|TO VOLUME|storage_policy/);
  assert.ok(replicated.includes("ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/codex_turns_v1', '{replica}')"));
  assert.ok(replicated.includes("TTL TurnHour + INTERVAL 45 DAY TO VOLUME 'cold',\n  TurnHour + INTERVAL 90 DAY DELETE"));
  assert.ok(replicated.includes("SETTINGS storage_policy = 'hot_cold'"));
  assert.equal(replicated.match(/ON CLUSTER 'replicated'/g).length, 2);
});

test("view takes Codex turn spans and keys every count by span id", () => {
  const sql = codexTurnsTransform();
  for (const part of [
    "FROM claude_code.otel_traces", "ResourceAttributes['client'] = 'codex'", TURN_SPAN,
    "coalesce(nullIf(SpanAttributes['turn_id'], ''), SpanAttributes['turn.id'])",
    "coalesce(nullIf(ResourceAttributes['user.email'], ''), nullIf(ResourceAttributes['enduser.id'], ''), '')",
    "coalesce(nullIf(SpanAttributes['model'], ''), SpanAttributes['gen_ai.request.model'])",
    "SpanAttributes['conversation.id']", "ResourceAttributes['service.version']",
    "cityHash64(TraceId, SpanId)", "intDiv(Duration, 1000000)",
    "groupUniqArrayStateIf(turn_conversation, turn_conversation != '') AS Conversations",
    "uniqExactStateIf(span_key, SpanName = 'codex.sampling') AS SamplingSpans",
    "uniqExactStateIf(span_key, SpanName = 'run_sampling_request') AS LegacySpans",
    "uniqExactStateIf(span_key, SpanName = 'try_run_sampling_request') AS SamplingTries",
    "uniqExactStateIf(span_key, SpanName = 'codex.compaction') AS Compactions",
    `uniqExactStateIf(span_key, SpanName IN (${SPAWN_SPANS.map(name => `'${name}'`).join(", ")})) AS SpawnCalls`,
    "max(span_names_turn) AS NamesTurnOnTools", "maxIf(span_version, span_version != '') AS AppVersion",
    "WHERE TurnId != ''", "GROUP BY TurnHour, UserIdentity, TurnId",
  ]) assert.ok(sql.includes(part), part);
  // Raw `LIMIT 1 BY TraceId, SpanId` is reproduced by span-keyed sets, never by row counts.
  assert.doesNotMatch(sql, /count(If)?\(|LIMIT/);
  assert.doesNotMatch(codexTurnsSchemaSql(), /\{[a-zA-Z]+:/);
});

test("turn hour comes from a plausible UUIDv7 id, else from the span", () => {
  const sql = turnHourSql("t.id", "t.ts");
  assert.ok(sql.includes("match(t.id, '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')"));
  assert.ok(sql.includes("unhex(concat(substring(t.id, 1, 8), substring(t.id, 10, 4)))"));
  // The id time is used only within [span - 7 days, span + 1 day]; the choice is made on integer
  // milliseconds and converted once, so no 48-bit id time can wrap a DateTime.
  assert.ok(sql.includes("toUnixTimestamp64Milli(t.ts)"));
  assert.ok(sql.includes(`>= toUnixTimestamp64Milli(t.ts) - ${TURN_ID_MAX_AGE_MS}`));
  assert.ok(sql.includes(`<= toUnixTimestamp64Milli(t.ts) + ${TURN_ID_MAX_LEAD_MS}`));
  assert.equal(sql.match(/toDateTime\(/g).length, 1);
  assert.equal(TURN_ID_MAX_AGE_MS, 7 * 24 * 3600000);
  assert.equal(TURN_ID_MAX_LEAD_MS, 24 * 3600000);

  const id = "01a14f6d-7899-7a83-8000-000000000000", idMs = Date.parse("2026-10-18T14:32:16.793Z");
  const iso = ms => ms === null ? null : new Date(ms).toISOString();
  // Without a span time (a detail from its id alone) a v7 id gives its own hour.
  assert.equal(iso(turnHourMs(id)), "2026-10-18T14:00:00.000Z");
  assert.equal(iso(turnHourMs(id.toUpperCase())), "2026-10-18T14:00:00.000Z");
  // Plausible: the span starts up to 1 day before or up to 7 days after the id time.
  for (const span of [idMs, idMs - 24 * 3600000, idMs + 7 * 24 * 3600000, idMs - 60000])
    assert.equal(iso(turnHourMs(id, span)), "2026-10-18T14:00:00.000Z", iso(span));
  // Implausible: the span's own hour.
  assert.equal(iso(turnHourMs(id, idMs - 24 * 3600000 - 1)), "2026-10-17T14:00:00.000Z");
  assert.equal(iso(turnHourMs(id, idMs + 7 * 24 * 3600000 + 1)), "2026-10-25T14:00:00.000Z");
  const span = Date.parse("2026-10-21T09:15:00.123Z");
  for (const garbage of ["ffffffff-ffff-7fff-bfff-ffffffffffff", "00000000-0001-7000-8000-000000000000",
    "7fffffff-ffff-7000-8000-000000000000"]) {
    assert.equal(iso(turnHourMs(garbage, span)), "2026-10-21T09:00:00.000Z", garbage);
  }
  // Without a span time nothing bounds the id: a read keyed by the id alone must bound it itself.
  assert.equal(iso(turnHourMs("00000000-0001-7000-8000-000000000000")), "1970-01-01T00:00:00.000Z");
  // Not a UUIDv7: the span hour, or null without a span.
  for (const other of ["01a14f6d-7899-4a83-8000-000000000000", "auto-compact-7", "", null, undefined,
    "01a14f6d-7899-7a83-8000-00000000000", "01a14f6g-7899-7a83-8000-000000000000"]) {
    assert.equal(turnHourMs(other), null, String(other));
    assert.equal(iso(turnHourMs(other, span)), "2026-10-21T09:00:00.000Z", String(other));
  }
});

test("version rule parses major.minor numerically and ignores pre-release suffixes", () => {
  const sql = namesTurnOnToolsSql("v");
  assert.ok(sql.includes("extractGroups(v, '^(\\\\d+)\\\\.(\\\\d+)')"));
  assert.ok(sql.includes("toFloat64OrZero"));
  assert.ok(sql.includes(">= 166"));
  assert.ok(codexTurnsTransform().includes(`${namesTurnOnToolsSql("span_version")} AS span_names_turn`));
});

test("backfill is bounded to one day and repeats the view's transform", () => {
  const sql = codexTurnsBackfillSql();
  assert.ok(sql.includes(`dateDiff('second', ${FROM}, ${TO}) > 86400`));
  assert.ok(sql.includes(`${TO} <= ${FROM}`));
  assert.ok(sql.includes("'Codex turns backfill requires a positive interval of at most one day'"));
  assert.ok(sql.includes(`INSERT INTO claude_code.codex_turns_v1 (${TURNS_ROLLUP_COLUMNS.map(([name]) => name).join(", ")})`));
  assert.ok(sql.includes(codexTurnsTransform(`Timestamp >= ${FROM} AND Timestamp < ${TO}`)));
});

test("verify compares merged rows with raw spans and keeps clipped turns out of differs", () => {
  const sql = codexTurnsVerifySql();
  const UUID_SQL = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
  assert.doesNotMatch(sql, /NOT clipped AND \(length\(t\.conversations\) > 1/);
  assert.doesNotMatch(sql, /INSERT|ALTER|CREATE|DELETE/);
  // Raw spans of a turn keyed in the window start at most the id lead before it and, on its id
  // hour, at most the id age after it: [verifyFrom - 1 day, verifyTo + 7 days).
  const lead = TURN_ID_MAX_LEAD_MS / 3600000, age = TURN_ID_MAX_AGE_MS / 3600000;
  const raw = `Timestamp >= ${VFROM} - INTERVAL ${lead} HOUR AND Timestamp < ${VTO} + INTERVAL ${age} HOUR`;
  assert.equal(raw, `Timestamp >= ${VFROM} - INTERVAL 24 HOUR AND Timestamp < ${VTO} + INTERVAL 168 HOUR`);
  for (const part of [
    `toStartOfHour(${VFROM}) != ${VFROM}`, `toStartOfHour(${VTO}) != ${VTO}`,
    "'Codex turns verification requires a positive hour-aligned UTC window'",
    raw,
    // A turn has a row in the window; both sides merge its rows from verifyFrom to one id lead
    // past the raw end, so any row holding a span the raw side reads is merged, and one holding
    // later spans ends past it.
    `HAVING min(TurnHour) < ${VTO}`,
    // Clipped from the rollup's end, which reaches past the raw end only when spans do.
    `toUInt8(t_present AND t.end_ts >= ${VTO} + INTERVAL ${age} HOUR) AS clipped`,
    "groupUniqArrayMerge(Conversations)", "uniqExactMerge(SamplingSpans)", "uniqExactMerge(SpawnCalls)",
    // Two conversations block a UUID turn only; a synthetic id groups several conversations and
    // differs only when the conversation sets differ.
    `(match(TurnId, '${UUID_SQL}') AND length(t.conversations) > 1)`, "t.conversations != r.conversations", "FULL OUTER JOIN", "USING (UserIdentity, TurnId)",
    // The version is the largest non-empty one on both sides: deterministic, and empty never wins.
    "max(AppVersion) AS version", "maxIf(span_version, span_version != '') AS version", "t.version != r.version",
  ]) assert.ok(sql.includes(part), part);
  // Output contract: one row per turn; a clipped turn never sets differs unless a side is missing.
  assert.match(sql, /SELECT turn_id, differs, clipped\nFROM \(/);
  assert.match(sql, /AS differs/);
  assert.match(sql, /NOT \(t_present AND r_present\) OR \(NOT clipped AND /);
  // The raw side reads the same span records as the view.
  assert.ok(codexTurnsTransform().includes(codexTurnSpans("1")));
  assert.ok(sql.includes(codexTurnSpans(raw)));
  assert.doesNotMatch(sql, /INTERVAL 1 HOUR|INTERVAL 23 HOUR|r\.end_ts >=/);
  // Both sides group the same turn hours, so a span on the id hour of an earlier turn row never
  // joins a later fragment's row: one predicate, on the rollup rows and on the raw spans' hours.
  const rows = `TurnHour >= ${VFROM} AND TurnHour < ${VTO} + INTERVAL ${age + lead} HOUR`;
  assert.equal(sql.split(`WHERE ${rows}`).length, 2, "rollup rows");
  assert.equal(sql.split(`WHERE TurnId != '' AND ${rows}`).length, 2, "raw spans");
  assert.doesNotMatch(sql, /TurnHour >= \{verifyFrom:DateTime\('UTC'\)\} - /);
});
