// One row per Codex turn (and turn hour), merged from aggregate states, so task reads get each
// turn's exact window without scanning raw spans over the page
// (docs/superpowers/specs/2026-11-15-codex-turn-rollup-design.md). A turn's merged rows equal
// the raw codexTurnSql row: every count is a set of span ids, so duplicate deliveries, the live
// view and repeated or overlapping backfills union, never add. The row is unclipped.
// A transform change requires a new table version and migration.
import { TURN_SPAN } from "./taskTraces.js";
import { SPAWN_SPANS } from "./codexAgents.js";

export const TURNS_ROLLUP_TABLE = "codex_turns_v1";
export const TURNS_ROLLUP_COLUMNS = [
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
];
const ORDER = "UserIdentity, TurnHour, TurnId";

// A UUIDv7 id's first 48 bits are its Unix milliseconds; the 15th character is the version.
// Only UUID-shaped ids qualify (synthetic ids such as `auto-compact-N` repeat across turns).
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V7_SQL = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
// Any UUID-shaped id: one turn, unlike a synthetic id such as `auto-compact-N`.
const UUID_SQL = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const HOUR_MS = 3600000;

// A span's TurnHour uses its v7 id time only when that time is plausible for the span: at most
// 7 days before it (a turn's spans start after its id) and at most 1 day after it (clock skew).
// Any other id time, such as a garbage or wrapped clock, uses the span's hour like a non-v7 id,
// so one insert block cannot spread across far-off partitions and fail the otel_traces insert.
export const TURN_ID_MAX_AGE_MS = 7 * 24 * HOUR_MS;
export const TURN_ID_MAX_LEAD_MS = 24 * HOUR_MS;
const floorHour = ms => Math.floor(ms / HOUR_MS) * HOUR_MS;

// UTC hour (epoch ms) of a turn's row for a span starting at spanMs: the UUIDv7 id's hour when
// plausible, else the span's hour. Without spanMs, the id's hour for a v7 id, else null; nothing
// then bounds the id time, so a read keyed by the id alone must bound it and fall back to raw
// when no row is found.
export function turnHourMs(turnId, spanMs) {
  const hasSpan = typeof spanMs === "number" && Number.isFinite(spanMs);
  if (typeof turnId === "string" && UUID_V7.test(turnId)) {
    const ms = Number.parseInt(turnId.slice(0, 8) + turnId.slice(9, 13), 16);
    if (!hasSpan || (ms >= spanMs - TURN_ID_MAX_AGE_MS && ms <= spanMs + TURN_ID_MAX_LEAD_MS)) return floorHour(ms);
  }
  return hasSpan ? floorHour(spanMs) : null;
}

// SQL of turnHourMs for a DateTime64 span start. The id time (at most 48 bits) and the span
// time are chosen as integer milliseconds and converted once, so no id time can wrap.
export function turnHourSql(turnIdExpr, tsExpr) {
  const idMs = `toInt64(reinterpretAsUInt64(reverse(unhex(concat(substring(${turnIdExpr}, 1, 8), substring(${turnIdExpr}, 10, 4))))))`;
  const spanMs = `toUnixTimestamp64Milli(${tsExpr})`;
  return `toStartOfHour(toDateTime(intDiv(if(match(${turnIdExpr}, '${UUID_V7_SQL}')
        AND ${idMs} >= ${spanMs} - ${TURN_ID_MAX_AGE_MS}
        AND ${idMs} <= ${spanMs} + ${TURN_ID_MAX_LEAD_MS},
      ${idMs}, ${spanMs}), 1000), 'UTC'))`;
}

// namesTurnOnTools() (taskTraces.js) in SQL: Codex 0.166 and later name the turn on tool spans.
// Major and minor are compared as numbers, as Number() parses them; suffixes are ignored.
export function namesTurnOnToolsSql(versionExpr) {
  const groups = `extractGroups(${versionExpr}, '^(\\\\d+)\\\\.(\\\\d+)')`;
  return `toUInt8(length(${groups}) = 2
      AND (toFloat64OrZero(${groups}[1]) > 0 OR toFloat64OrZero(${groups}[2]) >= 166))`;
}

const TURN_ID = "coalesce(nullIf(SpanAttributes['turn_id'], ''), SpanAttributes['turn.id'])";
const SPAWN = () => `SpanName IN (${SPAWN_SPANS.map(name => `'${name}'`).join(", ")})`;

