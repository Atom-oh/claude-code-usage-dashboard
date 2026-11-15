// Reads of Codex turns from the rollup (codex_turns_v1) behind CODEX_TURNS_READ_FROM
// (docs/superpowers/specs/2026-11-15-codex-turn-rollup-design.md, "Reads"). The SQL builders
// return the rows of taskTraces.js codexTurnSql (plus spawn_calls and names_turn), but unclipped.
// Wiring into the list, detail and agents reads is separate; unset means raw everywhere.
import { toChDateTime } from "./clickhouse.js";
import { TURNS_ROLLUP_TABLE, turnHourMs } from "./codexTurnsSchema.js";
import { CODEX_TURN_LIMIT, COMPLETION_SLACK_MS, SPAN_SLACK_MS } from "./taskTraces.js";

const HOUR_MS = 3600000;

export function parseCodexTurnsReadFrom(value) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value))
    throw new Error("CODEX_TURNS_READ_FROM must be a verified UTC timestamp (YYYY-MM-DDTHH:mm:ssZ)");
  const date = new Date(value);
  if (!Number.isFinite(+date) || date.toISOString().replace(".000Z", "Z") !== value)
    throw new Error("CODEX_TURNS_READ_FROM is not a valid UTC timestamp");
  if (+date % HOUR_MS !== 0) throw new Error("CODEX_TURNS_READ_FROM must be hour-aligned");
  return date;
}
export const codexTurnsReadFrom = parseCodexTurnsReadFrom(process.env.CODEX_TURNS_READ_FROM);

// The list reads context turns up to this far before the page start.
export const TURN_LOOKBACK_MS = 7 * 24 * HOUR_MS;
const TURN_ID_LEAD_MS = 24 * HOUR_MS;

export function turnsSourceForList(from, boundary = codexTurnsReadFrom) {
  return boundary !== null && +from - TURN_LOOKBACK_MS >= +boundary ? "rollup" : "raw";
}

// Unix ms of a UUIDv7 id, else null (non-v7 and synthetic ids have no id time).
export function turnIdMs(turnId) {
  const hour = turnHourMs(turnId);
  if (hour === null) return null;
  return Number.parseInt(turnId.slice(0, 8) + turnId.slice(9, 13), 16);
}

// A detail turn must start in [from, to) and a turn's spans start after its id: the rollup is
// used only for a UUIDv7 id whose time is in [from - 7 days, to + 1 day] and at or after the
// boundary. Any other id, such as a garbage time whose spans use their own hours, reads raw.
export function turnsSourceForTurn(turnId, boundary = codexTurnsReadFrom, { from, to } = {}) {
  if (boundary === null || !(from instanceof Date) || !(to instanceof Date)) return "raw";
  const ms = turnIdMs(turnId);
  if (ms === null || ms < +boundary) return "raw";
  return ms >= +from - TURN_LOOKBACK_MS && ms <= +to + TURN_ID_LEAD_MS ? "rollup" : "raw";
}

// Contract for the detail: a "rollup" turn read keyed by the id's hour can still miss (a v7 id
// with an implausible time for its own spans lies in the span hours, and a lost row is possible).
// When the rows hold no turn with this id, the detail reads raw instead of answering not found.
export function rollupHasTurn(rows, turnId) {
  return rows.some(row => row.turn_id === turnId);
}

const floorHour = ms => Math.floor(ms / HOUR_MS) * HOUR_MS;
// An id hour a DateTime parameter can carry (a garbage v7 time may not be).
const MAX_ID_HOUR_MS = Date.UTC(2100, 0, 1);
// SQL of the id hour of a UUIDv7 TurnId (as turnHourMs without a span), when representable.
const V7_SQL = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const ID_MS_SQL = "toInt64(reinterpretAsUInt64(reverse(unhex(concat(substring(TurnId, 1, 8), substring(TurnId, 10, 4))))))";
const ID_HOUR_SQL = `toStartOfHour(toDateTime(intDiv(${ID_MS_SQL}, 1000), 'UTC'))`;
const idHourOf = turnId => {
  const hour = turnId === null ? null : turnHourMs(turnId);
  return hour !== null && hour >= 0 && hour < MAX_ID_HOUR_MS ? hour : null;
};

