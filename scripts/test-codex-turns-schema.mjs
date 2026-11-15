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
import { TURN_LOOKBACK_MS, rollupOwnerSql, rollupTurnSql } from "../dashboard/server/codexTurnsSource.js";
import { codexDetailHourFrom, codexDetailSql, codexTurnWindow } from "../dashboard/server/taskTraceDetail.js";
import { codexCompletionSql } from "../dashboard/server/taskTraces.js";
import { codexSkillsSql } from "../dashboard/server/codexActivity.js";
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

execute(`CREATE DATABASE claude_code;
CREATE TABLE claude_code.otel_traces (
  Timestamp DateTime64(9), TraceId String, SpanId String, ParentSpanId String, SpanName LowCardinality(String),
  ResourceAttributes Map(LowCardinality(String), String), SpanAttributes Map(LowCardinality(String), String),
  Duration Int64,
  UserEmail LowCardinality(String) MATERIALIZED ResourceAttributes['user.email'],
  EndUserId LowCardinality(String) MATERIALIZED ResourceAttributes['enduser.id']
) ENGINE = MergeTree ORDER BY (SpanName, Timestamp);
CREATE TABLE claude_code.otel_logs (
  Timestamp DateTime64(9), ResourceAttributes Map(LowCardinality(String), String),
  LogAttributes Map(LowCardinality(String), String),
  UserEmail LowCardinality(String) MATERIALIZED ResourceAttributes['user.email'],
  EndUserId LowCardinality(String) MATERIALIZED ResourceAttributes['enduser.id'],
  EventName LowCardinality(String) MATERIALIZED LogAttributes['event.name']
) ENGINE = MergeTree ORDER BY (EventName, Timestamp);`);
execute(codexTurnsSchemaSql());
execute(`ALTER TABLE claude_code.${TURNS_ROLLUP_TABLE} REMOVE TTL`);
// Background merges would fold the fixture's separate inserts nondeterministically (the T5 and
// list-context checks read unmerged parts); the merged phase starts them explicitly below.
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
// List context turns (user E, outside the other reads): the list reads turns that start before
// to + 24h and end (plus the 5 s completion slack) at or after from, whatever their start.
const userE = "turns-e@example.test";
const ctx = (name, at, extra = []) => {
  const turn = v7(at, name);
  return { turn, spans: [span("codex.sampling", turn, at, { user: userE, model: sol, conversation: `conv-ctx-${name}` }),
    ...extra.map(later => span("codex.sampling", turn, later, { user: userE, model: sol, conversation: `conv-ctx-${name}` }))] };
};
const ctxEarly = ctx(11, "2026-10-17T10:00:00.000Z");            // ends long before from - 5 s: excluded
const ctxJustOut = ctx(12, "2026-10-17T23:59:54.000Z");          // ends 23:59:54.001: +5 s < from, excluded
const ctxJustIn = ctx(13, "2026-10-17T23:59:57.000Z");           // ends 23:59:57.001: +5 s >= from, included
const ctxLong = ctx(14, "2026-10-15T12:00:00.000Z", ["2026-10-18T00:00:20.000Z"]); // starts 3 days before from, included whole
const ctxLate = ctx(15, "2026-10-19T23:30:00.000Z");             // starts before to + 24h, included as context
const ctxBeyond = ctx(16, "2026-10-20T00:00:00.000Z");           // starts at to + 24h: excluded
const ctxTurns = [ctxEarly, ctxJustOut, ctxJustIn, ctxLong, ctxLate, ctxBeyond];
// Not turn spans of Codex: another client, and a Codex span without a turn id.
const excluded = [
  span("codex.sampling", t1, plus(t1At, 1500), { resource: { client: "claude" } }),
  span("codex.sampling", null, plus(t1At, 1600)),
];
insert([...t1Spans, ...t2Spans.slice(0, 3)]);
insert([duplicate, ...t2Spans.slice(3), ...t3Spans, ...t4Spans]);
insert([...t5Spans, ...t6Spans, ...t7Spans, ...t8Spans, ...excluded, t1Spans[3]]);
insert(garbageSpans);
insert(ctxTurns.flatMap(c => c.spans));
// A version-less span of T5 in its own insert: its row's empty version must never win a merge.
insert([span("shell", t5, "2026-10-18T18:05:02.000Z", { version: "", conversation: "conv-d" })]);

