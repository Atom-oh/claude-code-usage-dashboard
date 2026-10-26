import { backendSql } from "./backend.js";
import { CODEX_USAGE_KEYS, REJECTED_REQUEST_STATUSES, SETUP_METADATA_EVENTS } from "./codexRequests.js";

// Insertion transforms and backfills share this versioned definition. A change to
// classification/identity requires a new version and verified data migration.
export const COST_TOKEN_FIELDS = [
  ["input_token_count", "Input", "in_n"],
  ["cached_token_count", "CacheRead", "read_n"],
  ["cache_write_token_count", "CacheWrite", "write_n"],
  ["output_token_count", "Output", "out_n"],
  ["reasoning_token_count", "Reasoning", "reason_n"],
];
const list = (values) => `[${values.map(value => `'${value}'`).join(",")}]`;
const stream = "EventName IN ('codex.sse_event','codex.websocket_event')";
// Avoid a lambda capturing the entire map: ClickHouse expands its string values
// for every candidate key, multiplying memory on large insert/backfill blocks.
const usageKeys = `hasAny(mapKeys(LogAttributes), ${list(CODEX_USAGE_KEYS)})`;
const kind = `multiIf(
  ${stream} AND LogAttributes['event.kind'] = 'response.completed'
    AND hasAny(mapKeys(LogAttributes), ${list(COST_TOKEN_FIELDS.map(([key]) => key))}), 'usage',
  ${stream} AND LogAttributes['event.kind'] = 'response.completed', 'completion',
  ${stream} AND LogAttributes['event.kind'] = 'response.failed', 'stream_error',
  ${stream}, 'scope_evidence',
  EventName IN ('codex.api_request','codex.api_error'), 'request',
  EventName = 'codex.tool_result', 'tool',
  EventName = 'codex.tool_decision', 'approval',
  EventName = 'codex.turn_ttft', 'ttft',
  NOT has(${list(SETUP_METADATA_EVENTS)}, EventName) OR ${usageKeys}, 'scope_evidence', '')`;
const dimensions = `coalesce(nullIf(ResourceAttributes['user.email'], ''),
    nullIf(ResourceAttributes['enduser.id'], ''), '') AS UserEmail,
  LogAttributes['conversation.id'] AS ConversationId, LogAttributes['model'] AS Model,
  ${backendSql("LogAttributes['model']", "ResourceAttributes['backend']")} AS Backend,
  ResourceAttributes['project.name'] AS ProjectName, EventName`;

export function costTransform(type, where = "1") {
  if (!["events", "scope"].includes(type)) throw new Error("Unknown Codex cost transform");
  const source = `FROM claude_code.otel_logs
  WHERE startsWith(EventName, 'codex.') AND (${where})`;
  if (type === "scope") return `SELECT toStartOfMinute(Timestamp) AS Minute, ${dimensions},
  groupUniqArrayState(toUInt8(toSecond(Timestamp))) AS Seconds
  ${source} AND (${kind}) = 'scope_evidence'
  GROUP BY Minute, UserEmail, ConversationId, Model, Backend, ProjectName, EventName`;
  return `SELECT Timestamp,
  toJSONString(tuple(mapSort(ResourceAttributes),mapSort(LogAttributes))) AS Identity,
  ${dimensions}, ${kind} AS Kind,
  toUInt8(EventName IN ('codex.api_request','codex.api_error')
    AND has(${list(REJECTED_REQUEST_STATUSES)}, trimBoth(LogAttributes['http.response.status_code']))
    AND NOT ${usageKeys}) AS Rejected,
  ${COST_TOKEN_FIELDS.map(([key, column]) => `toFloat64OrZero(LogAttributes['${key}']) AS ${column}Value,
  toUInt8(mapContains(LogAttributes,'${key}')
    AND isNotNull(toFloat64OrNull(LogAttributes['${key}']))
    AND isFinite(${column}Value) AND ${column}Value >= 0
    AND floor(${column}Value) = ${column}Value AND ${column}Value <= 9007199254740991) AS ${column}Valid`).join(",\n  ")}
  ${source} AND Kind NOT IN ('','scope_evidence')`;
}

export const COST_COLUMNS = {
  events: [
    ["Timestamp", "DateTime64(9)"], ["Identity", "String"], ["UserEmail", "String"],
    ["ConversationId", "String"], ["Model", "LowCardinality(String)"],
    ["Backend", "LowCardinality(String)"], ["ProjectName", "String"],
    ["EventName", "LowCardinality(String)"], ["Kind", "LowCardinality(String)"],
    ["Rejected", "UInt8"],
    ...COST_TOKEN_FIELDS.flatMap(([, column]) => [[`${column}Value`, "Float64"], [`${column}Valid`, "UInt8"]]),
  ],
  scope: [
    ["Minute", "DateTime"], ["UserEmail", "String"], ["ConversationId", "String"],
    ["Model", "LowCardinality(String)"], ["Backend", "LowCardinality(String)"],
    ["ProjectName", "String"], ["EventName", "LowCardinality(String)"],
    ["Seconds", "AggregateFunction(groupUniqArray, UInt8)"],
  ],
};

export function costSchemaSql({ replicated = false } = {}) {
  const cluster = replicated ? " ON CLUSTER 'replicated'" : "";
  return ["events", "scope"].map(type => {
    const name = `codex_cost_${type}_v1`, time = type === "events" ? "Timestamp" : "Minute";
    const engine = type === "events" ? "MergeTree" : "AggregatingMergeTree";
    return `CREATE TABLE IF NOT EXISTS claude_code.${name}${cluster}
(
  ${COST_COLUMNS[type].map(([column, dataType]) => `${column} ${dataType} CODEC(ZSTD(1))`).join(",\n  ")}
)
ENGINE = ${replicated ? `Replicated${engine}('/clickhouse/tables/{shard}/${name}', '{replica}')` : `${engine}()`}
PARTITION BY toYYYYMM(${time})
ORDER BY (UserEmail, ${time}, Model, ConversationId, Backend, ProjectName, EventName)
TTL toDateTime(${time}) + INTERVAL ${replicated ? "45 DAY TO VOLUME 'cold',\n  toDateTime(" + time + ") + INTERVAL " : ""}90 DAY DELETE${replicated ? "\nSETTINGS storage_policy = 'hot_cold'" : ""};

CREATE MATERIALIZED VIEW IF NOT EXISTS claude_code.${name}_mv${cluster}
TO claude_code.${name}
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
${costTransform(type)};`;
  }).join("\n\n");
}

export function costBackfillSql() {
  return `SELECT throwIf({backfillTo:DateTime} <= {backfillFrom:DateTime}
  OR dateDiff('second', {backfillFrom:DateTime}, {backfillTo:DateTime}) > 86400,
  'Codex cost backfill requires a positive interval of at most one day');

` + ["events", "scope"].map(type => `INSERT INTO claude_code.codex_cost_${type}_v1
${costTransform(type, "Timestamp >= {backfillFrom:DateTime} AND Timestamp < {backfillTo:DateTime}")};`).join("\n\n");
}