// Rows of codexTurnSql from merged rollup states, grouped by owner-bound TurnId over the hour
// rows (a non-v7 or >7-day turn spans several). Unclipped.
// - Hours: TurnHour in [hourFrom, hourTo), by default [from - 7 days, to + 24h); with `turnId` of
//   a UUIDv7 id (representable time) and no `hourFrom`, exactly the id's hour.
// - Over a range, a UUIDv7 turn with a row in it also merges its id-hour row before `hourFrom`
//   (one keyed lookup): a span starting over 7 days after the id keeps its own hour, so without
//   that row a turn running past its id + 7 days would merge as a fragment starting in the page,
//   a task of the wrong bucket. With it the turn keeps its true start (context there) and is
//   listed once, in the bucket of its start. Rows after `hourTo` stay out (the end clips there).
//   A non-v7 id, or a v7 turn whose first spans precede its id by over a day, has no such key.
// - Without `turnId`, `startFrom` or `startTo` (the list), a turn qualifies as context when it
//   starts before to + 24h and its end + COMPLETION_SLACK_MS reaches `from`. Those options
//   replace that rule: `turnId` picks one turn, `startFrom`/`startTo` (ms) bound the merged start
//   (the detail's competitors).
// - `conversation_id` is the smallest conversation of the merged set (raw anyIf is not
//   deterministic), or the requested one when the set contains it, so a link minted by raw
//   still opens. `conversationId(s)` keep turns whose set contains it (any of them).
export function rollupTurnSql(from, to, q, { conversationId = null, conversationIds = null, turnId = null,
  hourFrom = null, hourTo = null, startFrom = null, startTo = null } = {}) {
  const idHour = idHourOf(turnId);
  const pinned = idHour !== null && hourFrom === null;
  const lower = pinned ? new Date(idHour) : hourFrom ?? new Date(+from - TURN_LOOKBACK_MS);
  const upper = hourTo ?? (pinned ? new Date(idHour + HOUR_MS) : new Date(+to + SPAN_SLACK_MS));
  const params = { from: toChDateTime(from), to: toChDateTime(to),
    spanTo: toChDateTime(new Date(+to + SPAN_SLACK_MS)), userExact: q.userExact,
    hourFrom: toChDateTime(new Date(floorHour(+lower))), hourTo: toChDateTime(upper) };
  const where = [];
  let conversation = "arrayMin(conversations)";
  if (conversationId !== null) {
    params.conversationId = conversationId;
    where.push("has(conversations, {conversationId:String})");
    conversation = "{conversationId:String}";
  } else if (conversationIds !== null) {
    params.conversationIds = conversationIds;
    where.push("hasAny(conversations, {conversationIds:Array(String)})");
    conversation = "arrayMin(arrayIntersect(conversations, {conversationIds:Array(String)}))";
  }
  if (turnId !== null) params.turnId = turnId;
  if (startFrom !== null) { params.startFrom = startFrom; where.push("start_ms >= {startFrom:Int64}"); }
  if (startTo !== null) { params.startTo = startTo; where.push("start_ms < {startTo:Int64}"); }
  const range = "TurnHour >= {hourFrom:DateTime} AND TurnHour < {hourTo:DateTime}";
  // Representable v7 id hours before the range of the turns with a row in it.
  const idHours = pinned ? "" : `
            OR (TurnHour, TurnId) IN (
                SELECT ${ID_HOUR_SQL}, TurnId
                FROM claude_code.${TURNS_ROLLUP_TABLE}
                PREWHERE UserIdentity = {userExact:String}
                  AND ${range}${turnId === null ? "" : "\n                  AND TurnId = {turnId:String}"}
                WHERE match(TurnId, '${V7_SQL}') AND ${ID_MS_SQL} < ${MAX_ID_HOUR_MS}
                  AND ${ID_HOUR_SQL} < {hourFrom:DateTime}
                GROUP BY TurnId)`;
  if (turnId === null && startFrom === null && startTo === null)
    where.push("min_start < {spanTo:DateTime}",
      `end_ms + ${COMPLETION_SLACK_MS} >= toUnixTimestamp({from:DateTime}) * 1000`);
  return {
    sql: `SELECT turn_id,
        toUInt8(min_start >= {from:DateTime} AND min_start < {to:DateTime}) AS in_bucket,
        ${conversation} AS conversation_id,
        formatDateTime(min_start, '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS started_at,
        start_ms, end_ms, sampling_calls, legacy_calls, sampling_tries, compactions, app_version,
        if(sampling_calls > 0, sampling_calls, legacy_calls) AS llm_calls,
        if(sampling_calls > 0, 'codex.sampling', 'run_sampling_request') AS sampling_span,
        arraySort(if(sampling_calls > 0, sampling_models, legacy_models)) AS models,
        spawn_calls, names_turn
    FROM (
        SELECT TurnId AS turn_id, groupUniqArrayMerge(Conversations) AS conversations,
            min(StartTs) AS min_start, max(EndTs) AS max_end,
            toUnixTimestamp64Milli(min(StartTs)) AS start_ms, toUnixTimestamp64Milli(max(EndTs)) AS end_ms,
            uniqExactMerge(SamplingSpans) AS sampling_calls, uniqExactMerge(LegacySpans) AS legacy_calls,
            uniqExactMerge(SamplingTries) AS sampling_tries, uniqExactMerge(Compactions) AS compactions,
            max(AppVersion) AS app_version, groupUniqArrayMerge(SamplingModels) AS sampling_models,
            groupUniqArrayMerge(LegacyModels) AS legacy_models, uniqExactMerge(SpawnCalls) AS spawn_calls,
            max(NamesTurnOnTools) AS names_turn
        FROM claude_code.${TURNS_ROLLUP_TABLE}
        PREWHERE UserIdentity = {userExact:String}${turnId === null ? "" : "\n          AND TurnId = {turnId:String}"}
        WHERE (${range}${idHours})
        GROUP BY TurnId
    )${where.length ? `\n    WHERE ${where.join("\n      AND ")}` : ""}
    ORDER BY in_bucket DESC, start_ms ASC, turn_id ASC
    LIMIT ${CODEX_TURN_LIMIT + 1}`,
    params,
  };
}

// Owner of a UUIDv7 turn, keyed by the id's hour: the rows of at most two owners (a second one
// makes the owner ambiguous), as codexOwnerSql returns for the raw read.
export function rollupOwnerSql(turnId) {
  const hour = idHourOf(turnId);
  if (hour === null) throw new Error("rollupOwnerSql requires a UUIDv7 turn id with a representable time");
  return {
    sql: `SELECT UserIdentity AS owner
FROM claude_code.${TURNS_ROLLUP_TABLE}
PREWHERE TurnHour = {turnHour:DateTime} AND TurnId = {turnId:String}
GROUP BY owner
LIMIT 2`,
    params: { turnId, turnHour: toChDateTime(new Date(hour)) },
  };
}