// --- Raw codexTurnSql rows against the rollup read (grouped by TurnId, states merged). ---
const from = new Date("2026-10-18T00:00:00Z"), to = new Date("2026-10-19T00:00:00Z");
const spawnSql = `SELECT turn_id, toString(uniqExact(TraceId, SpanId)) AS spawn_calls FROM (
    SELECT coalesce(nullIf(SpanAttributes['turn_id'], ''), SpanAttributes['turn.id']) AS turn_id, TraceId, SpanId
    FROM claude_code.otel_traces
    WHERE ResourceAttributes['client'] = 'codex' AND SpanName IN {spawn:Array(String)}
      AND coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, ''), '') = {userExact:String})
  WHERE turn_id != '' GROUP BY turn_id`;
const sorted = row => (row.models ? { ...row, models: [...row.models].sort() } : row);
// A bound parameter in clickhouse-client text form.
const text = value => Array.isArray(value) ? `['${value.join("','")}']` : String(value);
const asRows = ({ sql, params }) => rows(sql, Object.fromEntries(Object.entries(params).map(([k, v]) => [k, text(v)]))).map(sorted);
const strip = ({ spawn_calls, names_turn, ...row }) => row;
const t6Link = row => (row.turn_id === t6 ? { ...row, conversation_id: "" } : row);
function parity(phase) {
  const read = {};
  for (const user of [userA, userB, userC, userD]) {
    const q = { userExact: user };
    const rawRows = asRows(codexTurnSql(from, to, q));
    const spawns = Object.fromEntries(rows(spawnSql, { userExact: user, spawn: `['${SPAWN_SPANS.join("','")}']` })
      .map(r => [r.turn_id, r.spawn_calls]));
    const rollup = asRows(rollupTurnSql(from, to, q));
    // Raw anyIf picks either conversation of a two-conversation turn; the rollup takes the smallest.
    if (user === userB) check(rollup.find(r => r.turn_id === t6).conversation_id, "conv-e", "two conversations: smallest");
    check(rollup.map(t6Link).map(strip), rawRows.map(t6Link), `${phase}: rollup equals codexTurnSql for ${user}`);
    check(Object.fromEntries(rollup.map(r => [r.turn_id, [r.spawn_calls, r.names_turn === 1]])),
      Object.fromEntries(rawRows.map(r => [r.turn_id, [spawns[r.turn_id] ?? "0", namesTurnOnTools(r.app_version)]])),
      `${phase}: spawn calls and version rule for ${user}`);
    read[user] = rollup;
  }
  return read;
}
// Filtered reads equal the raw reads (and raw rows filtered by start or id).
function filters() {
  const q = { userExact: userA };
  const rawFor = options => asRows(codexTurnSql(from, to, q, options));
  const rollupFor = options => asRows(rollupTurnSql(from, to, q, options)).map(strip);
  for (const options of [{ conversationId: "conv-a" }, { conversationId: "conv-b" }, { conversationId: "conv-c" },
    { conversationIds: ["conv-a", "conv-b"] }, { conversationIds: ["conv-c", "conv-h", "none"] }, { conversationId: "none" }])
    check(rollupFor(options), rawFor(options), `filter ${JSON.stringify(options)} equals codexTurnSql`);
  const all = rawFor({});
  const t2Start = Number(all.find(r => r.turn_id === t2).start_ms), t1Start = Number(all.find(r => r.turn_id === t1).start_ms);
  check(rollupFor({ startFrom: t2Start, startTo: t1Start }), all.filter(r => Number(r.start_ms) >= t2Start && Number(r.start_ms) < t1Start)
    .map(r => ({ ...r, in_bucket: r.in_bucket })), "start window equals raw rows filtered by start");
  check(rollupFor({ startFrom: t1Start }).map(r => r.turn_id), all.filter(r => Number(r.start_ms) >= t1Start).map(r => r.turn_id), "startFrom only");
  // Detail competitors: one conversation, start in [s, ...).
  check(rollupFor({ conversationId: "conv-b", startFrom: t2Start, startTo: t2Start + 1 }), rawFor({ conversationId: "conv-b" })
    .filter(r => Number(r.start_ms) === t2Start), "conversation and start window");
  for (const turnId of [t1, t4, t5, t8, t2, t3, "missing"])
    check(rollupFor({ turnId }), all.filter(r => r.turn_id === turnId), `turnId ${turnId} equals the raw row (v7 pinned hour or merged hours)`);
  // Owner: the id's hour, no user filter.
  check(asRows(rollupOwnerSql(t1)), [{ owner: userA }], "rollupOwnerSql for the brief turn");
  check(asRows(rollupOwnerSql(t6)), [{ owner: userB }], "rollupOwnerSql for the two-conversation turn");
  check(asRows(rollupOwnerSql(v7("2026-10-18T15:00:00.000Z", 99))), [], "rollupOwnerSql without rows");
}
// The list read (no turnId, startFrom or startTo) applies the context rule and does not clip.
function listContext() {
  const list = asRows(rollupTurnSql(from, to, { userExact: userE }));
  check(list.map(r => r.turn_id), [ctxLong, ctxJustIn, ctxLate].map(c => c.turn), "list context rule: early, just-out and beyond turns are excluded");
  check(list.map(r => Number(r.in_bucket)), [0, 0, 0], "context turns are not bucket turns");
  const long = list.find(r => r.turn_id === ctxLong.turn);
  check([Number(long.start_ms), Number(long.end_ms)], [Date.parse("2026-10-15T12:00:00.000Z"), Date.parse("2026-10-18T00:00:20.000Z") + 1],
    "a turn that starts 3 days before from is read whole, not clipped");
}
// The rollup detail's reads over its turn window (taskTraceDetail.codexTurnWindow) and the agents'
// rollup turn read, on a page (2026-10-21) the backfill and verify phases below never touch.
function detailWindow() {
  const pageFrom = new Date("2026-10-21T00:00:00Z"), pageTo = new Date("2026-10-22T00:00:00Z");
  const userF = "turns-f@example.test", q = { userExact: userF };
  const f = (name, turn, time, opts = {}) => span(name, turn, time, { user: userF, model: sol, conversation: "conv-detail", ...opts });
  const d0 = v7("2026-10-21T04:59:00.000Z", 20), d = v7("2026-10-21T05:00:00.000Z", 21), d2 = v7("2026-10-21T05:00:12.000Z", 22);
  const d3 = v7("2026-10-21T05:00:16.000Z", 23), other = v7("2026-10-21T05:00:13.000Z", 24);
  const long = v7("2026-10-21T20:00:00.000Z", 25), late = v7("2026-10-23T00:30:00.000Z", 26);
  // A v7 id more than a day after its first span: that span keeps its own hour (two hour rows).
  const multi = v7("2026-10-22T23:00:00.000Z", 27);
  // On a 10-day page: an id over 7 days after the turn's first span (that span's own hour row).
  const lateId = v7("2026-10-30T05:00:00.000Z", 28);
  insert([
    f("codex.sampling", d0, "2026-10-21T04:59:00.000Z"),
    f("codex.sampling", d, "2026-10-21T05:00:00.000Z"), f("codex.sampling", d, "2026-10-21T05:00:08.000Z", { duration: 2000000000 }),
    f("codex.sampling", d2, "2026-10-21T05:00:12.000Z"), f("codex.sampling", d3, "2026-10-21T05:00:16.000Z"),
    f("codex.sampling", other, "2026-10-21T05:00:13.000Z", { conversation: "conv-other" }),
    f("codex.sampling", long, "2026-10-21T20:00:00.000Z"), f("codex.sampling", long, "2026-10-22T23:00:00.000Z"),
    f("shell", long, "2026-10-23T02:00:00.000Z"),
    f("codex.sampling", late, "2026-10-23T00:30:00.000Z"),
    f("codex.sampling", multi, "2026-10-21T05:30:00.000Z", { conversation: "conv-m" }),
    f("codex.sampling", multi, "2026-10-22T22:30:00.000Z", { conversation: "conv-m" }),
    f("codex.sampling", lateId, "2026-10-21T06:00:00.000Z", { conversation: "conv-m2" }),
    f("codex.sampling", lateId, "2026-10-30T04:30:00.000Z", { conversation: "conv-m2" }),
  ]);
  const log = (time, attributes, user = userF) => ({ Timestamp: ts(time), ResourceAttributes: { client: "codex", "user.email": user },
    LogAttributes: attributes });
  const completed = (time, conversation = "conv-detail", user = userF) => log(time, { "event.name": "codex.sse_event",
    "event.kind": "response.completed", "conversation.id": conversation, input_token_count: "100", output_token_count: "20",
    "event.timestamp": time }, user);
  const skill = (time, name) => log(time, { "event.name": "codex.skill_invocation", "conversation.id": "conv-detail", "turn.id": d,
    "skill.name": name, "skill.invocation_type": "explicit", "skill.scope": "user" });
  execute("INSERT INTO claude_code.otel_logs FORMAT JSONEachRow\n" + [
    completed("2026-10-21T03:59:59.000Z"), completed("2026-10-21T04:00:00.000Z"), completed("2026-10-21T05:00:05.000Z"),
    completed("2026-10-22T05:00:09.000Z"), completed("2026-10-22T05:00:10.000Z"), completed("2026-10-22T23:59:59.000Z"),
    completed("2026-10-23T00:00:00.000Z"), completed("2026-10-21T05:00:05.000Z", "conv-other"),
    completed("2026-10-21T05:00:05.000Z", "conv-detail", userA),
    skill("2026-10-21T04:58:59.000Z", "skill-early"), skill("2026-10-21T05:00:03.000Z", "skill-in"),
    skill("2026-10-21T05:01:09.000Z", "skill-in"), skill("2026-10-21T05:01:10.000Z", "skill-late"),
  ].map(value => JSON.stringify(value)).join("\n"));
  const hourFrom = id => codexDetailHourFrom(pageFrom, id);
  const turnRow = (id, conversationId = "conv-detail") =>
    asRows(rollupTurnSql(pageFrom, pageTo, q, { conversationId, turnId: id, hourFrom: hourFrom(id) })).map(strip);
  const raw = conversationId => asRows(codexTurnSql(pageFrom, pageTo, q, { conversationId }));
  const times = list => list.map(r => new Date(Number(r.timestamp_ms)).toISOString()).sort();
  // Turn D: its row equals the raw row; competitors, completions, spans and skills by window.
  const [dRow] = turnRow(d);
  check(dRow, raw("conv-detail").find(r => r.turn_id === d), "detail turn row equals the raw codexTurnSql row");
  const dWin = codexTurnWindow(pageFrom, pageTo, Number(dRow.start_ms), Number(dRow.end_ms));
  check(asRows(rollupTurnSql(pageFrom, pageTo, q, { conversationId: "conv-detail", hourFrom: hourFrom(d), ...dWin.competitors }))
    .map(r => r.turn_id), [d, d2], "competitors: same conversation, start in [s, e + 5 s)");
  check(times(asRows(codexCompletionSql(pageFrom, pageTo, q, { conversationId: "conv-detail", ...dWin.completions }))),
    ["2026-10-21T04:00:00.000Z", "2026-10-21T05:00:05.000Z", "2026-10-22T05:00:09.000Z"], "completions: [s - 1h, e + 24h)");
  const dSpans = asRows(codexDetailSql(pageFrom, pageTo, q, "conv-detail", d, dWin.spans).spans);
  check([dSpans.length, dSpans[0].total_spans], [2, "2"], "spans of the turn in [s - 1 min, e + 1 min)");
  check(asRows(codexSkillsSql(pageFrom, pageTo, q, "conv-detail", d, { logFrom: dWin.spans.spanFrom, logTo: dWin.spans.spanTo })),
    [{ name: "skill-in", invocation: "explicit", scope: "user", calls: "2" }], "skills in the span window");
  // Turn L runs past to + 24h: unclipped row; every window stops at to + 24h like the list.
  const [lRow] = turnRow(long);
  check([lRow.start_ms, lRow.end_ms, lRow.in_bucket], [String(Date.parse("2026-10-21T20:00:00Z")),
    String(Date.parse("2026-10-23T02:00:00Z") + 1), 1], "long turn: unclipped end");
  const lWin = codexTurnWindow(pageFrom, pageTo, Number(lRow.start_ms), Number(lRow.end_ms));
  check(asRows(rollupTurnSql(pageFrom, pageTo, q, { conversationId: "conv-detail", hourFrom: hourFrom(long), ...lWin.competitors }))
    .map(r => r.turn_id), [long], "long turn: a competitor starting at or after to + 24h is not read");
  check(times(asRows(codexCompletionSql(pageFrom, pageTo, q, { conversationId: "conv-detail", ...lWin.completions }))),
    ["2026-10-22T05:00:09.000Z", "2026-10-22T05:00:10.000Z", "2026-10-22T23:59:59.000Z"], "long turn: completions stop at to + 24h");
  check(asRows(codexDetailSql(pageFrom, pageTo, q, "conv-detail", long, lWin.spans).spans).length, 2,
    "long turn: spans stop at to + 24h");
  // Turn M: two hour rows merge from id hour - 7 days; pinned to the id hour it would start late.
  check(rows(`SELECT toString(TurnHour) AS hour FROM claude_code.${TURNS_ROLLUP_TABLE} WHERE TurnId = '${multi}' ORDER BY hour`),
    [{ hour: "2026-10-21 05:00:00" }, { hour: "2026-10-22 23:00:00" }], "multi-row v7 turn keeps two hour rows");
  check(turnRow(multi, "conv-m"), raw("conv-m").filter(r => r.turn_id === multi), "multi-row turn: merged row equals raw");
  check(asRows(rollupTurnSql(pageFrom, pageTo, q, { conversationId: "conv-m", turnId: multi })).map(r => [r.in_bucket, r.llm_calls]),
    [[0, "1"]], "pinned to the id hour only the later row is read");
  // The late id on a 10-day page: the detail merges the same hour rows as the list; id hour - 7 days
  // alone would miss the first span's row.
  const longTo = new Date("2026-10-31T00:00:00Z");
  const lateRead = from => asRows(rollupTurnSql(pageFrom, longTo, q, { conversationId: "conv-m2", turnId: lateId, hourFrom: from })).map(strip);
  check(lateRead(codexDetailHourFrom(pageFrom, lateId)), asRows(rollupTurnSql(pageFrom, longTo, q)).map(strip)
    .filter(r => r.turn_id === lateId).map(r => ({ ...r, conversation_id: "conv-m2" })), "late id: detail row equals the list row");
  check(lateRead(new Date(turnHourMs(lateId) - TURN_LOOKBACK_MS)).map(r => r.started_at), ["2026-10-30T04:30:00Z"],
    "late id: id hour - 7 days alone misses the first span's row");
  check(lateRead(codexDetailHourFrom(pageFrom, lateId)).map(r => [r.started_at, r.llm_calls]), [["2026-10-21T06:00:00Z", "2"]],
    "late id: both rows merge");
  // A link's conversation outside the turn's set: no row (the detail then reads raw).
  check(turnRow(d, "conv-other"), [], "another conversation finds no turn row");
  // Agents: subagent/parent turns by conversation from the lineage start minus 7 days, unclipped.
  const lineageFrom = new Date("2026-10-18T00:00:00Z"), lineageTo = new Date("2026-10-19T00:00:00Z");
  const agentRead = asRows(rollupTurnSql(lineageFrom, lineageTo, { userExact: userE },
    { conversationIds: ["conv-ctx-14", "none"], hourFrom: new Date(+lineageFrom - TURN_LOOKBACK_MS) }));
  check(agentRead.map(r => [r.turn_id, r.conversation_id, Number(r.start_ms)]),
    [[ctxLong.turn, "conv-ctx-14", Date.parse("2026-10-15T12:00:00Z")]], "agents: a parent turn started 3 days before keeps its start");
  check(asRows(codexTurnSql(lineageFrom, lineageTo, { userExact: userE }, { conversationIds: ["conv-ctx-14"] }))
    .map(r => Number(r.start_ms)), [Date.parse("2026-10-18T00:00:20Z")], "agents: the raw read clips that start");
}
const live = parity("live view");
filters();
listContext();
detailWindow();
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
execute(`SYSTEM STOP MERGES claude_code.${TURNS_ROLLUP_TABLE}`);
for (let round = 0; round < 2; round++)
  for (const date of ["2026-10-17", "2026-10-18", "2026-10-19"]) execute(backfill, day(date), ["--insert_deduplicate=0"]);
