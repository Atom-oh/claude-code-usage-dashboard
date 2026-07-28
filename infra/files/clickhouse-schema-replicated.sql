-- ../../clickhouse-schema.sql를 CHI(replicated 클러스터, 3레플리카 — infra/clickhouse.tf replicasCount)용으로 변환한 버전.
-- 컬럼/MATERIALIZED 정의는 원본(참조 사본)과 동일하다 — OTel exporter 기본 부기 컬럼 포함
-- (아래 각 테이블 주석 참고). 다른 점: ON CLUSTER 절과 ZooKeeper 경로, MergeTree 대신
-- ReplicatedMergeTree, 그리고 storage_policy='hot_cold'와 그에 딸린 cold 볼륨 이동 TTL
-- (로컬 참조 사본에는 cold tier가 없어 삭제 TTL만 있다 — 삭제 시점 자체는 양쪽 동일).
-- TTL은 테이블마다 다르다: metrics(sum/gauge/hourly)는 90일 후 S3 volume 'cold'로 이동·180일 후
-- 삭제, otel_logs만 45일 이동·90일 삭제. sum/gauge/logs는 라이브와 일치하고(실측 2026-07-27),
-- hourly 롤업만 라이브에 TTL이 없어 아래 ALTER로 맞춘다. cold 볼륨도 같은 계정의
-- S3라 이동은 비용 단계일 뿐이고 PII 보존 기간을 끝내는 건 DELETE 쪽이다 —
-- docs/reference/security.md 참고.
-- 실측 후 attribute 키가 다르면 이 파일과 ../../clickhouse-schema.sql 둘 다 갱신할 것.

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
    AgentName       LowCardinality(String) MATERIALIZED Attributes['agent.name'],

    -- ResourceSchemaUrl부터 Exemplars.*까지는 OTel ClickHouse exporter가 자체 기본 스키마로
    -- 테이블을 만들 때 넣는 부기(bookkeeping) 컬럼이다 — 라이브 클러스터는 exporter가 먼저
    -- 테이블을 만들어 실제로 존재한다(실측 2026-07-27). 이 파일이 먼저 실행되는 신규 설치에서
    -- 컬럼이 빠지면 exporter 인서트가 없는 컬럼을 지정해 실패하므로 그대로 맞춘다
    -- (기존 클러스터에는 CREATE TABLE IF NOT EXISTS가 no-op이라 영향 없음).
    -- ../../clickhouse-schema.sql(참조 사본)과 동기화 유지.
    ResourceSchemaUrl     String DEFAULT '',
    ScopeVersion          String DEFAULT '',
    ScopeAttributes       Map(LowCardinality(String), String) DEFAULT map(),
    ScopeDroppedAttrCount UInt32 DEFAULT 0,
    ScopeSchemaUrl        String DEFAULT '',
    ServiceName           LowCardinality(String) DEFAULT '',
    MetricDescription     String DEFAULT '',
    MetricUnit            String DEFAULT '',
    Flags                 UInt32 DEFAULT 0,
    "Exemplars.FilteredAttributes" Array(Map(LowCardinality(String), String)),
    "Exemplars.TimeUnix"           Array(DateTime64(9)),
    "Exemplars.Value"              Array(Float64),
    "Exemplars.SpanId"             Array(String),
    "Exemplars.TraceId"            Array(String),

    -- SessionId는 cumulative counter의 series identity(경계 diff 단위) — 컬럼 순서까지
    -- clickhouse-schema.sql(참조 사본)과 동일하게 부기 블록 뒤에 둔다.
    SessionId       String                 MATERIALIZED Attributes['session.id'],
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

