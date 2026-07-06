-- ../clickhouse-schema.sql를 CHI(replicated 클러스터, 2레플리카)용으로 변환한 버전.
-- 컬럼/MATERIALIZED 정의는 원본과 동일 — 다른 점: ON CLUSTER, ReplicatedMergeTree,
-- 콜드 티어링 TTL(90일 후 S3 volume 'cold'로 이동, 180일 후 삭제 — 원본과 동일한 삭제 시점).
-- 실측 후 attribute 키가 다르면 이 파일과 ../clickhouse-schema.sql 둘 다 갱신할 것.

CREATE DATABASE IF NOT EXISTS claude_code ON CLUSTER 'replicated';

CREATE TABLE IF NOT EXISTS claude_code.otel_metrics_sum ON CLUSTER 'replicated'
(
    ResourceAttributes   Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeName            String CODEC(ZSTD(1)),
    MetricName           LowCardinality(String) CODEC(ZSTD(1)),
    Attributes           Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    StartTimeUnix        DateTime64(9) CODEC(Delta, ZSTD(1)),
    TimeUnix             DateTime64(9) CODEC(Delta, ZSTD(1)),
    Value                Float64 CODEC(ZSTD(1)),
    AggregationTemporality Int32,
    IsMonotonic          Bool,

    ExperimentGroup LowCardinality(String) MATERIALIZED ResourceAttributes['experiment.group'],
    Team            LowCardinality(String) MATERIALIZED ResourceAttributes['team'],
    UserEmail       LowCardinality(String) MATERIALIZED ResourceAttributes['user.email'],
    Model           LowCardinality(String) MATERIALIZED Attributes['model'],
    TokenType       LowCardinality(String) MATERIALIZED Attributes['type'],
    QuerySource     LowCardinality(String) MATERIALIZED Attributes['query_source'],
    Decision        LowCardinality(String) MATERIALIZED Attributes['decision'],
    Language        LowCardinality(String) MATERIALIZED Attributes['language'],
    SkillName       LowCardinality(String) MATERIALIZED Attributes['skill.name'],
    AgentName       LowCardinality(String) MATERIALIZED Attributes['agent.name']
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/otel_metrics_sum', '{replica}')
PARTITION BY toYYYYMM(TimeUnix)
ORDER BY (ExperimentGroup, MetricName, Model, toUnixTimestamp(TimeUnix))
TTL toDateTime(TimeUnix) + INTERVAL 90 DAY TO VOLUME 'cold',
    toDateTime(TimeUnix) + INTERVAL 180 DAY DELETE
SETTINGS storage_policy = 'hot_cold';

CREATE TABLE IF NOT EXISTS claude_code.otel_metrics_gauge ON CLUSTER 'replicated'
(
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeName          String CODEC(ZSTD(1)),
    MetricName         LowCardinality(String) CODEC(ZSTD(1)),
    Attributes         Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    StartTimeUnix      DateTime64(9) CODEC(Delta, ZSTD(1)),
    TimeUnix           DateTime64(9) CODEC(Delta, ZSTD(1)),
    Value              Float64 CODEC(ZSTD(1)),

    ExperimentGroup LowCardinality(String) MATERIALIZED ResourceAttributes['experiment.group'],
    UserEmail       LowCardinality(String) MATERIALIZED ResourceAttributes['user.email'],
    Model           LowCardinality(String) MATERIALIZED Attributes['model']
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/otel_metrics_gauge', '{replica}')
PARTITION BY toYYYYMM(TimeUnix)
ORDER BY (ExperimentGroup, MetricName, toUnixTimestamp(TimeUnix))
TTL toDateTime(TimeUnix) + INTERVAL 90 DAY TO VOLUME 'cold',
    toDateTime(TimeUnix) + INTERVAL 180 DAY DELETE
SETTINGS storage_policy = 'hot_cold';

CREATE TABLE IF NOT EXISTS claude_code.otel_logs ON CLUSTER 'replicated'
(
    Timestamp          DateTime64(9) CODEC(Delta, ZSTD(1)),
    TraceId            String CODEC(ZSTD(1)),
    SpanId             String CODEC(ZSTD(1)),
    SeverityText       LowCardinality(String) CODEC(ZSTD(1)),
    SeverityNumber     Int32,
    ServiceName        LowCardinality(String) CODEC(ZSTD(1)),
    Body               String CODEC(ZSTD(1)),
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    LogAttributes      Map(LowCardinality(String), String) CODEC(ZSTD(1)),

    ExperimentGroup LowCardinality(String) MATERIALIZED ResourceAttributes['experiment.group'],
    UserEmail       LowCardinality(String) MATERIALIZED ResourceAttributes['user.email'],
    EventName       LowCardinality(String) MATERIALIZED LogAttributes['event.name'],
    SessionId       String                 MATERIALIZED LogAttributes['session.id'],
    ToolName        LowCardinality(String) MATERIALIZED LogAttributes['tool_name'],
    McpServerName   LowCardinality(String) MATERIALIZED LogAttributes['mcp_server_name'],
    McpToolName     LowCardinality(String) MATERIALIZED LogAttributes['mcp_tool_name'],
    Success         LowCardinality(String) MATERIALIZED LogAttributes['success']
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/otel_logs', '{replica}')
PARTITION BY toYYYYMM(Timestamp)
ORDER BY (ExperimentGroup, EventName, toUnixTimestamp(Timestamp))
TTL toDateTime(Timestamp) + INTERVAL 45 DAY TO VOLUME 'cold',
    toDateTime(Timestamp) + INTERVAL 90 DAY DELETE
SETTINGS storage_policy = 'hot_cold';
