// Exact turn/request key sets per session-hour. Each hour stores the set of
// deduplicated record keys, so counts stay exact across hours, repeated
// backfill and duplicate delivery: uniqExact states union, they never add.
// A transform change requires a new table version and migration.
export const TURNS_TABLE = "session_turns_v1";
export const TURNS_COLUMNS = [
  ["hour", "DateTime"], ["Client", "LowCardinality(String)"], ["SessionId", "String"],
  ["UserIdentity", "String"], ["Kind", "LowCardinality(String)"], ["Model", "LowCardinality(String)"],
  ["Keys", "AggregateFunction(uniqExact, UInt64)"],
];
const ORDER = "Client, SessionId, hour, Kind, Model, UserIdentity";

// Claude Code resumes may restart sequences and duplicate deliveries repeat
// Timestamp, so a record is identified by prompt id, sequence or content hash.
// `prefix` is a table alias ("l.") or empty.
const recordKey = prefix => `concat('r:', toString(${prefix}Timestamp), ':', toString(cityHash64(toString(mapSort(${prefix}LogAttributes)))))`;
const sequence = prefix => `${prefix}LogAttributes['event.sequence']`;
const sequenceKey = prefix => `concat('s:', ${sequence(prefix)}, ':', toString(${prefix}Timestamp))`;

export function claudeTurnKeySql(prefix = "") {
  return `multiIf(${prefix}PromptId != '', concat('p:', ${prefix}PromptId), ${sequence(prefix)} != '', ${sequenceKey(prefix)}, ${recordKey(prefix)})`;
}

export function claudeCallKeySql(prefix = "") {
  return `if(${sequence(prefix)} != '', ${sequenceKey(prefix)}, ${recordKey(prefix)})`;
}

const CLAUDE_PROMPT = "EventName IN ('user_prompt', 'claude_code.user_prompt')";
const CLAUDE_REQUEST = "EventName IN ('api_request', 'claude_code.api_request')";
const CODEX_PROMPT = "EventName = 'codex.user_prompt'";
const CODEX_KEY = "concat(toString(Timestamp), toString(mapSort(ResourceAttributes)), toString(mapSort(LogAttributes)))";
export const codexTurnKeySql = () => CODEX_KEY;

export function turnsTransform(where = "1") {
  return `SELECT hour, Client, Sid AS SessionId, UserIdentity, Kind, Mdl AS Model,
  uniqExactState(cityHash64(Key)) AS Keys
FROM (
  SELECT toStartOfHour(toDateTime(Timestamp, 'UTC')) AS hour,
    multiIf(${CODEX_PROMPT}, 'codex', 'claude') AS Client,
    if(${CODEX_PROMPT}, LogAttributes['conversation.id'], SessionId) AS Sid,
    coalesce(nullIf(ResourceAttributes['user.email'], ''),
      nullIf(ResourceAttributes['enduser.id'], ''), '') AS UserIdentity,
    if(${CLAUDE_REQUEST}, 'request', 'turn') AS Kind,
    if(${CLAUDE_REQUEST}, LogAttributes['model'], '') AS Mdl,
    multiIf(${CLAUDE_PROMPT}, ${claudeTurnKeySql("")},
      ${CLAUDE_REQUEST}, ${claudeCallKeySql("")},
      ${CODEX_KEY}) AS Key
  FROM claude_code.otel_logs
  WHERE (${CLAUDE_PROMPT} OR ${CLAUDE_REQUEST} OR ${CODEX_PROMPT}) AND (${where})
)
WHERE SessionId != ''
GROUP BY hour, Client, SessionId, UserIdentity, Kind, Model`;
}

export function turnsSchemaSql({ replicated = false } = {}) {
  const cluster = replicated ? " ON CLUSTER 'replicated'" : "";
  return `CREATE TABLE IF NOT EXISTS claude_code.${TURNS_TABLE}${cluster}
(
  ${TURNS_COLUMNS.map(([column, type]) => `${column} ${type} CODEC(ZSTD(1))`).join(",\n  ")}
)
ENGINE = ${replicated ? `ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/${TURNS_TABLE}', '{replica}')` : "AggregatingMergeTree()"}
PARTITION BY toYYYYMM(hour)
ORDER BY (${ORDER})
TTL ${replicated ? "hour + INTERVAL 45 DAY TO VOLUME 'cold',\n  " : ""}hour + INTERVAL 90 DAY DELETE${replicated ? "\nSETTINGS storage_policy = 'hot_cold'" : ""};

CREATE MATERIALIZED VIEW IF NOT EXISTS claude_code.${TURNS_TABLE}_mv${cluster}
TO claude_code.${TURNS_TABLE}
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
${turnsTransform()};`;
}

export function turnsBackfillSql() {
  const from = "{backfillFrom:DateTime('UTC')}", to = "{backfillTo:DateTime('UTC')}";
  return `SELECT throwIf(${to} <= ${from}
  OR dateDiff('second', ${from}, ${to}) > 86400,
  'Session turns backfill requires a positive interval of at most one day');

INSERT INTO claude_code.${TURNS_TABLE} (${TURNS_COLUMNS.map(([name]) => name).join(", ")})
${turnsTransform(`Timestamp >= ${from} AND Timestamp < ${to}`)};`;
}