execute(backfill, { backfillFrom: "2026-10-18 14:00:00", backfillTo: "2026-10-19 14:00:00" }, ["--insert_deduplicate=0"]);
const parts = rows(`SELECT count() AS n FROM system.parts WHERE active AND database = 'claude_code' AND table = '${TURNS_ROLLUP_TABLE}'`)[0];
assert.ok(Number(parts.n) > 3, "repeated backfills must leave several unmerged parts");
check(parity("repeated backfill"), live, "repeated backfill leaves every rollup read unchanged");
// The backfill alone rebuilds what the view wrote.
execute(`TRUNCATE TABLE claude_code.${TURNS_ROLLUP_TABLE}`);
for (const date of ["2026-10-17", "2026-10-18", "2026-10-19"]) execute(backfill, day(date), ["--insert_deduplicate=0"]);
check(parity("backfill only"), live, "backfill alone equals the live view");
execute(`SYSTEM START MERGES claude_code.${TURNS_ROLLUP_TABLE}; OPTIMIZE TABLE claude_code.${TURNS_ROLLUP_TABLE} FINAL`);
check(parity("merged"), live, "merged parts leave every rollup read unchanged");
console.log(JSON.stringify({ phase: "backfill", status: "passed", assertions }));

// --- Generated verify: no differs over every hour of the day, clipped turns kept out. ---
const verify = generated("clickhouse-verify-012.sql");
const verifyHour = hour => {
  const start = new Date(Date.parse("2026-10-18T00:00:00Z") + hour * 3600000);
  const text = start.toISOString().slice(0, 19).replace("T", " ");
  const end = new Date(start.getTime() + 3600000).toISOString().slice(0, 19).replace("T", " ");
  return execute(verify, { verifyFrom: text, verifyTo: end }, ["--format=JSONEachRow"])
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(r => "turn_id" in r);
};
const verified = [];
for (let hour = 0; hour < 24; hour++)
  for (const row of verifyHour(hour)) verified.push({ hour, ...row });
