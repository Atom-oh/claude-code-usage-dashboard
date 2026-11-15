#!/usr/bin/env node
// Invoked only by the owned, network-isolated schema lifecycle fixture
// (scripts/test-codex-turns-schema.py). Raw Codex turn spans go into otel_traces, the view fills
// codex_turns_v1, and every rollup turn row must equal the raw codexTurnSql row; backfills
// repeated over the same days must not change it, and the generated verify must pass.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TURNS_ROLLUP_TABLE, codexTurnsBackfillSql, codexTurnsSchemaSql, namesTurnOnToolsSql, turnHourSql, turnHourMs,
} from "../dashboard/server/codexTurnsSchema.js";
import { codexTurnSql, namesTurnOnTools } from "../dashboard/server/taskTraces.js";
import { SPAWN_SPANS } from "../dashboard/server/codexAgents.js";

const container = process.argv[2];
if (!/^ccdash-schema-lifecycle-[a-f0-9]+$/.test(container || ""))
  throw new Error("Only the owned schema lifecycle fixture is accepted");
function execute(sql, params = {}, settings = []) {
  return execFileSync("docker", ["exec", "-i",
    "-e", "CLICKHOUSE_PASSWORD=YOUR_SYNTHETIC_SCHEMA_FIXTURE_PASSWORD",
    container, "clickhouse-client", "--user", "otel_writer", "--multiquery",
    "--max_threads=1", "--max_execution_time=30", "--max_memory_usage=800000000", ...settings,
    ...Object.entries(params).map(([key, value]) => `--param_${key}=${value}`)],
  { input: sql, encoding: "utf8", stdio: "pipe", maxBuffer: 32 * 1024 * 1024, timeout: 45000 });
}
const rows = (sql, params = {}, settings = []) => execute(`${sql} FORMAT JSONEachRow`, params, settings)
  .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const root = fileURLToPath(new URL("../", import.meta.url));
const generated = name => readFileSync(root + name, "utf8");
let assertions = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assertions++; };

// Migration 012 requires ledger 004 and otel_traces, as migration 011 does.
const migrationGuards = generated("clickhouse-migration-012.sql").split("CREATE TABLE")[0];
execute(`CREATE DATABASE claude_code;
CREATE TABLE claude_code.schema_migrations (version UInt32, name String, checksum String)
ENGINE = MergeTree ORDER BY version;
INSERT INTO claude_code.schema_migrations VALUES (4, '004-schema-migrations', 'synthetic');`);
assert.throws(() => execute(migrationGuards), /Migration 012 requires otel_traces from migration 002/,
  "migration 012 without otel_traces");
assertions++;
execute(`CREATE TABLE claude_code.otel_traces (
  Timestamp DateTime64(9), TraceId String, SpanId String, SpanName LowCardinality(String),
  ResourceAttributes Map(LowCardinality(String), String), SpanAttributes Map(LowCardinality(String), String),
  Duration Int64,
  UserEmail LowCardinality(String) MATERIALIZED ResourceAttributes['user.email'],
  EndUserId LowCardinality(String) MATERIALIZED ResourceAttributes['enduser.id']
) ENGINE = MergeTree ORDER BY (SpanName, Timestamp);`);
execute(migrationGuards);
execute(codexTurnsSchemaSql());
execute(`ALTER TABLE claude_code.${TURNS_ROLLUP_TABLE} REMOVE TTL`);
// Physical-row checks below need the inserts' parts unmerged; merges restart before OPTIMIZE.
execute(`SYSTEM STOP MERGES claude_code.${TURNS_ROLLUP_TABLE}`);

