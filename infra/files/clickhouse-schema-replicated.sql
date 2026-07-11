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
    SessionId       String                 MATERIALIZED Attributes['session.id'],
    TokenType       LowCardinality(String) MATERIALIZED Attributes['type'],
    QuerySource     LowCardinality(String) MATERIALIZED Attributes['query_source'],
    Decision        LowCardinality(String) MATERIALIZED Attributes['decision'],
    Language        LowCardinality(String) MATERIALIZED Attributes['language'],
    SkillName       LowCardinality(String) MATERIALIZED Attributes['skill.name'],
    AgentName       LowCardinality(String) MATERIALIZED Attributes['agent.name'],
    -- 진짜 OTel 시리즈 식별자 — clickhouse-schema.sql(참조 사본)과 동기화 유지.
    -- 매 쿼리 인라인 cityHash64(toString(Attributes))는 1.2초, 이 컬럼은 0.11초(실측 2026-07-10).
    SeriesKey       UInt64                 MATERIALIZED cityHash64(toString(Attributes))
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/otel_metrics_sum', '{replica}')
PARTITION BY toYYYYMM(TimeUnix)
ORDER BY (ExperimentGroup, MetricName, Model, toUnixTimestamp(TimeUnix))
TTL toDateTime(TimeUnix) + INTERVAL 90 DAY TO VOLUME 'cold',
    toDateTime(TimeUnix) + INTERVAL 180 DAY DELETE
SETTINGS storage_policy = 'hot_cold';

-- CREATE TABLE IF NOT EXISTS는 기존 클러스터에 no-op이라 SeriesKey가 생기지 않는다 —
-- ../../clickhouse-schema.sql(참조 사본)과 동일한 근거·순서로 ALTER + MATERIALIZE.
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated'
    ADD COLUMN IF NOT EXISTS SeriesKey UInt64 MATERIALIZED cityHash64(toString(Attributes));
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN SeriesKey;

-- 시간별 rollup — 대시보드 쿼리가 실제로 읽는 테이블. 설계 근거/키 규칙/컷오버(워터마크+백필)
-- 절차는 ../../clickhouse-schema.sql(참조 사본, infra/files/ 기준 두 단계 위가 repo root)의
-- 주석 참고 — 두 파일 동기화 유지.
-- MV는 인서트를 받은 레플리카에서만 발화하고 복제 파트는 재발화하지 않으므로(중복 없음),
-- 인서트가 LB로 아무 레플리카에나 도착하는 이 클러스터에선 ON CLUSTER로 전 레플리카에 생성한다.
-- TTL/콜드 티어링 없음: 행이 적어(~40K/일) 항상 hot에 둬도 부담이 없고, 원본이 180일 TTL로
-- 지워진 뒤에도 diff baseline을 보존한다.
CREATE TABLE IF NOT EXISTS claude_code.otel_metrics_sum_hourly ON CLUSTER 'replicated'
(
    hour                   DateTime,
    MetricName             LowCardinality(String),
    SessionId              String,
    SeriesKey              UInt64,
    UserEmail              LowCardinality(String),
    AggregationTemporality Int32,
    Model                  LowCardinality(String),
    TokenType              LowCardinality(String),
    Decision               LowCardinality(String),
    SkillName              LowCardinality(String),
    ToolName               LowCardinality(String),
    max_value SimpleAggregateFunction(max, Float64),
    sum_value SimpleAggregateFunction(sum, Float64),
    has_org   SimpleAggregateFunction(max, UInt8)
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/otel_metrics_sum_hourly', '{replica}')
PARTITION BY toYYYYMM(hour)
ORDER BY (MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality,
          Model, TokenType, Decision, SkillName, ToolName, hour);

CREATE MATERIALIZED VIEW IF NOT EXISTS claude_code.otel_metrics_sum_hourly_mv ON CLUSTER 'replicated'
TO claude_code.otel_metrics_sum_hourly AS
SELECT
    toStartOfHour(toDateTime(TimeUnix)) AS hour,
    MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality,
    Model, TokenType, Decision, SkillName,
    Attributes['tool_name'] AS ToolName,
    max(Value) AS max_value,
    sum(Value) AS sum_value,
    max(Attributes['organization.id'] != '') AS has_org
FROM claude_code.otel_metrics_sum
GROUP BY hour, MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality,
         Model, TokenType, Decision, SkillName, ToolName;

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
    -- mcp_server_name/mcp_tool_name은 LogAttributes 최상위 키가 아니라 tool_name='mcp_tool'일 때
    -- LogAttributes['tool_parameters'](JSON 문자열) 안에 중첩되어 온다(실측 2026-07-09) —
    -- clickhouse-schema.sql(참조 사본)과 동기화 유지.
    ToolName        LowCardinality(String) MATERIALIZED LogAttributes['tool_name'],
    McpServerName   LowCardinality(String) MATERIALIZED JSONExtractString(LogAttributes['tool_parameters'], 'mcp_server_name'),
    McpToolName     LowCardinality(String) MATERIALIZED JSONExtractString(LogAttributes['tool_parameters'], 'mcp_tool_name'),
    Success         LowCardinality(String) MATERIALIZED LogAttributes['success']
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/otel_logs', '{replica}')
PARTITION BY toYYYYMM(Timestamp)
ORDER BY (ExperimentGroup, EventName, toUnixTimestamp(Timestamp))
TTL toDateTime(Timestamp) + INTERVAL 45 DAY TO VOLUME 'cold',
    toDateTime(Timestamp) + INTERVAL 90 DAY DELETE
SETTINGS storage_policy = 'hot_cold';

-- McpServerName/McpToolName은 기존 클러스터에 이미 있던 컬럼(예전 정의: 항상 빈 문자열) —
-- ../../clickhouse-schema.sql(참조 사본)과 동일한 근거로 MODIFY + MATERIALIZE.
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated'
    MODIFY COLUMN McpServerName LowCardinality(String) MATERIALIZED JSONExtractString(LogAttributes['tool_parameters'], 'mcp_server_name'),
    MODIFY COLUMN McpToolName   LowCardinality(String) MATERIALIZED JSONExtractString(LogAttributes['tool_parameters'], 'mcp_tool_name');
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN McpServerName;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN McpToolName;
