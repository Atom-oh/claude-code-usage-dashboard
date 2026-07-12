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
    -- session.id는 cumulative counter의 series identity(경계 diff 계산 단위)로 쓰인다.
    -- 실측 후 session.id가 ResourceAttributes로 오면 ALTER로 이 정의만 교체하면 됨.
    SessionId       String                 MATERIALIZED Attributes['session.id'],
    TokenType       LowCardinality(String) MATERIALIZED Attributes['type'],
    QuerySource     LowCardinality(String) MATERIALIZED Attributes['query_source'],
    Decision        LowCardinality(String) MATERIALIZED Attributes['decision'],
    Language        LowCardinality(String) MATERIALIZED Attributes['language'],
    SkillName       LowCardinality(String) MATERIALIZED Attributes['skill.name'],
    AgentName       LowCardinality(String) MATERIALIZED Attributes['agent.name'],
    -- 진짜 OTel 시리즈 식별자(Attributes 맵 전체 해시) — queries.js의 incFlat/incBucketed가 세션 내
    -- 서로 다른 누적 스트림이 섞이는 걸 막는 GROUP BY 키로 쓴다. 예전엔 매 쿼리마다
    -- cityHash64(toString(Attributes))를 인라인 계산했는데, 420만 row 스캔 기준 1.2초 중 대부분이
    -- 이 문자열 직렬화였다(실측 2026-07-10) — MATERIALIZED로 INSERT 시점에 한 번만 계산하도록
    -- 옮기니 같은 쿼리가 0.11초로 줄었다. 인라인 계산과 값이 100% 일치함을 확인(mismatch=0).
    SeriesKey       UInt64                 MATERIALIZED cityHash64(toString(Attributes))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(TimeUnix)
ORDER BY (ExperimentGroup, MetricName, Model, toUnixTimestamp(TimeUnix))
TTL toDateTime(TimeUnix) + INTERVAL 180 DAY;

-- CREATE TABLE IF NOT EXISTS는 테이블이 이미 있는 기존 클러스터에는 no-op이라 SeriesKey가
-- 위 CREATE TABLE 블록에만 있으면 생기지 않는다(리뷰에서 CRITICAL로 확인: 기존 배포에
-- 적용 시 아래 MV 생성이 "unknown column SeriesKey"로 실패). ALTER로 명시적으로 백필한다.
-- 신규 설치는 CREATE TABLE에 이미 있어 이 ALTER가 안전한 no-op(컬럼 이미 존재).
-- 실행 순서: 이 ALTER → 아래 otel_metrics_sum_hourly 테이블/MV 생성 → 필요시 백필(주석 참고).
ALTER TABLE claude_code.otel_metrics_sum
    ADD COLUMN IF NOT EXISTS SeriesKey UInt64 MATERIALIZED cityHash64(toString(Attributes));
-- ADD COLUMN만으로는 기존 파트의 값이 채워지지 않는다(신규 insert부터만 계산) — rollup
-- 백필(아래)이 기존 데이터의 SeriesKey를 읽으므로 반드시 MATERIALIZE로 기존 파트까지 채운다.
ALTER TABLE claude_code.otel_metrics_sum MATERIALIZE COLUMN SeriesKey;

-- -----------------------------------------------------------------------------
-- 1b. 시간별 rollup — 대시보드 쿼리가 실제로 읽는 테이블 (queries.js incFlat/incBucketed)
-- -----------------------------------------------------------------------------
-- 누적 카운터는 (SeriesKey, SessionId, 버킷)당 "버킷 종료 시점 누적값" = max(Value)만 있으면
-- 구간 diff가 가능하다. 원본은 세션이 살아있는 동안 10초마다 전 시리즈를 재-export해서
-- 실측(2026-07-10) 3일 만에 9.5M행(+3M행/일) — 매 쿼리 풀스캔이 26M read rows, 단독 2~4.5초,
-- 동시 9~11초까지 갔다. 시간별로 접으면 ~110K행(86x)이고 증가율도 ~40K행/일로 준다.
--
-- AggregatingMergeTree에서 ORDER BY가 곧 집계 identity — 쿼리가 구분해야 하는 모든 차원
-- 컬럼이 키에 있어야 한다. SeriesKey(Attributes 해시)만으로는 MetricName(attribute가 아님)/
-- UserEmail(ResourceAttributes)/AggregationTemporality를 구분하지 못한다.
-- SimpleAggregateFunction이라 쿼리는 반드시 재집계(GROUP BY) 형태로 읽어야 한다(머지가
-- 비동기라 부분 행이 존재할 수 있음) — incFlat/incBucketed의 GROUP BY 모양이 이미 그렇다.
-- TTL을 원본과 동일하게(180일) 둔다 — UserEmail을 담는 별도 저장소인데 TTL이 없으면 원본이
-- 삭제된 뒤에도 이 rollup에 사용자 이메일이 무기한 남아 retention 정책을 우회하게 된다(리뷰에서
-- MAJOR로 확인, FSI 워크샵 맥락이라 PII 보존 기간은 실제 요구사항). LOOKBACK_DAYS(3일)보다
-- 180일이 훨씬 넉넉하므로 diff baseline 보존 목적은 그대로 유지된다.
CREATE TABLE IF NOT EXISTS claude_code.otel_metrics_sum_hourly
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
    max_value SimpleAggregateFunction(max, Float64),  -- cumulative(temp=2): 버킷 종료 시점 누적값
    sum_value SimpleAggregateFunction(sum, Float64),  -- delta(temp=1): 버킷 내 증가량 합
    has_org   SimpleAggregateFunction(max, UInt8)     -- organization.id 존재 — 그룹 판별(grouping.js)용
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality,
          Model, TokenType, Decision, SkillName, ToolName, hour)