// One record per stored Codex turn span with its derived columns, as codexTurnSql reads them.
// The end is the raw read's millisecond end (start ms + whole duration ms), so the merged
// maximum equals its end_ms exactly. Aliases avoid otel_traces column names.
export function codexTurnSpans(where = "1") {
  return `SELECT ${turnHourSql("turn_id_raw", "Timestamp")} AS TurnHour,
    coalesce(nullIf(ResourceAttributes['user.email'], ''), nullIf(ResourceAttributes['enduser.id'], ''), '') AS UserIdentity,
    ${TURN_ID} AS turn_id_raw,
    turn_id_raw AS TurnId,
    SpanAttributes['conversation.id'] AS turn_conversation,
    Timestamp AS span_start,
    toDateTime64(fromUnixTimestamp64Milli(toUnixTimestamp64Milli(Timestamp) + intDiv(Duration, 1000000), 'UTC'), 9) AS span_end,
    SpanName,
    cityHash64(TraceId, SpanId) AS span_key,
    coalesce(nullIf(SpanAttributes['model'], ''), SpanAttributes['gen_ai.request.model']) AS span_model,
    ResourceAttributes['service.version'] AS span_version,
    ${namesTurnOnToolsSql("span_version")} AS span_names_turn
  FROM claude_code.otel_traces
  WHERE ResourceAttributes['client'] = 'codex'
    AND ${TURN_SPAN}
    AND (${where})`;
}

export function codexTurnsTransform(where = "1") {
  return `SELECT TurnHour, UserIdentity, TurnId,
  groupUniqArrayStateIf(turn_conversation, turn_conversation != '') AS Conversations,
  min(span_start) AS StartTs,
  max(span_end) AS EndTs,
  uniqExactStateIf(span_key, SpanName = 'codex.sampling') AS SamplingSpans,
  uniqExactStateIf(span_key, SpanName = 'run_sampling_request') AS LegacySpans,
  groupUniqArrayStateIf(span_model, SpanName = 'codex.sampling' AND span_model != '') AS SamplingModels,
  groupUniqArrayStateIf(span_model, SpanName = 'run_sampling_request' AND span_model != '') AS LegacyModels,
  uniqExactStateIf(span_key, SpanName = 'try_run_sampling_request') AS SamplingTries,
  uniqExactStateIf(span_key, SpanName = 'codex.compaction') AS Compactions,
  uniqExactStateIf(span_key, ${SPAWN()}) AS SpawnCalls,
  max(span_names_turn) AS NamesTurnOnTools,
  maxIf(span_version, span_version != '') AS AppVersion
FROM (
  ${codexTurnSpans(where)}
)
WHERE TurnId != ''
GROUP BY TurnHour, UserIdentity, TurnId`;
}

