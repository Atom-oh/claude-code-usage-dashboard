-- =============================================================================
-- Claude Code A/B Telemetry — ClickHouse schema (admin server)
-- =============================================================================
-- 설계 원칙:
--   * 모든 쿼리가 experiment.group 으로 필터되므로 ORDER BY 선두에 배치
--   * 시간 파티션은 월 단위(toYYYYMM) — A/B 기간이 수주~수개월이라 적정
--   * OTel ClickHouse exporter의 표준 컬럼 구조를 따르되, 자주 쓰는 attribute를
--     MATERIALIZED 컬럼으로 승격시켜 대시보드 쿼리를 단순화
-- =============================================================================

CREATE DATABASE IF NOT EXISTS claude_code;

-- -----------------------------------------------------------------------------
-- 1. Metrics — OTel exporter가 쓰는 기본 테이블 이름 규약을 그대로 사용
--    (exporter는 metric type별로 여러 테이블을 만든다: _sum, _gauge, _histogram ...)
--    여기서는 Claude Code metric이 대부분 counter(sum)/gauge라, 두 테이블만 튜닝.
-- -----------------------------------------------------------------------------

-- Counter/monotonic sum 계열 (session/loc/commit/pr/cost/token/decision)
CREATE TABLE IF NOT EXISTS claude_code.otel_metrics_sum
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

    -- 자주 쓰는 값들을 승격 (A/B + Claude Code 표준 attribute)
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
ENGINE = MergeTree
PARTITION BY toYYYYMM(TimeUnix)
ORDER BY (ExperimentGroup, MetricName, Model, toUnixTimestamp(TimeUnix))
TTL toDateTime(TimeUnix) + INTERVAL 180 DAY;

-- Gauge 계열 (active_time 등 일부)
CREATE TABLE IF NOT EXISTS claude_code.otel_metrics_gauge
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
ENGINE = MergeTree
PARTITION BY toYYYYMM(TimeUnix)
ORDER BY (ExperimentGroup, MetricName, toUnixTimestamp(TimeUnix))
TTL toDateTime(TimeUnix) + INTERVAL 180 DAY;

-- -----------------------------------------------------------------------------
-- 2. Logs/Events — tool_result, user_prompt, api_request, tool_decision 등
--    tool/plugin/MCP 세밀 추적은 여기서. body는 담지 않음(privacy).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claude_code.otel_logs
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
    -- tool_result 이벤트용
    ToolName        LowCardinality(String) MATERIALIZED LogAttributes['tool_name'],
    McpServerName   LowCardinality(String) MATERIALIZED LogAttributes['mcp_server_name'],
    McpToolName     LowCardinality(String) MATERIALIZED LogAttributes['mcp_tool_name'],
    Success         LowCardinality(String) MATERIALIZED LogAttributes['success']
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(Timestamp)
ORDER BY (ExperimentGroup, EventName, toUnixTimestamp(Timestamp))
TTL toDateTime(Timestamp) + INTERVAL 90 DAY;

-- -----------------------------------------------------------------------------
-- 참고: attribute 실제 키 이름(event.name / tool_name / mcp_server_name 등)은
--       Claude Code 버전에 따라 다를 수 있음. 최초 수집 후 아래로 실측 확인:
--   SELECT DISTINCT arrayJoin(mapKeys(LogAttributes)) FROM claude_code.otel_logs LIMIT 100;
--   SELECT DISTINCT arrayJoin(mapKeys(Attributes))    FROM claude_code.otel_metrics_sum LIMIT 100;
-- 실측값과 MATERIALIZED 정의가 다르면 컬럼 정의만 ALTER 하면 됨.
-- -----------------------------------------------------------------------------
