import { backendSql } from "./backend.js";
import { CODEX_USAGE_KEYS } from "./codexRequests.js";

const strings = values => `[${values.map(value => `'${value}'`).join(",")}]`;
const ATTRIBUTES = ["event.name", "event.kind", "duration_ms", "attempt",
  "http.response.status_code", "error", "error.message", "success", "tool_name",
  "decision", "source", "startup.phase", ...CODEX_USAGE_KEYS];

// These values support only diagnostic profiles. Token amounts and error text
// are unnecessary, but their presence still affects event classification.
export function diagnosticAttributesSql(attributes = "LogAttributes") {
  return `mapApply((k,v) -> (k, multiIf(has(${strings(CODEX_USAGE_KEYS)}, k), 'present',
    k IN ('error','error.message'), if(v = '', '', 'present'), v)),
    mapFilter((k,v) -> has(${strings(ATTRIBUTES)}, k), ${attributes}))`;
}

// The state uses the same tuple as the raw query. Selection dimensions and the
// second are deterministic for each identity, so summing finalized, merged
// states cannot count one identity in more than one group.
export const DIAGNOSTIC_COLUMNS = [
  ["UserEmail", "String"], ["Second", "DateTime"], ["Model", "LowCardinality(String)"],
  ["ConversationId", "String"], ["Backend", "LowCardinality(String)"], ["ProjectName", "String"],
  ["AttributesJSON", "String"],
  ["MinTimestamp", "SimpleAggregateFunction(min, DateTime64(9))"],
  ["MaxTimestamp", "SimpleAggregateFunction(max, DateTime64(9))"],
  ["Identities", "AggregateFunction(uniqExact, Tuple(String, Map(LowCardinality(String), String), Map(LowCardinality(String), String)))"],
];
const ORDER = "UserEmail, Second, Model, ConversationId, Backend, ProjectName, AttributesJSON";

export function diagnosticTransform(where = "1") {
  // Sort before every lookup, like logSelection. With duplicate map keys,
  // looking up first and sorting afterward can select a different value.
  // Preserve that canonical order when filtering the diagnostic projection.
  return `WITH mapSort(ResourceAttributes) AS r, mapSort(LogAttributes) AS a
  SELECT coalesce(nullIf(r['user.email'], ''), nullIf(r['enduser.id'], ''), '') AS UserEmail,
  toStartOfSecond(Timestamp) AS Second, a['model'] AS Model,
  a['conversation.id'] AS ConversationId,
  ${backendSql("a['model']", "r['backend']")} AS Backend,
  r['project.name'] AS ProjectName,
  toJSONString(${diagnosticAttributesSql("a")}) AS AttributesJSON,
  min(Timestamp) AS MinTimestamp, max(Timestamp) AS MaxTimestamp,
  uniqExactState(tuple(toString(toTimeZone(Timestamp, 'UTC')), r, a)) AS Identities
  FROM claude_code.otel_logs
  WHERE startsWith(EventName, 'codex.')
    AND startsWith(a['event.name'], 'codex.') AND (${where})
  GROUP BY ${ORDER}`;
}

export function diagnosticSchemaSql({ replicated = false } = {}) {
  const name = "codex_diagnostic_events_v1";
  const cluster = replicated ? " ON CLUSTER 'replicated'" : "";
  return `CREATE TABLE IF NOT EXISTS claude_code.${name}${cluster}
(
  ${DIAGNOSTIC_COLUMNS.map(([column, type]) => `${column} ${type} CODEC(ZSTD(1))`).join(",\n  ")}
)
ENGINE = ${replicated ? `ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/${name}', '{replica}')` : "AggregatingMergeTree()"}
PARTITION BY toYYYYMM(Second)
ORDER BY (${ORDER})
TTL toDateTime(Second) + INTERVAL ${replicated ? "45 DAY TO VOLUME 'cold',\n  toDateTime(Second) + INTERVAL " : ""}90 DAY DELETE${replicated ? "\nSETTINGS storage_policy = 'hot_cold'" : ""};

CREATE MATERIALIZED VIEW IF NOT EXISTS claude_code.${name}_mv${cluster}
TO claude_code.${name}
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
${diagnosticTransform()};`;
}

export function diagnosticBackfillSql() {
  const from = "{backfillFrom:DateTime('UTC')}", to = "{backfillTo:DateTime('UTC')}";
  return `SELECT throwIf(${to} <= ${from}
  OR dateDiff('second', ${from}, ${to}) > 86400,
  'Codex diagnostic backfill requires a positive interval of at most one day');

INSERT INTO claude_code.codex_diagnostic_events_v1 (${DIAGNOSTIC_COLUMNS.map(([name]) => name).join(", ")})
${diagnosticTransform(`Timestamp >= ${from} AND Timestamp < ${to}`)};`;
}
