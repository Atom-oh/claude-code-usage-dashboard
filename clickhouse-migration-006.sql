-- migration: 006 | requires: 004 | records itself: INSERT INTO claude_code.schema_migrations
-- Dedicated Codex diagnostic metrics; logs remain the sole usage/cost feed.
-- Additive only: no existing tables, rollups or data are changed.
-- Columns follow contrib v0.119.0 exporter/clickhouseexporter/internal/*_metrics.go.
-- Apply this file once through one replica. It does not require migration 005.
-- Existing otel_traces (002) is used unchanged by the Codex trace pipeline.
-- Verify all replica schemas and retention before enabling the new pipeline.
-- Histogram Sum/Min/Max are non-nullable in this exporter; absence becomes zero.
-- Exponential histograms have no ZeroThreshold column in the pinned exporter.

SELECT throwIf((SELECT count() FROM claude_code.schema_migrations WHERE version = 4) = 0,
'Migration 006 requires the existing 004 ledger');

CREATE TABLE IF NOT EXISTS claude_code.codex_metrics_sum ON CLUSTER 'replicated'
(
ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
ResourceSchemaUrl String CODEC(ZSTD(1)),
ScopeName String CODEC(ZSTD(1)),
ScopeVersion String CODEC(ZSTD(1)),
ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
ScopeSchemaUrl String CODEC(ZSTD(1)),
ServiceName LowCardinality(String) CODEC(ZSTD(1)),
MetricName String CODEC(ZSTD(1)),
MetricDescription String CODEC(ZSTD(1)),
MetricUnit String CODEC(ZSTD(1)),
Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
StartTimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),
TimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),
Value Float64 CODEC(ZSTD(1)),
Flags UInt32  CODEC(ZSTD(1)),
Exemplars Nested (
FilteredAttributes Map(LowCardinality(String), String),
TimeUnix DateTime64(9),
Value Float64,
SpanId String,
TraceId String
) CODEC(ZSTD(1)),
AggregationTemporality Int32 CODEC(ZSTD(1)),
IsMonotonic Boolean CODEC(Delta, ZSTD(1))
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/codex_metrics_sum', '{replica}')
PARTITION BY toYYYYMM(TimeUnix)
ORDER BY (ServiceName, MetricName, ResourceAttributes, ScopeName, ScopeVersion, Attributes, StartTimeUnix, TimeUnix)
TTL toDateTime(TimeUnix) + INTERVAL 90 DAY TO VOLUME 'cold',
toDateTime(TimeUnix) + INTERVAL 180 DAY DELETE
SETTINGS storage_policy = 'hot_cold', ttl_only_drop_parts = 1;

CREATE TABLE IF NOT EXISTS claude_code.codex_metrics_gauge ON CLUSTER 'replicated'
(
ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
ResourceSchemaUrl String CODEC(ZSTD(1)),
ScopeName String CODEC(ZSTD(1)),
ScopeVersion String CODEC(ZSTD(1)),
ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
ScopeSchemaUrl String CODEC(ZSTD(1)),
ServiceName LowCardinality(String) CODEC(ZSTD(1)),
MetricName String CODEC(ZSTD(1)),
MetricDescription String CODEC(ZSTD(1)),
MetricUnit String CODEC(ZSTD(1)),
Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
StartTimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),
TimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),
Value Float64 CODEC(ZSTD(1)),
Flags UInt32 CODEC(ZSTD(1)),
Exemplars Nested (
FilteredAttributes Map(LowCardinality(String), String),
TimeUnix DateTime64(9),
Value Float64,
SpanId String,
TraceId String
) CODEC(ZSTD(1))
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/codex_metrics_gauge', '{replica}')
PARTITION BY toYYYYMM(TimeUnix)
ORDER BY (ServiceName, MetricName, ResourceAttributes, ScopeName, ScopeVersion, Attributes, StartTimeUnix, TimeUnix)
TTL toDateTime(TimeUnix) + INTERVAL 90 DAY TO VOLUME 'cold',
toDateTime(TimeUnix) + INTERVAL 180 DAY DELETE
SETTINGS storage_policy = 'hot_cold', ttl_only_drop_parts = 1;

CREATE TABLE IF NOT EXISTS claude_code.codex_metrics_histogram ON CLUSTER 'replicated'
(
ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
ResourceSchemaUrl String CODEC(ZSTD(1)),
ScopeName String CODEC(ZSTD(1)),
ScopeVersion String CODEC(ZSTD(1)),
ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
ScopeSchemaUrl String CODEC(ZSTD(1)),
ServiceName LowCardinality(String) CODEC(ZSTD(1)),
MetricName String CODEC(ZSTD(1)),
MetricDescription String CODEC(ZSTD(1)),
MetricUnit String CODEC(ZSTD(1)),
Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
StartTimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),
TimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),
Count UInt64 CODEC(Delta, ZSTD(1)),
Sum Float64 CODEC(ZSTD(1)),
BucketCounts Array(UInt64) CODEC(ZSTD(1)),
ExplicitBounds Array(Float64) CODEC(ZSTD(1)),
Exemplars Nested (
FilteredAttributes Map(LowCardinality(String), String),
TimeUnix DateTime64(9),
Value Float64,
SpanId String,
TraceId String
) CODEC(ZSTD(1)),
Flags UInt32 CODEC(ZSTD(1)),
Min Float64 CODEC(ZSTD(1)),
Max Float64 CODEC(ZSTD(1)),
AggregationTemporality Int32 CODEC(ZSTD(1))
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/codex_metrics_histogram', '{replica}')
PARTITION BY toYYYYMM(TimeUnix)
ORDER BY (ServiceName, MetricName, ResourceAttributes, ScopeName, ScopeVersion, Attributes, StartTimeUnix, TimeUnix)
TTL toDateTime(TimeUnix) + INTERVAL 90 DAY TO VOLUME 'cold',
toDateTime(TimeUnix) + INTERVAL 180 DAY DELETE
SETTINGS storage_policy = 'hot_cold', ttl_only_drop_parts = 1;

CREATE TABLE IF NOT EXISTS claude_code.codex_metrics_exponential_histogram ON CLUSTER 'replicated'
(
ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
ResourceSchemaUrl String CODEC(ZSTD(1)),
ScopeName String CODEC(ZSTD(1)),
ScopeVersion String CODEC(ZSTD(1)),
ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
ScopeSchemaUrl String CODEC(ZSTD(1)),
ServiceName LowCardinality(String) CODEC(ZSTD(1)),
MetricName String CODEC(ZSTD(1)),
MetricDescription String CODEC(ZSTD(1)),
MetricUnit String CODEC(ZSTD(1)),
Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
StartTimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),
TimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),
Count UInt64 CODEC(Delta, ZSTD(1)),
Sum Float64 CODEC(ZSTD(1)),
Scale Int32 CODEC(ZSTD(1)),
ZeroCount UInt64 CODEC(ZSTD(1)),
PositiveOffset Int32 CODEC(ZSTD(1)),
PositiveBucketCounts Array(UInt64) CODEC(ZSTD(1)),
NegativeOffset Int32 CODEC(ZSTD(1)),
NegativeBucketCounts Array(UInt64) CODEC(ZSTD(1)),
Exemplars Nested (
FilteredAttributes Map(LowCardinality(String), String),
TimeUnix DateTime64(9),
Value Float64,
SpanId String,
TraceId String
) CODEC(ZSTD(1)),
Flags UInt32  CODEC(ZSTD(1)),
Min Float64 CODEC(ZSTD(1)),
Max Float64 CODEC(ZSTD(1)),
AggregationTemporality Int32 CODEC(ZSTD(1))
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/codex_metrics_exponential_histogram', '{replica}')
PARTITION BY toYYYYMM(TimeUnix)
ORDER BY (ServiceName, MetricName, ResourceAttributes, ScopeName, ScopeVersion, Attributes, StartTimeUnix, TimeUnix)
TTL toDateTime(TimeUnix) + INTERVAL 90 DAY TO VOLUME 'cold',
toDateTime(TimeUnix) + INTERVAL 180 DAY DELETE
SETTINGS storage_policy = 'hot_cold', ttl_only_drop_parts = 1;

-- Record only an exporter-compatible local schema; inspect other replicas too.
INSERT INTO claude_code.schema_migrations (version, name, checksum) SELECT 6, '006-codex-native-signals', '8121f23e2905180cbdea4677f2de8ecc40a628a207fa24d7383e6abaf606ba2e'
FROM system.one
WHERE (SELECT count() FROM system.columns WHERE database = 'claude_code'
AND ((table IN ('codex_metrics_sum', 'codex_metrics_gauge', 'codex_metrics_histogram', 'codex_metrics_exponential_histogram')
AND (name, type) IN (
('ResourceAttributes', 'Map(LowCardinality(String), String)'),
('ResourceSchemaUrl', 'String'),
('ScopeName', 'String'),
('ScopeVersion', 'String'),
('ScopeAttributes', 'Map(LowCardinality(String), String)'),
('ScopeDroppedAttrCount', 'UInt32'),
('ScopeSchemaUrl', 'String'),
('ServiceName', 'LowCardinality(String)'),
('MetricName', 'String'),
('MetricDescription', 'String'),
('MetricUnit', 'String'),
('Attributes', 'Map(LowCardinality(String), String)'),
('StartTimeUnix', 'DateTime64(9)'),
('TimeUnix', 'DateTime64(9)'),
('Flags', 'UInt32'),
('Exemplars.FilteredAttributes', 'Array(Map(LowCardinality(String), String))'),
('Exemplars.TimeUnix', 'Array(DateTime64(9))'),
('Exemplars.Value', 'Array(Float64)'),
('Exemplars.SpanId', 'Array(String)'),
('Exemplars.TraceId', 'Array(String)')))
OR (table = 'codex_metrics_sum' AND (name, type) IN (
('Value', 'Float64'),
('AggregationTemporality', 'Int32'),
('IsMonotonic', 'Bool')))
OR (table = 'codex_metrics_gauge' AND (name, type) IN (
('Value', 'Float64')))
OR (table = 'codex_metrics_histogram' AND (name, type) IN (
('Count', 'UInt64'),
('Sum', 'Float64'),
('BucketCounts', 'Array(UInt64)'),
('ExplicitBounds', 'Array(Float64)'),
('Min', 'Float64'),
('Max', 'Float64'),
('AggregationTemporality', 'Int32')))
OR (table = 'codex_metrics_exponential_histogram' AND (name, type) IN (
('Count', 'UInt64'),
('Sum', 'Float64'),
('Scale', 'Int32'),
('ZeroCount', 'UInt64'),
('PositiveOffset', 'Int32'),
('PositiveBucketCounts', 'Array(UInt64)'),
('NegativeOffset', 'Int32'),
('NegativeBucketCounts', 'Array(UInt64)'),
('Min', 'Float64'),
('Max', 'Float64'),
('AggregationTemporality', 'Int32'))))) = 102
AND (SELECT count() FROM claude_code.schema_migrations WHERE version = 4) > 0
AND (SELECT count() FROM claude_code.schema_migrations WHERE version = 6) = 0;