// --- Turn hour and version rules: SQL equals the JS rule the reads use. ---
const BRIEF_ID = "01a14f6d-7899-7a83-8000-000000000001";
const ids = [BRIEF_ID, "01A14F6D-7899-7A83-8000-000000000001", "01a14f6d-7899-4a83-8000-000000000001",
  "auto-compact-7", "", "01a14f6d-7899-7a83-8000-00000000000", "01a14f6g-7899-7a83-8000-000000000000",
  "019a0000-0000-7000-8000-000000000000",
  // Garbage v7 times (48-bit maximum, 1970, year ~6400) and v7 times just inside and outside
  // [span - 7 days, span + 1 day] of the span below.
  "ffffffff-ffff-7fff-bfff-ffffffffffff", "00000000-0001-7000-8000-000000000000", "7fffffff-ffff-7000-8000-000000000000",
  ...[-7 * 24 * 3600000, -7 * 24 * 3600000 - 1, 24 * 3600000, 24 * 3600000 + 1].map(offset => {
    const hex = (Date.parse("2026-10-21T09:15:00.123Z") + offset).toString(16).padStart(12, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`;
  })];
const spanTs = "2026-10-21 09:15:00.123456789";
const hours = rows(`SELECT id, toString(${turnHourSql("id", "ts")}) AS hour
  FROM (SELECT arrayJoin({ids:Array(String)}) AS id, toDateTime64('${spanTs}', 9) AS ts)`,
{ ids: JSON.stringify(ids).replaceAll('"', "'") });
check(Object.fromEntries(hours.map(r => [r.id, r.hour])), Object.fromEntries(ids.map(id => {
  const hour = new Date(turnHourMs(id, Date.parse("2026-10-21T09:15:00.123Z")));
  return [id, hour.toISOString().slice(0, 19).replace("T", " ")];
})), "turnHourSql equals turnHourMs for the same span");
// Five non-v7 ids, a 2025 id, three garbage times and the two just outside the range.
check(hours.filter(r => r.hour === "2026-10-21 09:00:00").length, 11, "garbage, non-v7 and out-of-range ids use the span hour");
check(hours.find(r => r.id === BRIEF_ID).hour, "2026-10-18 14:00:00", "brief UUIDv7 id hour");
const versions = ["0.163.0", "0.165.9", "0.166.0", "0.169.0", "0.169.0-alpha.1", "0.1660.0", "00.166",
  "1.0.0", "1.0", "2", "", "abc", "v0.169.0", "0.16", "10.0.0-rc1", "99999999999999999999999.0"];
const named = rows(`SELECT v, ${namesTurnOnToolsSql("v")} AS n FROM (SELECT arrayJoin({v:Array(String)}) AS v)`,
  { v: JSON.stringify(versions).replaceAll('"', "'") });
check(Object.fromEntries(named.map(r => [r.v, r.n === 1])),
  Object.fromEntries(versions.map(v => [v, namesTurnOnTools(v)])), "namesTurnOnToolsSql equals namesTurnOnTools");

// --- Fixture spans. ---
const userA = "turns-a@example.test", userB = "turns-b@example.test", userC = "turns-c@example.test";
const sol = "openai.gpt-6.1-sol", astra = "openai.gpt-6-astra";
const msOf = id => Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
const v7 = (iso, n) => {
  const hex = new Date(iso).getTime().toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${String(n).padStart(3, "0")}-8000-${String(n).padStart(12, "0")}`;
};
// Nanosecond Timestamp text from an ISO millisecond time plus extra nanoseconds.
const ts = (iso, ns = 0) => {
  const ms = new Date(iso).getTime();
  return new Date(ms - ms % 1000).toISOString().slice(0, 19).replace("T", " ") + "."
    + String((ms % 1000) * 1e6 + ns).padStart(9, "0");
};
let nextSpan = 1;
function span(name, turn, at, { ns = 0, duration = 1000000, user = userA, version = "0.169.0", conversation = "conv-a",
  key = "turn_id", model, legacyModel, trace = "trace-1", resource = {}, id } = {}) {
  const attributes = {};
  if (turn !== null) attributes[key] = turn;
  if (conversation) attributes["conversation.id"] = conversation;
  if (model) attributes.model = model;
  if (legacyModel) attributes["gen_ai.request.model"] = legacyModel;
  const resources = { client: "codex", ...(user ? { "user.email": user } : {}), ...resource };
  if (version) resources["service.version"] = version;
  return { Timestamp: ts(at, ns), TraceId: trace, SpanId: id ?? `span-${nextSpan++}`, SpanName: name,
    ResourceAttributes: resources, SpanAttributes: attributes, Duration: duration };
}
const insert = values => execute("INSERT INTO claude_code.otel_traces FORMAT JSONEachRow\n"
  + values.map(value => JSON.stringify(value)).join("\n"));

// T1: the brief's UUIDv7 id. Two models, tries > runs, a compaction named by `turn.id`, spawn and
// follow-up calls, spans without a conversation, a sub-millisecond end that the raw read floors.
const t1 = BRIEF_ID, t1At = new Date(msOf(t1)).toISOString();
const plus = (iso, ms) => new Date(new Date(iso).getTime() + ms).toISOString();
const duplicate = span("codex.sampling", t1, plus(t1At, 1000), { model: sol, id: "dup-sampling" });
const t1Spans = [
  span("run_turn", t1, t1At, { ns: 400000, duration: 3600000000 }),
  duplicate, duplicate,
  span("codex.sampling", t1, plus(t1At, 2000), { model: astra, conversation: "" }),
  span("codex.sampling", t1, plus(t1At, 3000), { legacyModel: sol }),
  ...[0, 1, 2].map(i => span("run_sampling_request", t1, plus(t1At, 1000 * (i + 1)), { model: sol })),
  ...[0, 1, 2, 3].map(i => span("try_run_sampling_request", t1, plus(t1At, 1000 * (i + 1) + 10), { model: sol })),
  span("codex.compaction", t1, plus(t1At, 5000), { key: "turn.id", conversation: "" }),
  span("collaborationspawn_agent", t1, plus(t1At, 6000)),
  span("multi_agent_v1spawn_agent", t1, plus(t1At, 6500)),
  span("collaborationfollowup_task", t1, plus(t1At, 6600)),
  span("multi_agent_v1send_input", t1, plus(t1At, 6700)),
  span("shell", t1, plus(t1At, 7000), { conversation: "" }),
  // Latest end: start .000600 ms past a millisecond plus a 1.6 ms duration; raw end floors both.
  span("shell", t1, plus(t1At, 3600000), { ns: 600000, duration: 1600000 }),
];
// T2: a non-v7 id spanning two hours, legacy spans only, Codex 0.163.0, gen_ai model names.
const t2 = "5b1c2d3e-4f50-4a61-8b72-0c1d2e3f4a5b";
const t2Spans = [
  span("run_turn", t2, "2026-10-18T13:50:00.000Z", { version: "0.163.0", conversation: "conv-b", duration: 1800000000 }),
  span("run_sampling_request", t2, "2026-10-18T13:55:00.000Z", { version: "0.163.0", conversation: "conv-b", legacyModel: astra }),
  span("run_sampling_request", t2, "2026-10-18T14:10:00.000Z", { version: "0.163.0", conversation: "conv-b", legacyModel: astra }),
  span("try_run_sampling_request", t2, "2026-10-18T13:55:00.010Z", { version: "0.163.0", conversation: "conv-b" }),
  span("try_run_sampling_request", t2, "2026-10-18T14:10:00.010Z", { version: "0.163.0", conversation: "conv-b" }),
  span("shell", t2, "2026-10-18T14:20:00.000Z", { version: "0.163.0", conversation: "conv-b" }),
];
// T3: a synthetic id, no conversation, no version, compaction only; the same id under user B.
const t3 = "auto-compact-3";
const t3Spans = [
  span("codex.compaction", t3, "2026-10-18T09:00:00.000Z", { key: "turn.id", conversation: "", version: "" }),
  span("codex.compaction", t3, "2026-10-18T09:00:05.000Z", { key: "turn.id", conversation: "", version: "", user: userB }),
];
// T4: a v7 turn at 14:40 that runs into the next day past verifyTo + 24h of its hour window.
const t4 = v7("2026-10-18T14:40:00.000Z", 4);
const t4Spans = [
  span("codex.sampling", t4, "2026-10-18T14:40:00.000Z", { model: sol, conversation: "conv-c" }),
  span("codex.sampling", t4, "2026-10-19T14:30:00.000Z", { model: sol, conversation: "conv-c" }),
  span("codex.sampling", t4, "2026-10-19T16:00:00.000Z", { model: sol, conversation: "conv-c", trace: "trace-2" }),
];
// T5: Codex 1.0.0-beta with a follow-up call; T6 (user B): two conversations, which verify blocks.
const t5 = v7("2026-10-18T18:05:00.000Z", 5), t6 = v7("2026-10-18T16:10:00.000Z", 6);
const t5Spans = [
  span("codex.sampling", t5, "2026-10-18T18:05:00.000Z", { version: "1.0.0-beta", model: astra, conversation: "conv-d" }),
  span("collaborationfollowup_task", t5, "2026-10-18T18:05:01.000Z", { version: "1.0.0-beta", conversation: "conv-d" }),
];
const t6Spans = [
  span("codex.sampling", t6, "2026-10-18T16:10:00.000Z", { user: userB, model: sol, conversation: "conv-e" }),
  span("codex.sampling", t6, "2026-10-18T16:11:00.000Z", { user: userB, model: sol, conversation: "conv-f" }),
];
// T7: identity from enduser.id only.
const t7 = v7("2026-10-18T11:00:00.000Z", 7);
const t7Spans = [span("codex.sampling", t7, "2026-10-18T11:00:00.000Z", { user: "", resource: { "enduser.id": userC },
  model: sol, conversation: "conv-g" })];
// T8: a v7-shaped id with a garbage (far-future) time: its spans keep their own hours.
const t8 = "fff00000-0000-7000-8000-000000000008";
const t8Spans = [
  span("codex.sampling", t8, "2026-10-18T10:10:00.000Z", { model: sol, conversation: "conv-h" }),
  span("codex.sampling", t8, "2026-10-18T11:20:00.000Z", { model: sol, conversation: "conv-h" }),
];
// Verify boundaries (user E, outside the codexTurnSql parity reads, which clip at to + 24h).
// T9: a v7 id whose spans all start 3.5 hours before its id time, inside the 1 day lead.
// T10: a v7 id with a gap: its later span 3 days on still has the id hour (7 day age).
// T11: a non-v7 id whose later span hour starts at verifyTo + 7 days: past the raw scan.
// T12: a v7 id at 14:20 straddling the 7 day age: a span at 13:30 seven days on keeps the id
// hour, one at 15:00 is past the age and has its own hour row, which its own hour verifies.
const userE = "turns-e@example.test";
const t9 = v7("2026-10-18T20:30:00.000Z", 9), t10 = v7("2026-10-18T12:20:00.000Z", 10);
const t11 = "6c2d3e4f-5061-4a72-8c83-1d2e3f4a5b6c", t12 = v7("2026-10-18T14:20:00.000Z", 12);
const boundarySpans = [
  span("codex.sampling", t9, "2026-10-18T17:00:00.000Z", { user: userE, model: sol, conversation: "conv-i" }),
  span("shell", t9, "2026-10-18T17:10:00.000Z", { user: userE, conversation: "conv-i" }),
  span("codex.sampling", t10, "2026-10-18T12:20:00.000Z", { user: userE, model: sol, conversation: "conv-j" }),
  span("codex.sampling", t10, "2026-10-21T09:00:00.000Z", { user: userE, model: sol, conversation: "conv-j" }),
  span("codex.sampling", t11, "2026-10-18T21:10:00.000Z", { user: userE, model: sol, conversation: "conv-k" }),
  span("codex.sampling", t11, "2026-10-25T22:30:00.000Z", { user: userE, model: sol, conversation: "conv-k" }),
  span("codex.sampling", t12, "2026-10-18T14:20:00.000Z", { user: userE, model: sol, conversation: "conv-l" }),
  span("codex.sampling", t12, "2026-10-25T13:30:00.000Z", { user: userE, model: sol, conversation: "conv-l" }),
  span("codex.sampling", t12, "2026-10-25T15:00:00.000Z", { user: userE, model: sol, conversation: "conv-l" }),
];
// One insert block of garbage-time v7 ids spread over 120 months (2050-2059, inside the DateTime
// range, so nothing saturates). With id hours it would exceed max_partitions_per_insert_block and
// fail the otel_traces insert (ClickHouse code 252, checked against the unbounded rule).
const userD = "turns-d@example.test";
const garbage = Array.from({ length: 120 }, (_, i) => {
  const hex = (Date.parse("2050-01-15T00:00:00Z") + i * 31 * 86400000).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${String(i).padStart(3, "0")}-8000-000000000000`;
});
const garbageSpans = garbage.map((turn, i) => span("codex.sampling", turn, `2026-10-18T08:${String(i % 60).padStart(2, "0")}:00.000Z`,
  { user: userD, model: sol, conversation: `conv-garbage-${i}` }));
// Not turn spans of Codex: another client, and a Codex span without a turn id.
const excluded = [
  span("codex.sampling", t1, plus(t1At, 1500), { resource: { client: "claude" } }),
  span("codex.sampling", null, plus(t1At, 1600)),
];
insert([...t1Spans, ...t2Spans.slice(0, 3)]);
insert([duplicate, ...t2Spans.slice(3), ...t3Spans, ...t4Spans]);
insert([...t5Spans, ...t6Spans, ...t7Spans, ...t8Spans, ...excluded, t1Spans[3]]);
insert(garbageSpans);
insert(boundarySpans);
// A version-less span of T5 in its own insert: its row's empty version must never win a merge.
insert([span("shell", t5, "2026-10-18T18:05:02.000Z", { version: "", conversation: "conv-d" })]);

// --- Raw codexTurnSql rows against the rollup read (grouped by TurnId, states merged). ---
const from = new Date("2026-10-18T00:00:00Z"), to = new Date("2026-10-19T00:00:00Z");
const rollupSql = `SELECT turn_id, toUInt8(min_start >= {from:DateTime} AND min_start < {to:DateTime}) AS in_bucket,
    if(has(conversations, {conversation:String}), {conversation:String}, arrayMin(conversations)) AS conversation_id,
    formatDateTime(min_start, '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS started_at,
    toUnixTimestamp64Milli(min_start) AS start_ms, toUnixTimestamp64Milli(max_end) AS end_ms,
    sampling_calls, legacy_calls, sampling_tries, compactions, app_version,
    if(sampling_calls > 0, sampling_calls, legacy_calls) AS llm_calls,
    if(sampling_calls > 0, 'codex.sampling', 'run_sampling_request') AS sampling_span,
    if(sampling_calls > 0, sampling_models, legacy_models) AS models,
    spawn_calls, names_turn
  FROM (
    SELECT TurnId AS turn_id, groupUniqArrayMerge(Conversations) AS conversations,
      min(StartTs) AS min_start, max(EndTs) AS max_end,
      uniqExactMerge(SamplingSpans) AS sampling_calls, uniqExactMerge(LegacySpans) AS legacy_calls,
      uniqExactMerge(SamplingTries) AS sampling_tries, uniqExactMerge(Compactions) AS compactions,
      max(AppVersion) AS app_version, groupUniqArrayMerge(SamplingModels) AS sampling_models,
      groupUniqArrayMerge(LegacyModels) AS legacy_models, uniqExactMerge(SpawnCalls) AS spawn_calls,
      max(NamesTurnOnTools) AS names_turn
    FROM claude_code.${TURNS_ROLLUP_TABLE}
    WHERE UserIdentity = {userExact:String}
    GROUP BY TurnId
  )
  ORDER BY in_bucket DESC, start_ms ASC, turn_id ASC`;
const spawnSql = `SELECT turn_id, toString(uniqExact(TraceId, SpanId)) AS spawn_calls FROM (
    SELECT coalesce(nullIf(SpanAttributes['turn_id'], ''), SpanAttributes['turn.id']) AS turn_id, TraceId, SpanId
    FROM claude_code.otel_traces
    WHERE ResourceAttributes['client'] = 'codex' AND SpanName IN {spawn:Array(String)}
      AND coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, ''), '') = {userExact:String})
  WHERE turn_id != '' GROUP BY turn_id`;
const sorted = row => ({ ...row, models: [...row.models].sort() });
function rollupRows(user, conversation = "") {
  return rows(rollupSql, { from: "2026-10-18 00:00:00", to: "2026-10-19 00:00:00", userExact: user, conversation })
    .map(sorted);
}
function parity(phase) {
  const read = {};
  for (const user of [userA, userB, userC, userD]) {
    const raw = codexTurnSql(from, to, { userExact: user });
    const rawRows = rows(raw.sql, raw.params).map(sorted);
    const spawns = Object.fromEntries(rows(spawnSql, { userExact: user, spawn: `['${SPAWN_SPANS.join("','")}']` })
      .map(r => [r.turn_id, r.spawn_calls]));
    // A two-conversation turn reads the conversation the raw read picked (the detail's link rule).
    const rollup = rollupRows(user, user === userB ? rawRows.find(r => r.turn_id === t6)?.conversation_id ?? "" : "");
    check(rollup.map(({ spawn_calls, names_turn, ...row }) => row), rawRows, `${phase}: rollup equals codexTurnSql for ${user}`);
    check(Object.fromEntries(rollup.map(r => [r.turn_id, [r.spawn_calls, r.names_turn === 1]])),
      Object.fromEntries(rawRows.map(r => [r.turn_id, [spawns[r.turn_id] ?? "0", namesTurnOnTools(r.app_version)]])),
      `${phase}: spawn calls and version rule for ${user}`);
    read[user] = rollup;
  }
  return read;
}
const live = parity("live view");
const byId = Object.fromEntries(live[userA].map(r => [r.turn_id, r]));
check(Object.keys(byId).sort(), [t1, t2, t3, t4, t5, t8].sort(), "user A turns");
check([byId[t1].llm_calls, byId[t1].legacy_calls, byId[t1].sampling_tries, byId[t1].compactions,
  byId[t1].spawn_calls, byId[t1].models, byId[t1].names_turn, byId[t1].conversation_id],
["3", "3", "4", "1", "3", [astra, sol].sort(), 1, "conv-a"], "T1 counts, models and conversation");
check(Number(byId[t1].end_ms) - msOf(t1), 3600000 + 1, "T1 end is the raw millisecond end");
check([byId[t2].llm_calls, byId[t2].sampling_span, byId[t2].models, byId[t2].sampling_tries, byId[t2].names_turn],
  ["2", "run_sampling_request", [astra], "2", 0], "T2 legacy turn on 0.163.0");
check([byId[t3].conversation_id, byId[t3].app_version, byId[t3].compactions, byId[t3].llm_calls], ["", "", "1", "0"],
  "T3 synthetic id without conversation or version");
check([byId[t5].spawn_calls, byId[t5].names_turn, byId[t5].app_version], ["1", 1, "1.0.0-beta"],
  "T5 1.0.0-beta follow-up keeps its version over a version-less span");
check(rows(`SELECT AppVersion AS v FROM claude_code.${TURNS_ROLLUP_TABLE} WHERE TurnId = '${t5}' ORDER BY v`),
  [{ v: "" }, { v: "1.0.0-beta" }], "T5 keeps an empty-version row for the merge to resolve");
check(rows(`SELECT toString(TurnHour) AS hour FROM claude_code.${TURNS_ROLLUP_TABLE} WHERE TurnId = '${t2}' GROUP BY TurnHour ORDER BY hour`),
  [{ hour: "2026-10-18 13:00:00" }, { hour: "2026-10-18 14:00:00" }], "non-v7 turn keeps one row per span hour");
check(rows(`SELECT DISTINCT toString(TurnHour) AS hour FROM claude_code.${TURNS_ROLLUP_TABLE} WHERE TurnId = '${t4}'`),
  [{ hour: "2026-10-18 14:00:00" }], "v7 turn keeps its id hour for spans on the next day");
check(rows(`SELECT toString(TurnHour) AS hour FROM claude_code.${TURNS_ROLLUP_TABLE} WHERE TurnId = '${t8}' ORDER BY hour`),
  [{ hour: "2026-10-18 10:00:00" }, { hour: "2026-10-18 11:00:00" }], "garbage-time v7 turn keeps one row per span hour");
check(rows(`SELECT count() AS turns, uniqExact(toYYYYMM(TurnHour)) AS months FROM claude_code.${TURNS_ROLLUP_TABLE}
  WHERE UserIdentity = '${userD}'`), [{ turns: "120", months: "1" }], "garbage-time ids stay in the span's partition");
check(rows(`SELECT toString(TurnHour) AS hour FROM claude_code.${TURNS_ROLLUP_TABLE} WHERE TurnId = '${t12}' GROUP BY TurnHour ORDER BY hour`),
  [{ hour: "2026-10-18 14:00:00" }, { hour: "2026-10-25 15:00:00" }], "a v7 span past the 7 day age has its own hour row");
check(rows(`SELECT DISTINCT UserIdentity AS u FROM claude_code.${TURNS_ROLLUP_TABLE} WHERE TurnId = '${t3}' ORDER BY u`),
  [{ u: userA }, { u: userB }], "a shared synthetic id stays per owner");
console.log(JSON.stringify({ phase: "live", status: "passed", assertions }));

// --- Backfill: bounded, and repeated or overlapping runs leave every read unchanged. ---
const backfill = generated("clickhouse-backfill-012.sql");
check(backfill.includes(codexTurnsBackfillSql()), true, "generated backfill file carries the module SQL");
const next = date => new Date(Date.parse(date + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
const day = date => ({ backfillFrom: `${date} 00:00:00`, backfillTo: `${next(date)} 00:00:00` });
for (const [params, label] of [[{ backfillFrom: "2026-10-18 00:00:00", backfillTo: "2026-10-20 00:00:00" }, "two days"],
  [{ backfillFrom: "2026-10-18 00:00:00", backfillTo: "2026-10-18 00:00:00" }, "empty interval"]]) {
  assert.throws(() => execute(backfill, params, ["--insert_deduplicate=0"]),
    /Codex turns backfill requires a positive interval of at most one day/, label);
  assertions++;
}
// Every day holding a fixture span, so the backfill alone rebuilds each turn.
const days = ["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-21", "2026-10-25"];
for (let round = 0; round < 2; round++)
  for (const date of days) execute(backfill, day(date), ["--insert_deduplicate=0"]);
execute(backfill, { backfillFrom: "2026-10-18 14:00:00", backfillTo: "2026-10-19 14:00:00" }, ["--insert_deduplicate=0"]);
const parts = rows(`SELECT count() AS n FROM system.parts WHERE active AND database = 'claude_code' AND table = '${TURNS_ROLLUP_TABLE}'`)[0];
assert.ok(Number(parts.n) > 3, "repeated backfills must leave several unmerged parts");
check(parity("repeated backfill"), live, "repeated backfill leaves every rollup read unchanged");
// The backfill alone rebuilds what the view wrote.
execute(`TRUNCATE TABLE claude_code.${TURNS_ROLLUP_TABLE}`);
for (const date of days) execute(backfill, day(date), ["--insert_deduplicate=0"]);
check(parity("backfill only"), live, "backfill alone equals the live view");
execute(`SYSTEM START MERGES claude_code.${TURNS_ROLLUP_TABLE}; OPTIMIZE TABLE claude_code.${TURNS_ROLLUP_TABLE} FINAL`);
check(parity("merged"), live, "merged parts leave every rollup read unchanged");
console.log(JSON.stringify({ phase: "backfill", status: "passed", assertions }));

// --- Generated verify: no differs over every hour of the day, clipped turns kept out. ---
const verify = generated("clickhouse-verify-012.sql");
const verifyHour = (hour, date = "2026-10-18") => {
  const start = new Date(Date.parse(`${date}T00:00:00Z`) + hour * 3600000);
  const text = start.toISOString().slice(0, 19).replace("T", " ");
  const end = new Date(start.getTime() + 3600000).toISOString().slice(0, 19).replace("T", " ");
  return execute(verify, { verifyFrom: text, verifyTo: end }, ["--format=JSONEachRow"])
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(r => "turn_id" in r);
};
const verified = [];
for (let hour = 0; hour < 24; hour++)
  for (const row of verifyHour(hour)) verified.push({ hour, ...row });
// A turn is compared in each window holding one of its rows, over its rows from that window on.
const expected = [
  { hour: 9, turn_id: t3, differs: 0, clipped: 0 }, { hour: 9, turn_id: t3, differs: 0, clipped: 0 },
  { hour: 11, turn_id: t7, differs: 0, clipped: 0 },
  { hour: 13, turn_id: t2, differs: 0, clipped: 0 }, { hour: 14, turn_id: t2, differs: 0, clipped: 0 },
  // T4's next-day spans are inside the 7 day raw scan, so it is compared.
  { hour: 14, turn_id: t4, differs: 0, clipped: 0 }, { hour: 14, turn_id: t1, differs: 0, clipped: 0 },
  // T12's own-hour span starts at the raw end of its id hour: clipped there.
  { hour: 14, turn_id: t12, differs: 0, clipped: 1 },
  { hour: 20, turn_id: t9, differs: 0, clipped: 0 },
  { hour: 12, turn_id: t10, differs: 0, clipped: 0 },
  { hour: 21, turn_id: t11, differs: 0, clipped: 1 },
  { hour: 16, turn_id: t6, differs: 1, clipped: 0 },
  { hour: 18, turn_id: t5, differs: 0, clipped: 0 },
  { hour: 10, turn_id: t8, differs: 0, clipped: 0 }, { hour: 11, turn_id: t8, differs: 0, clipped: 0 },
  ...garbage.map(turn_id => ({ hour: 8, turn_id, differs: 0, clipped: 0 })),
];
const order = list => [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
check(order(verified), order(expected), "verify: each turn row's window; only the two-conversation turn differs; clipped turns are excluded");
// T12's own-hour window reads the 15:00 span and its row; the 13:30 span on the same day belongs
// to the id-hour row, so neither side groups it here.
check(verifyHour(15, "2026-10-25"), [{ turn_id: t12, differs: 0, clipped: 0 }], "verify: a fragment past the 7 day age matches");
// A lost fragment row differs in its own hour; its id hour then compares the rest.
execute(`ALTER TABLE claude_code.${TURNS_ROLLUP_TABLE} DELETE WHERE TurnId = '${t12}' AND TurnHour = '2026-10-25 15:00:00'`, {},
  ["--mutations_sync=2"]);
check(verifyHour(15, "2026-10-25"), [{ turn_id: t12, differs: 1, clipped: 0 }], "verify: a lost fragment row differs");
check(verifyHour(14).find(r => r.turn_id === t12), { turn_id: t12, differs: 0, clipped: 0 }, "verify: the id-hour row still matches");
execute(backfill, day("2026-10-25"), ["--insert_deduplicate=0"]);
check(verifyHour(15, "2026-10-25"), [{ turn_id: t12, differs: 0, clipped: 0 }], "verify: backfill restores the fragment row");
// A lost rollup row differs until a backfill restores it, including a turn whose spans all lead
// its id hour; a misaligned window is rejected.
execute(`ALTER TABLE claude_code.${TURNS_ROLLUP_TABLE} DELETE WHERE TurnId IN ('${t1}', '${t9}')`, {}, ["--mutations_sync=2"]);
check(verifyHour(14).find(r => r.turn_id === t1), { turn_id: t1, differs: 1, clipped: 0 }, "verify: missing rollup row differs");
check(verifyHour(20).find(r => r.turn_id === t9), { turn_id: t9, differs: 1, clipped: 0 },
  "verify: missing rollup row of a turn whose spans lead its id hour differs");
execute(backfill, day("2026-10-18"), ["--insert_deduplicate=0"]);
check([14, 20].flatMap(hour => verifyHour(hour)).filter(r => r.differs === 1), [], "verify: backfill restores the rows");
assert.throws(() => execute(verify, { verifyFrom: "2026-10-18 14:30:00", verifyTo: "2026-10-18 15:00:00" }),
  /hour-aligned/, "misaligned verify window");
assertions++;
check(parity("restored"), live, "restored rollup equals the live view");
console.log(JSON.stringify({ status: "passed", assertions }));
