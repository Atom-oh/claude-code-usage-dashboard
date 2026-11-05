// Session-hour evidence of the Claude Code `anthropic.provider` attribute
// (v2.1.317+), for the companion grouping release to replace the model/organization
// heuristic for sessions that report a provider. Kept outside the hourly
// rollup so the rollup's keys and sums stay untouched and backfill repeats
// cannot inflate usage: the table stores only key membership.
export const PROVIDER_TABLE = "claude_session_providers_v1";
export const PROVIDER_COLUMNS = [
  ["hour", "DateTime"], ["SessionId", "String"], ["Provider", "LowCardinality(String)"],
];
const ORDER = "SessionId, Provider, hour";

export function providerTransform(where = "1") {
  return `SELECT toStartOfHour(toDateTime(TimeUnix)) AS hour, SessionId,
    Attributes['anthropic.provider'] AS Provider
  FROM claude_code.otel_metrics_sum
  WHERE SessionId != '' AND Attributes['anthropic.provider'] != '' AND (${where})
  GROUP BY hour, SessionId, Provider`;
}

export function providerSchemaSql({ replicated = false } = {}) {
  const cluster = replicated ? " ON CLUSTER 'replicated'" : "";
  return `CREATE TABLE IF NOT EXISTS claude_code.${PROVIDER_TABLE}${cluster}
(
  ${PROVIDER_COLUMNS.map(([column, type]) => `${column} ${type} CODEC(ZSTD(1))`).join(",\n  ")}
)
ENGINE = ${replicated ? `ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${PROVIDER_TABLE}', '{replica}')` : "ReplacingMergeTree()"}
PARTITION BY toYYYYMM(hour)
ORDER BY (${ORDER})
TTL hour + INTERVAL 180 DAY DELETE${replicated ? "\nSETTINGS storage_policy = 'hot_cold'" : ""};

CREATE MATERIALIZED VIEW IF NOT EXISTS claude_code.${PROVIDER_TABLE}_mv${cluster}
TO claude_code.${PROVIDER_TABLE}
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
${providerTransform()};`;
}

export function providerBackfillSql() {
  const from = "{backfillFrom:DateTime('UTC')}", to = "{backfillTo:DateTime('UTC')}";
  return `SELECT throwIf(${to} <= ${from}
  OR dateDiff('second', ${from}, ${to}) > 86400,
  'Claude provider backfill requires a positive interval of at most one day');

INSERT INTO claude_code.${PROVIDER_TABLE} (${PROVIDER_COLUMNS.map(([name]) => name).join(", ")})
${providerTransform(`TimeUnix >= ${from} AND TimeUnix < ${to}`)};`;
}