export function codexTurnsSchemaSql({ replicated = false } = {}) {
  const cluster = replicated ? " ON CLUSTER 'replicated'" : "";
  return `CREATE TABLE IF NOT EXISTS claude_code.${TURNS_ROLLUP_TABLE}${cluster}
(
  ${TURNS_ROLLUP_COLUMNS.map(([column, type]) => `${column} ${type} CODEC(ZSTD(1))`).join(",\n  ")}
)
ENGINE = ${replicated ? `ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/${TURNS_ROLLUP_TABLE}', '{replica}')` : "AggregatingMergeTree()"}
PARTITION BY toYYYYMM(TurnHour)
ORDER BY (${ORDER})
TTL ${replicated ? "TurnHour + INTERVAL 45 DAY TO VOLUME 'cold',\n  " : ""}TurnHour + INTERVAL 90 DAY DELETE${replicated ? "\nSETTINGS storage_policy = 'hot_cold'" : ""};

CREATE MATERIALIZED VIEW IF NOT EXISTS claude_code.${TURNS_ROLLUP_TABLE}_mv${cluster}
TO claude_code.${TURNS_ROLLUP_TABLE}
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
${codexTurnsTransform()};`;
}

export function codexTurnsBackfillSql() {
  const from = "{backfillFrom:DateTime('UTC')}", to = "{backfillTo:DateTime('UTC')}";
  return `SELECT throwIf(${to} <= ${from}
  OR dateDiff('second', ${from}, ${to}) > 86400,
  'Codex turns backfill requires a positive interval of at most one day');

INSERT INTO claude_code.${TURNS_ROLLUP_TABLE} (${TURNS_ROLLUP_COLUMNS.map(([name]) => name).join(", ")})
${codexTurnsTransform(`Timestamp >= ${from} AND Timestamp < ${to}`)};`;
}

// Activation gate: for turns with a row in one hour-aligned UTC window, the merged rollup
// against raw spans, grouped by owner and turn id (a non-v7 turn's hour rows merge). Both sides
// group the same turn hours, [verifyFrom, verifyTo + age + lead): rollup rows by TurnHour, raw
// spans by the same derived TurnHour, so a span keyed to an earlier id hour never joins a later
// fragment's row (a v7 span past the id age has its own hour). A span of such an hour starts at
// or after verifyFrom - TURN_ID_MAX_LEAD_MS, and one of a window hour before verifyTo +
// TURN_ID_MAX_AGE_MS: the raw scan, so every window row is compared whole. A turn whose rollup
// end reaches the raw end may have spans past it and is reported as clipped, kept out of
// differs. A turn is compared in each window holding one of its rows, over its rows from that
// window on. Any differs = 1 row blocks, as does a UUID turn with two conversations (reads pick
// one). A synthetic id groups spans of several conversations, so it differs only when the
// conversation sets differ. A turn present on one side only differs.
export function codexTurnsVerifySql() {
  const from = "{verifyFrom:DateTime('UTC')}", to = "{verifyTo:DateTime('UTC')}";
  const hours = ms => `INTERVAL ${ms / HOUR_MS} HOUR`;
  const lower = `${from} - ${hours(TURN_ID_MAX_LEAD_MS)}`, upper = `${to} + ${hours(TURN_ID_MAX_AGE_MS)}`;
  const turnHours = `TurnHour >= ${from} AND TurnHour < ${to} + ${hours(TURN_ID_MAX_AGE_MS + TURN_ID_MAX_LEAD_MS)}`;
  const scope = `HAVING min(TurnHour) < ${to}`;
  const pairs = ["conversations", "start_ts", "end_ts", "sampling", "legacy", "sampling_models",
    "legacy_models", "tries", "compactions", "spawns", "names_turn", "version"];
  return `SELECT throwIf(${to} <= ${from}
  OR toStartOfHour(${from}) != ${from} OR toStartOfHour(${to}) != ${to},
  'Codex turns verification requires a positive hour-aligned UTC window');

SELECT turn_id, differs, clipped
FROM (
  SELECT TurnId AS turn_id,
    ifNull(t.present, 0) = 1 AS t_present, ifNull(r.present, 0) = 1 AS r_present,
    toUInt8(t_present AND t.end_ts >= ${upper}) AS clipped,
    toUInt8(NOT (t_present AND r_present) OR (NOT clipped AND ((match(TurnId, '${UUID_SQL}') AND length(t.conversations) > 1)
      OR ${pairs.map(name => `t.${name} != r.${name}`).join("\n      OR ")}))) AS differs
  FROM (
    SELECT UserIdentity, TurnId, toUInt8(1) AS present,
      arraySort(groupUniqArrayMerge(Conversations)) AS conversations,
      min(StartTs) AS start_ts, max(EndTs) AS end_ts,
      uniqExactMerge(SamplingSpans) AS sampling, uniqExactMerge(LegacySpans) AS legacy,
      arraySort(groupUniqArrayMerge(SamplingModels)) AS sampling_models,
      arraySort(groupUniqArrayMerge(LegacyModels)) AS legacy_models,
      uniqExactMerge(SamplingTries) AS tries, uniqExactMerge(Compactions) AS compactions,
      uniqExactMerge(SpawnCalls) AS spawns, max(NamesTurnOnTools) AS names_turn,
      max(AppVersion) AS version
    FROM claude_code.${TURNS_ROLLUP_TABLE}
    WHERE ${turnHours}
    GROUP BY UserIdentity, TurnId
    ${scope}
  ) AS t
  FULL OUTER JOIN (
    SELECT UserIdentity, TurnId, toUInt8(1) AS present,
      arraySort(groupUniqArrayIf(turn_conversation, turn_conversation != '')) AS conversations,
      min(span_start) AS start_ts, max(span_end) AS end_ts,
      uniqExactIf(span_key, SpanName = 'codex.sampling') AS sampling,
      uniqExactIf(span_key, SpanName = 'run_sampling_request') AS legacy,
      arraySort(groupUniqArrayIf(span_model, SpanName = 'codex.sampling' AND span_model != '')) AS sampling_models,
      arraySort(groupUniqArrayIf(span_model, SpanName = 'run_sampling_request' AND span_model != '')) AS legacy_models,
      uniqExactIf(span_key, SpanName = 'try_run_sampling_request') AS tries,
      uniqExactIf(span_key, SpanName = 'codex.compaction') AS compactions,
      uniqExactIf(span_key, ${SPAWN()}) AS spawns,
      max(span_names_turn) AS names_turn,
      maxIf(span_version, span_version != '') AS version
    FROM (
    ${codexTurnSpans(`Timestamp >= ${lower} AND Timestamp < ${upper}`)}
    )
    WHERE TurnId != '' AND ${turnHours}
    GROUP BY UserIdentity, TurnId
    ${scope}
  ) AS r USING (UserIdentity, TurnId)
)
ORDER BY differs DESC, clipped DESC, turn_id;`;
}