const expected = [
  { hour: 9, turn_id: t3, differs: 0, clipped: 0 }, { hour: 9, turn_id: t3, differs: 0, clipped: 0 },
  { hour: 11, turn_id: t7, differs: 0, clipped: 0 },
  { hour: 13, turn_id: t2, differs: 0, clipped: 0 },
  { hour: 14, turn_id: t4, differs: 0, clipped: 1 }, { hour: 14, turn_id: t1, differs: 0, clipped: 0 },
  { hour: 16, turn_id: t6, differs: 1, clipped: 0 },
  { hour: 18, turn_id: t5, differs: 0, clipped: 0 },
  { hour: 10, turn_id: t8, differs: 0, clipped: 0 },
  ...garbage.map(turn_id => ({ hour: 8, turn_id, differs: 0, clipped: 0 })),
];
const order = list => [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
check(order(verified), order(expected), "verify: each turn once; only the two-conversation turn differs; the clipped turn is excluded");
// A lost rollup row differs until a backfill restores it; a misaligned window is rejected.
execute(`ALTER TABLE claude_code.${TURNS_ROLLUP_TABLE} DELETE WHERE TurnId = '${t1}'`, {}, ["--mutations_sync=2"]);
check(verifyHour(14).find(r => r.turn_id === t1), { turn_id: t1, differs: 1, clipped: 0 }, "verify: missing rollup row differs");
execute(backfill, day("2026-10-18"), ["--insert_deduplicate=0"]);
check(verifyHour(14).filter(r => r.differs === 1), [], "verify: backfill restores the row");
assert.throws(() => execute(verify, { verifyFrom: "2026-10-18 14:30:00", verifyTo: "2026-10-18 15:00:00" }),
  /hour-aligned/, "misaligned verify window");
assertions++;
check(parity("restored"), live, "restored rollup equals the live view");
console.log(JSON.stringify({ status: "passed", assertions }));