TTL toDateTime(hour) + INTERVAL 180 DAY;

-- MV는 인서트를 받은 노드에서 발화해 TO 테이블에 쓴다. 컬럼을 전부 명시(SELECT * 금지 —
-- MATERIALIZED 소스 컬럼은 명시 참조해야 MV에서 해석된다). MV가 throw하면 원본 인서트가
-- 실패해 텔레메트리 수집이 멈추므로, 정의 변경은 반드시 로컬에서 테스트 인서트로 검증할 것.
-- 기존 데이터가 있는 클러스터에서는 이 MV(위 CREATE TABLE/MV, 아래)를 적용한 뒤
-- scripts/backfill-hourly-rollup.sh를 1회 실행할 것 — MV는 생성 "이후"의 insert만
-- 반영하므로, 그 전 데이터를 원본에서 재집계해 넣어야 과거 구간이 비지 않는다(신규 설치는
-- 백필 불필요 — 테이블이 데이터와 함께 생성됨). 스크립트는 rollup에 이미 있는 가장 오래된
-- hour를 워터마크로 자동 탐지해 그 이전 구간만 멱등하게 INSERT한다(재실행해도 중복 없음).
CREATE MATERIALIZED VIEW IF NOT EXISTS claude_code.otel_metrics_sum_hourly_mv
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
    -- tool_result 이벤트용. mcp_server_name/mcp_tool_name은 LogAttributes 최상위 키가 아니라
    -- tool_name='mcp_tool'일 때 LogAttributes['tool_parameters'](JSON 문자열) 안에 중첩되어
    -- 온다(실측 2026-07-09: LogAttributes['mcp_server_name'] 직접 참조는 늘 빈 문자열이라
    -- McpServerName != '' 필터에 항상 걸려 대시보드 MCP 패널이 비었음) — JSONExtractString으로
    -- 그 문자열을 파싱한다. tool_parameters가 비어있거나 그 키가 없으면 빈 문자열을 그대로 반환.
    ToolName        LowCardinality(String) MATERIALIZED LogAttributes['tool_name'],
    McpServerName   LowCardinality(String) MATERIALIZED JSONExtractString(LogAttributes['tool_parameters'], 'mcp_server_name'),
    McpToolName     LowCardinality(String) MATERIALIZED JSONExtractString(LogAttributes['tool_parameters'], 'mcp_tool_name'),
    Success         LowCardinality(String) MATERIALIZED LogAttributes['success']
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(Timestamp)
ORDER BY (ExperimentGroup, EventName, toUnixTimestamp(Timestamp))
TTL toDateTime(Timestamp) + INTERVAL 90 DAY;

-- McpServerName/McpToolName은 기존 클러스터에 이미 있던 컬럼(예전 정의:
-- LogAttributes['mcp_server_name'] 직접 참조 — 항상 빈 문자열)이라 CREATE TABLE IF NOT
-- EXISTS로는 위의 JSONExtractString 새 정의가 반영되지 않는다. MODIFY COLUMN으로 표현식을
-- 교체하고, MATERIALIZE로 기존 파트의 값을 재계산한다(신규 설치는 CREATE TABLE에 이미
-- 새 정의가 있어 이 블록이 안전한 no-op).
ALTER TABLE claude_code.otel_logs
    MODIFY COLUMN McpServerName LowCardinality(String) MATERIALIZED JSONExtractString(LogAttributes['tool_parameters'], 'mcp_server_name'),
    MODIFY COLUMN McpToolName   LowCardinality(String) MATERIALIZED JSONExtractString(LogAttributes['tool_parameters'], 'mcp_tool_name');
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN McpServerName;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN McpToolName;

-- -----------------------------------------------------------------------------
-- 참고: attribute 실제 키 이름(event.name / tool_name / mcp_server_name 등)은
--       Claude Code 버전에 따라 다를 수 있음. 최초 수집 후 아래로 실측 확인:
--   SELECT DISTINCT arrayJoin(mapKeys(LogAttributes)) FROM claude_code.otel_logs LIMIT 100;
--   SELECT DISTINCT arrayJoin(mapKeys(Attributes))    FROM claude_code.otel_metrics_sum LIMIT 100;
-- 실측값과 MATERIALIZED 정의가 다르면 컬럼 정의만 ALTER 하면 됨.
-- -----------------------------------------------------------------------------