-- exporter 부기 컬럼도 같은 이유로 백필한다 — 위 CREATE 블록에만 있으면 이 DDL의 옛 버전으로
-- 만들어진 기존 테이블에는 붙지 않고, 그 상태에서 exporter가 해당 컬럼을 지정해 INSERT하면
-- 실패한다(라이브는 exporter가 테이블을 먼저 만들어 이미 있으므로 no-op).
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated'
    ADD COLUMN IF NOT EXISTS ResourceSchemaUrl String DEFAULT '',
    ADD COLUMN IF NOT EXISTS ScopeVersion String DEFAULT '',
    ADD COLUMN IF NOT EXISTS ScopeAttributes Map(LowCardinality(String), String) DEFAULT map(),
    ADD COLUMN IF NOT EXISTS ScopeDroppedAttrCount UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ScopeSchemaUrl String DEFAULT '',
    ADD COLUMN IF NOT EXISTS ServiceName LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS MetricDescription String DEFAULT '',
    ADD COLUMN IF NOT EXISTS MetricUnit String DEFAULT '',
    ADD COLUMN IF NOT EXISTS Flags UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "Exemplars.FilteredAttributes" Array(Map(LowCardinality(String), String)),
    ADD COLUMN IF NOT EXISTS "Exemplars.TimeUnix" Array(DateTime64(9)),
    ADD COLUMN IF NOT EXISTS "Exemplars.Value" Array(Float64),
    ADD COLUMN IF NOT EXISTS "Exemplars.SpanId" Array(String),
    ADD COLUMN IF NOT EXISTS "Exemplars.TraceId" Array(String);

-- 시간별 rollup — 대시보드 쿼리가 실제로 읽는 테이블. 설계 근거/키 규칙/컷오버(워터마크+백필)
-- 절차는 ../../clickhouse-schema.sql(참조 사본, infra/files/ 기준 두 단계 위가 repo root)의
-- 주석 참고 — 두 파일 동기화 유지.
-- MV는 인서트를 받은 레플리카에서만 발화하고 복제 파트는 재발화하지 않으므로(중복 없음),
-- 인서트가 LB로 아무 레플리카에나 도착하는 이 클러스터에선 ON CLUSTER로 전 레플리카에 생성한다.
-- TTL을 원본과 동일하게(90일 후 cold, 180일 후 삭제) 둔다 — UserEmail을 무기한 보존하는 별도
-- 저장소가 되지 않도록(리뷰에서 MAJOR로 확인, FSI 워크샵 PII 요구사항). 행이 적어(~40K/일)
-- 콜드 티어링 자체는 부담이 아니고, LOOKBACK_DAYS(3일)보다 180일이 훨씬 넉넉해 diff baseline
-- 보존 목적은 유지된다.
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
          Model, TokenType, Decision, SkillName, ToolName, hour)
TTL toDateTime(hour) + INTERVAL 90 DAY TO VOLUME 'cold',
    toDateTime(hour) + INTERVAL 180 DAY DELETE
SETTINGS storage_policy = 'hot_cold';

-- 위 CREATE TABLE IF NOT EXISTS는 롤업 테이블이 이미 있는 기존 클러스터에 no-op이라 TTL 절이
-- 적용되지 않는다 — 실측(2026-07-27) 라이브 롤업에는 TTL이 없었다(SeriesKey/McpServerName과
-- 완전히 같은 함정). TTL 없이 두면 UserEmail을 담은 롤업이 원본 삭제(180일) 뒤에도 무기한
-- 남아 retention을 우회하고, 그 구간에서 원본/롤업 집계가 발산한다. 이미 TTL이 같으면 no-op.
ALTER TABLE claude_code.otel_metrics_sum_hourly ON CLUSTER 'replicated'
    MODIFY TTL toDateTime(hour) + INTERVAL 90 DAY TO VOLUME 'cold',
               toDateTime(hour) + INTERVAL 180 DAY DELETE;

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
    Model           LowCardinality(String) MATERIALIZED Attributes['model'],

    -- otel_metrics_sum과 같은 exporter 기본 부기 컬럼 — 같은 사유로 명시.
    ResourceSchemaUrl     String DEFAULT '',
    ScopeVersion          String DEFAULT '',
    ScopeAttributes       Map(LowCardinality(String), String) DEFAULT map(),
    ScopeDroppedAttrCount UInt32 DEFAULT 0,
    ScopeSchemaUrl        String DEFAULT '',
    ServiceName           LowCardinality(String) DEFAULT '',
    MetricDescription     String DEFAULT '',
    MetricUnit            String DEFAULT '',
    Flags                 UInt32 DEFAULT 0,
    "Exemplars.FilteredAttributes" Array(Map(LowCardinality(String), String)),
    "Exemplars.TimeUnix"           Array(DateTime64(9)),
    "Exemplars.Value"              Array(Float64),
    "Exemplars.SpanId"             Array(String),
    "Exemplars.TraceId"            Array(String)
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/otel_metrics_gauge', '{replica}')
PARTITION BY toYYYYMM(TimeUnix)
ORDER BY (ExperimentGroup, MetricName, toUnixTimestamp(TimeUnix))
TTL toDateTime(TimeUnix) + INTERVAL 90 DAY TO VOLUME 'cold',
    toDateTime(TimeUnix) + INTERVAL 180 DAY DELETE
SETTINGS storage_policy = 'hot_cold';

-- gauge도 위 sum과 같은 사유로 부기 컬럼을 백필한다.
ALTER TABLE claude_code.otel_metrics_gauge ON CLUSTER 'replicated'
    ADD COLUMN IF NOT EXISTS ResourceSchemaUrl String DEFAULT '',
    ADD COLUMN IF NOT EXISTS ScopeVersion String DEFAULT '',
    ADD COLUMN IF NOT EXISTS ScopeAttributes Map(LowCardinality(String), String) DEFAULT map(),
    ADD COLUMN IF NOT EXISTS ScopeDroppedAttrCount UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ScopeSchemaUrl String DEFAULT '',
    ADD COLUMN IF NOT EXISTS ServiceName LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS MetricDescription String DEFAULT '',
    ADD COLUMN IF NOT EXISTS MetricUnit String DEFAULT '',
    ADD COLUMN IF NOT EXISTS Flags UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "Exemplars.FilteredAttributes" Array(Map(LowCardinality(String), String)),
    ADD COLUMN IF NOT EXISTS "Exemplars.TimeUnix" Array(DateTime64(9)),
    ADD COLUMN IF NOT EXISTS "Exemplars.Value" Array(Float64),
    ADD COLUMN IF NOT EXISTS "Exemplars.SpanId" Array(String),
    ADD COLUMN IF NOT EXISTS "Exemplars.TraceId" Array(String);

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
    Success         LowCardinality(String) MATERIALIZED LogAttributes['success'],

    -- TimestampTime부터 ScopeAttributes까지는 exporter 기본 부기 컬럼(실측 2026-07-27) —
    -- otel_metrics_sum과 같은 사유로 명시. clickhouse-schema.sql(참조 사본)과 동기화 유지.
    TimestampTime   DateTime DEFAULT toDateTime(Timestamp),
    TraceFlags      UInt8 DEFAULT 0,
    ResourceSchemaUrl LowCardinality(String) DEFAULT '',
    ScopeSchemaUrl  LowCardinality(String) DEFAULT '',
    ScopeName       String DEFAULT '',
    ScopeVersion    LowCardinality(String) DEFAULT '',
    ScopeAttributes Map(LowCardinality(String), String) DEFAULT map()
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

-- otel_logs 부기 컬럼도 같은 사유로 백필.
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated'
    ADD COLUMN IF NOT EXISTS TimestampTime DateTime DEFAULT toDateTime(Timestamp),
    ADD COLUMN IF NOT EXISTS TraceFlags UInt8 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ResourceSchemaUrl LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS ScopeSchemaUrl LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS ScopeName String DEFAULT '',
    ADD COLUMN IF NOT EXISTS ScopeVersion LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS ScopeAttributes Map(LowCardinality(String), String) DEFAULT map();
