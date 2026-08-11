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

-- Counter/monotonic sum 계열 (session/loc/commit/pr/cost/token/decision/active_time —
-- active_time.total은 이름과 달리 gauge가 아니라 이 sum 테이블로 들어온다, queries.js의 activeTimeSeries 실측)
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
    AgentName       LowCardinality(String) MATERIALIZED Attributes['agent.name'],
    -- 2026-08-11 스펙 동기화(clickhouse-migration-002.sql) — cost.usage/token.usage에 추가된
    -- attribution 속성. 전부 실측(라이브 클러스터, 345M행) 확인: 8개 전부 실제로 채워져
    -- 들어온다. Speed는 실측 0행(이 플릿은 fast 모드를 쓴 적이 없음) — 컬럼은 향후 대비로 둔다.
    PluginName      LowCardinality(String) MATERIALIZED Attributes['plugin.name'],
    MarketplaceName LowCardinality(String) MATERIALIZED Attributes['marketplace.name'],
    McpServerName   LowCardinality(String) MATERIALIZED Attributes['mcp_server.name'],
    McpToolName     LowCardinality(String) MATERIALIZED Attributes['mcp_tool.name'],
    Effort          LowCardinality(String) MATERIALIZED Attributes['effort'],
    Speed           LowCardinality(String) MATERIALIZED Attributes['speed'],
    -- session.count의 시작 유형. agents_view는 `claude agents` 대시보드 프로세스 실행이라
    -- 대화 세션이 아니다 — 세션 카운트 패널은 반드시 이 값으로 그 프로세스를 제외해야 한다
    -- (grafana-ab-queries.sql 패널 1/10, dashboard/server/queries.js의 세션 카운트 소비자).
    StartType       LowCardinality(String) MATERIALIZED Attributes['start_type'],
    -- code_edit_tool.decision의 decision 근거(config/hook/user_permanent/...). Source라는
    -- 이름이 이벤트 쪽 EventName과 헷갈릴 수 있으니 주의 — 이건 metric attribute다.
    Source          LowCardinality(String) MATERIALIZED Attributes['source'],
    -- 4-1: Bedrock 그룹은 Claude 계정이 없어 organization.id/user.account_uuid/user.account_id가
    -- 비어 있다(user-data.sh의 enduser.id 주입 참고). ResourceAttributes에서 승격 —
    -- OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES=false로 전환해도 살아남게 하려면 Attributes가
    -- 아니라 ResourceAttributes 쪽에서 와야 한다(이 값은 커스텀 리소스 속성이라 이미 그렇다).
    EndUserId       LowCardinality(String) MATERIALIZED ResourceAttributes['enduser.id'],
    -- 4-2: OTEL_METRICS_INCLUDE_VERSION 없이도 이미 채워져 있음(실측: 345M행 100%,
    -- service.version 자체가 OTel SDK 표준 리소스 속성). 이중계상(v2.1.214 하한)·MCP 의미
    -- 변경(v2.1.222) 검증에 쓴다 — grafana-ab-queries.sql 패널 19/20.
    AppVersion      LowCardinality(String) MATERIALIZED ResourceAttributes['service.version'],

    -- ResourceSchemaUrl부터 Exemplars.*까지는 OTel ClickHouse exporter가 기본으로 만드는
    -- 부기(bookkeeping) 컬럼이다 — 이 DDL이 원래 가독성을 위해 생략했었는데, exporter가 라이브
    -- 클러스터에 이 컬럼들까지 포함한 스키마로 테이블을 만든다(실측: SHOW CREATE TABLE로 확인,
    -- 2026-07-27). 신규 설치 시 이 DDL로 만든 테이블이 라이브와 다른 스키마가 되는 걸 막기 위해
    -- 정확한 컬럼명·순서·DEFAULT까지 그대로 맞춘다.
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

    -- session.id는 cumulative counter의 series identity(경계 diff 계산 단위)로 쓰인다.
    -- 실측 후 session.id가 ResourceAttributes로 오면 ALTER로 이 정의만 교체하면 됨.
    SessionId       String                 MATERIALIZED Attributes['session.id'],
    -- 진짜 OTel 시리즈 식별자(Attributes 맵 전체 해시) — queries.js의 incFlat/incBucketed가 세션 내
    -- 서로 다른 누적 스트림이 섞이는 걸 막는 GROUP BY 키로 쓴다. 예전엔 매 쿼리마다
    -- cityHash64(toString(Attributes))를 인라인 계산했는데, 420만 row 스캔 기준 1.2초 중 대부분이
    -- 이 문자열 직렬화였다(실측 2026-07-10) — MATERIALIZED로 INSERT 시점에 한 번만 계산하도록
    -- 옮기니 같은 쿼리가 0.11초로 줄었다. 인라인 계산과 값이 100% 일치함을 확인(mismatch=0).
    SeriesKey       UInt64                 MATERIALIZED cityHash64(toString(Attributes))
)
-- ENGINE/TTL은 단일 노드 기준으로 둔다 — 이 파일은 로컬(dashboard/docker-compose.yml, README가
-- 안내하는 경로)과 참조용 사본이고, 그 ClickHouse에는 Keeper·{shard}/{replica} macro·hot_cold
-- storage policy가 없어 Replicated/TO VOLUME 정의를 쓰면 테이블 생성이 전부 실패한다.
-- 라이브(EKS)는 ReplicatedMergeTree + storage_policy='hot_cold'로 90일 후 S3 volume 'cold'
-- 이동·180일 삭제다(실측 SHOW CREATE TABLE, 2026-07-27) — 그 정의는
-- infra/files/clickhouse-schema-replicated.sql가 갖고 있고 terraform이 실제 적용하는 것도 그쪽이다.
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

-- 2026-08-11 스펙 동기화 — 기존 클러스터에는 위 CREATE 블록만으로 새 컬럼이 생기지 않는다
-- (SeriesKey와 동일한 함정). 실행은 clickhouse-migration-002.sql이 담당하고, 여기 아래
-- 블록은 참조 사본이 그 마이그레이션과 동일한 정의를 유지하도록 남긴다.
ALTER TABLE claude_code.otel_metrics_sum
    ADD COLUMN IF NOT EXISTS PluginName      LowCardinality(String) MATERIALIZED Attributes['plugin.name'],
    ADD COLUMN IF NOT EXISTS MarketplaceName LowCardinality(String) MATERIALIZED Attributes['marketplace.name'],
    ADD COLUMN IF NOT EXISTS McpServerName   LowCardinality(String) MATERIALIZED Attributes['mcp_server.name'],
    ADD COLUMN IF NOT EXISTS McpToolName     LowCardinality(String) MATERIALIZED Attributes['mcp_tool.name'],
    ADD COLUMN IF NOT EXISTS Effort          LowCardinality(String) MATERIALIZED Attributes['effort'],
    ADD COLUMN IF NOT EXISTS Speed           LowCardinality(String) MATERIALIZED Attributes['speed'],
    ADD COLUMN IF NOT EXISTS StartType       LowCardinality(String) MATERIALIZED Attributes['start_type'],
    ADD COLUMN IF NOT EXISTS Source          LowCardinality(String) MATERIALIZED Attributes['source'],
    ADD COLUMN IF NOT EXISTS EndUserId       LowCardinality(String) MATERIALIZED ResourceAttributes['enduser.id'],
    ADD COLUMN IF NOT EXISTS AppVersion      LowCardinality(String) MATERIALIZED ResourceAttributes['service.version'];
ALTER TABLE claude_code.otel_metrics_sum MATERIALIZE COLUMN PluginName;
ALTER TABLE claude_code.otel_metrics_sum MATERIALIZE COLUMN MarketplaceName;
ALTER TABLE claude_code.otel_metrics_sum MATERIALIZE COLUMN McpServerName;
ALTER TABLE claude_code.otel_metrics_sum MATERIALIZE COLUMN McpToolName;
ALTER TABLE claude_code.otel_metrics_sum MATERIALIZE COLUMN Effort;
ALTER TABLE claude_code.otel_metrics_sum MATERIALIZE COLUMN Speed;
ALTER TABLE claude_code.otel_metrics_sum MATERIALIZE COLUMN StartType;
ALTER TABLE claude_code.otel_metrics_sum MATERIALIZE COLUMN Source;
ALTER TABLE claude_code.otel_metrics_sum MATERIALIZE COLUMN EndUserId;
ALTER TABLE claude_code.otel_metrics_sum MATERIALIZE COLUMN AppVersion;

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
    -- 2026-08-11: StartType을 키 컬럼으로 추가 — session.count 롤업 경로에서도
    -- `StartType != 'agents_view'` 필터가 가능해야 한다(원본 직접 조회 경로와 동일한 필터).
    -- 값은 빈 문자열이 정상(agents_view 이외 metric은 이 attribute가 없음)이라
    -- `!= 'agents_view'`는 빈 값도 그대로 통과시킨다. AppVersion도 같이 승격 —
    -- 패널 19/20(버전 코호트) 대시보드 앱 계층이 rollup 경로로도 코호트 분해를 할 수 있게.
    -- MV 갱신 "이후" insert부터만 값이 채워진다(신규 키 컬럼의 일반적 한계) — 과거분은
    -- scripts/backfill-hourly-rollup.sh 재실행으로 메운다.
    StartType              LowCardinality(String),
    AppVersion             LowCardinality(String),
    max_value SimpleAggregateFunction(max, Float64),  -- cumulative(temp=2): 버킷 종료 시점 누적값
    sum_value SimpleAggregateFunction(sum, Float64),  -- delta(temp=1): 버킷 내 증가량 합
    has_org   SimpleAggregateFunction(max, UInt8)     -- organization.id 존재 — 그룹 판별(grouping.js)용
)
-- TTL은 원본·배포본과 동일하게(90일 후 cold, 180일 후 삭제) 둔다 —
-- infra/files/clickhouse-schema-replicated.sql(terraform이 ConfigMap으로 배포하는 실제 스키마)이
-- 이미 이 TTL을 갖고 있고, UserEmail을 담는 별도 저장소가 원본 삭제 뒤에도 남으면 retention
-- 정책을 우회한다.
--
-- 실측 드리프트(라이브 클러스터, 2026-07-27): 운영 중인 otel_metrics_sum_hourly에는 **TTL이
-- 없었다**. CREATE TABLE IF NOT EXISTS가 이미 존재하는 테이블에 no-op이라 TTL 절이 적용된 적이
-- 없다 — 배포본의 의도가 아니라 미적용 상태다. 라이브를 맞추는 ALTER는 SeriesKey와 같은 패턴으로
-- infra/files/clickhouse-schema-replicated.sql에 실행되는 문장으로 들어있고, 그 파일이 바뀌면
-- schema_init Job이 해시 기반 이름으로 교체돼 다시 실행된다(infra/clickhouse.tf 주석 참고 —
-- 이름이 고정이던 동안엔 재실행되지 않아 이 드리프트가 방치됐다). 적용 전까지는 180일이 지난
-- 구간에서 원본(삭제됨)과 롤업(잔존)의 집계가 발산한다.
-- 이 파일은 참조/로컬 사본이라 여기 적은 정의는 실행되지 않는다.
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality,
          Model, TokenType, Decision, SkillName, ToolName, StartType, AppVersion, hour)
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
    Attributes['start_type'] AS StartType,
    ResourceAttributes['service.version'] AS AppVersion,
    max(Value) AS max_value,
    sum(Value) AS sum_value,
    max(Attributes['organization.id'] != '') AS has_org
FROM claude_code.otel_metrics_sum
GROUP BY hour, MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality,
         Model, TokenType, Decision, SkillName, ToolName, StartType, AppVersion;

-- Gauge 계열 — exporter가 gauge 타입 메트릭을 받으면 쓰는 테이블. Claude Code가 실제로 보내는
-- 메트릭은 전부 counter(sum)로 들어오고(active_time.total 포함 — queries.js의 activeTimeSeries 실측), 이 테이블은
-- 사실상 비어 있다. otel_metrics_sum과 동일하게 exporter 기본 부기 컬럼이
-- 실제로 존재한다(실측 2026-07-27).
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
    Model           LowCardinality(String) MATERIALIZED Attributes['model'],

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
-- gauge도 UserEmail을 MATERIALIZED로 담으므로 sum과 동일한 TTL을 가진다(UserEmail을 담는 모든
-- 저장소가 TTL을 가져야 한다는 원칙 — docs/reference/security.md). 라이브는 90일 cold 이동 +
-- 180일 삭제.
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
    Success         LowCardinality(String) MATERIALIZED LogAttributes['success'],

    -- 2026-08-11 스펙 동기화 — skill_activated/compaction/api_refusal/api_retries_exhausted/
    -- plugin_loaded 이벤트용 승격 컬럼(패널 14~18, grafana-ab-queries.sql). 이 5개 이벤트는
    -- monitoring-usage.md 문서에는 없지만 라이브 클러스터에 실제로 존재한다(실측: 각각
    -- skill_activated 521건, compaction 124건, api_refusal 71건, api_retries_exhausted 31건,
    -- plugin_loaded 5750건) — 속성 키는 문서가 아니라 이 실측(mapKeys(LogAttributes))을 기준으로
    -- 정의했다. skill.kind는 실측상 존재하지 않아 넣지 않았다.
    SkillName          LowCardinality(String) MATERIALIZED LogAttributes['skill.name'],
    InvocationTrigger  LowCardinality(String) MATERIALIZED LogAttributes['invocation_trigger'],
    SkillSource        LowCardinality(String) MATERIALIZED LogAttributes['skill.source'],
    PluginName         LowCardinality(String) MATERIALIZED LogAttributes['plugin.name'],
    MarketplaceName    LowCardinality(String) MATERIALIZED LogAttributes['marketplace.name'],
    -- api_refusal. category는 has_category='true'일 때만 채워짐(OTEL_LOG_TOOL_DETAILS 게이팅) —
    -- 실측상 has_category 값 분포는 별도 확인 필요, 빈 값은 "카테고리 미공개"로 취급.
    RefusalCategory    LowCardinality(String) MATERIALIZED LogAttributes['category'],
    -- server_fallback_hop='true'는 사용자가 못 본 refusal — 패널 16에서 최종 집계 제외 대상.
    ServerFallbackHop  LowCardinality(String) MATERIALIZED LogAttributes['server_fallback_hop'],
    -- compaction. trigger/pre_tokens/post_tokens/duration_ms로 압축률·세션당 발생 빈도를 본다.
    CompactionTrigger  LowCardinality(String) MATERIALIZED LogAttributes['trigger'],
    PreTokens          UInt64 MATERIALIZED toUInt64OrZero(LogAttributes['pre_tokens']),
    PostTokens         UInt64 MATERIALIZED toUInt64OrZero(LogAttributes['post_tokens']),
    -- DurationMs는 compaction 이벤트 전용이 아니다 — duration_ms 키를 쓰는 이벤트(compaction 등)
    -- 전체에서 공유. 이벤트별 의미가 다르니 EventName과 함께 해석할 것.
    DurationMs         UInt64 MATERIALIZED toUInt64OrZero(LogAttributes['duration_ms']),
    -- api_retries_exhausted.
    TotalAttempts        UInt32 MATERIALIZED toUInt32OrZero(LogAttributes['total_attempts']),
    TotalRetryDurationMs UInt64 MATERIALIZED toUInt64OrZero(LogAttributes['total_retry_duration_ms']),
    -- 서브에이전트 팬아웃(패널 13)이 prompt.id로 인터랙션당 subagent_completed 건수를 묶는다.
    PromptId           String MATERIALIZED LogAttributes['prompt.id'],
    -- 4-1/4-2 — otel_metrics_sum과 동일한 식, 동일한 이유(ResourceAttributes에서 승격해
    -- OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES 전환에 영향받지 않게).
    EndUserId          LowCardinality(String) MATERIALIZED ResourceAttributes['enduser.id'],
    AppVersion         LowCardinality(String) MATERIALIZED ResourceAttributes['service.version'],

    -- TimestampTime부터 ScopeAttributes까지는 OTel ClickHouse exporter 기본 부기 컬럼(실측
    -- 2026-07-27, DESCRIBE TABLE) — otel_metrics_sum과 같은 사유로 명시한다.
    TimestampTime   DateTime DEFAULT toDateTime(Timestamp),
    TraceFlags      UInt8 DEFAULT 0,
    ResourceSchemaUrl LowCardinality(String) DEFAULT '',
    ScopeSchemaUrl  LowCardinality(String) DEFAULT '',
    ScopeName       String DEFAULT '',
    ScopeVersion    LowCardinality(String) DEFAULT '',
    ScopeAttributes Map(LowCardinality(String), String) DEFAULT map()
)
-- 라이브(EKS)는 45일→cold volume 이동, 90일→삭제다(실측 2026-07-27) — 삭제 시점은 아래와 같고
-- cold 이동만 추가된 형태다. 그 정의는 infra/files/clickhouse-schema-replicated.sql에 있다.
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

-- 2026-08-11 스펙 동기화 — 기존 클러스터 백필(SeriesKey/McpServerName과 동일한 패턴).
-- 실행은 clickhouse-migration-002.sql이 담당, 여기는 참조 사본 동기화용.
ALTER TABLE claude_code.otel_logs
    ADD COLUMN IF NOT EXISTS SkillName            LowCardinality(String) MATERIALIZED LogAttributes['skill.name'],
    ADD COLUMN IF NOT EXISTS InvocationTrigger    LowCardinality(String) MATERIALIZED LogAttributes['invocation_trigger'],
    ADD COLUMN IF NOT EXISTS SkillSource          LowCardinality(String) MATERIALIZED LogAttributes['skill.source'],
    ADD COLUMN IF NOT EXISTS PluginName           LowCardinality(String) MATERIALIZED LogAttributes['plugin.name'],
    ADD COLUMN IF NOT EXISTS MarketplaceName      LowCardinality(String) MATERIALIZED LogAttributes['marketplace.name'],
    ADD COLUMN IF NOT EXISTS RefusalCategory      LowCardinality(String) MATERIALIZED LogAttributes['category'],
    ADD COLUMN IF NOT EXISTS ServerFallbackHop    LowCardinality(String) MATERIALIZED LogAttributes['server_fallback_hop'],
    ADD COLUMN IF NOT EXISTS CompactionTrigger    LowCardinality(String) MATERIALIZED LogAttributes['trigger'],
    ADD COLUMN IF NOT EXISTS PreTokens            UInt64 MATERIALIZED toUInt64OrZero(LogAttributes['pre_tokens']),
    ADD COLUMN IF NOT EXISTS PostTokens           UInt64 MATERIALIZED toUInt64OrZero(LogAttributes['post_tokens']),
    ADD COLUMN IF NOT EXISTS DurationMs           UInt64 MATERIALIZED toUInt64OrZero(LogAttributes['duration_ms']),
    ADD COLUMN IF NOT EXISTS TotalAttempts        UInt32 MATERIALIZED toUInt32OrZero(LogAttributes['total_attempts']),
    ADD COLUMN IF NOT EXISTS TotalRetryDurationMs UInt64 MATERIALIZED toUInt64OrZero(LogAttributes['total_retry_duration_ms']),
    ADD COLUMN IF NOT EXISTS PromptId             String MATERIALIZED LogAttributes['prompt.id'],
    ADD COLUMN IF NOT EXISTS EndUserId            LowCardinality(String) MATERIALIZED ResourceAttributes['enduser.id'],
    ADD COLUMN IF NOT EXISTS AppVersion           LowCardinality(String) MATERIALIZED ResourceAttributes['service.version'];
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN SkillName;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN InvocationTrigger;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN SkillSource;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN PluginName;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN MarketplaceName;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN RefusalCategory;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN ServerFallbackHop;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN CompactionTrigger;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN PreTokens;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN PostTokens;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN DurationMs;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN TotalAttempts;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN TotalRetryDurationMs;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN PromptId;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN EndUserId;
ALTER TABLE claude_code.otel_logs MATERIALIZE COLUMN AppVersion;

-- -----------------------------------------------------------------------------
-- 2c. Traces (beta) — claude_code.interaction / llm_request / hook / tool /
--     tool.blocked_on_user / tool.execution 스팬. CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 +
--     OTEL_TRACES_EXPORTER=otlp가 켜져야 데이터가 들어온다(user-data.sh). exporter가
--     create_schema: false라 이 DDL을 먼저 실행해야 한다 — otel_traces는 라이브 클러스터에
--     아직 존재하지 않는다(실측: system.tables에 없음, 2026-08-11).
--
--     blocked_on_user/execution 스팬은 v2.1.214+에서만 나온다(문서 확인). 플릿에 그 이전
--     버전이 섞여 있어도(실측: 2.1.202부터 혼재) 과거 호환은 신경 쓰지 않는다 — 앞으로의
--     구현이 우선이라는 결정에 따라, 데이터가 없는 구간은 빈 결과로 그대로 둔다(집계 쿼리
--     레벨에서 "데이터 없음" 처리는 대시보드 앱 계층이 담당).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claude_code.otel_traces
(
    Timestamp         DateTime64(9) CODEC(Delta, ZSTD(1)),
    TraceId           String CODEC(ZSTD(1)),
    SpanId            String CODEC(ZSTD(1)),
    ParentSpanId      String CODEC(ZSTD(1)),
    TraceState        String CODEC(ZSTD(1)),
    SpanName          LowCardinality(String) CODEC(ZSTD(1)),
    SpanKind          LowCardinality(String) CODEC(ZSTD(1)),
    ServiceName       LowCardinality(String) CODEC(ZSTD(1)),
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeName         String CODEC(ZSTD(1)),
    ScopeVersion      String CODEC(ZSTD(1)),
    SpanAttributes    Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    Duration          Int64 CODEC(ZSTD(1)),
    StatusCode        LowCardinality(String) CODEC(ZSTD(1)),
    StatusMessage     String CODEC(ZSTD(1)),
    "Events.Timestamp"  Array(DateTime64(9)),
    "Events.Name"       Array(LowCardinality(String)),
    "Events.Attributes" Array(Map(LowCardinality(String), String)),
    "Links.TraceId"     Array(String),
    "Links.SpanId"      Array(String),
    "Links.TraceState"  Array(String),
    "Links.Attributes"  Array(Map(LowCardinality(String), String)),

    ExperimentGroup LowCardinality(String) MATERIALIZED ResourceAttributes['experiment.group'],
    UserEmail       LowCardinality(String) MATERIALIZED ResourceAttributes['user.email'],
    EndUserId       LowCardinality(String) MATERIALIZED ResourceAttributes['enduser.id'],
    AppVersion      LowCardinality(String) MATERIALIZED ResourceAttributes['service.version'],
    SessionId       String                 MATERIALIZED SpanAttributes['session.id'],
    -- span.type은 모든 스팬 종류(claude_code.interaction/llm_request/tool/
    -- tool.blocked_on_user/tool.execution/hook)에 공통으로 붙는 상수 속성 — 패널이 이 값으로
    -- 스팬 종류를 구분한다(SpanName도 같은 값을 담지만, SpanAttributes 쪽이 문서 기준 정의).
    SpanType        LowCardinality(String) MATERIALIZED SpanAttributes['span.type'],
    -- duration_ms는 스팬 종류별로 의미가 다르다(llm_request: 재시도 포함 전체, tool: 권한 대기
    -- + 실행, tool.blocked_on_user: 권한 대기만, tool.execution: 실행만) — SpanType과 함께
    -- 해석할 것. 패널 11/12가 이 컬럼을 쓴다.
    DurationMs      UInt64 MATERIALIZED toUInt64OrZero(SpanAttributes['duration_ms']),
    TtftMs          UInt64 MATERIALIZED toUInt64OrZero(SpanAttributes['ttft_ms']),
    AgentId         String MATERIALIZED SpanAttributes['agent_id'],
    ParentAgentId   String MATERIALIZED SpanAttributes['parent_agent_id'],
    Model           LowCardinality(String) MATERIALIZED SpanAttributes['model'],
    Decision        LowCardinality(String) MATERIALIZED SpanAttributes['decision']
)
-- 로컬 참조 사본이라 삭제 TTL만(cold tier 없음) — otel_logs와 동일 정책(90일), 라이브는
-- infra/files/clickhouse-schema-replicated.sql에서 45일 cold 이동 + 90일 삭제.
ENGINE = MergeTree
PARTITION BY toYYYYMM(Timestamp)
ORDER BY (ExperimentGroup, SpanType, toUnixTimestamp(Timestamp))
TTL toDateTime(Timestamp) + INTERVAL 90 DAY;

-- -----------------------------------------------------------------------------
-- 참고: attribute 실제 키 이름(event.name / tool_name / mcp_server_name 등)은
--       Claude Code 버전에 따라 다를 수 있음. 최초 수집 후 아래로 실측 확인:
--   SELECT DISTINCT arrayJoin(mapKeys(LogAttributes)) FROM claude_code.otel_logs LIMIT 100;
--   SELECT DISTINCT arrayJoin(mapKeys(Attributes))    FROM claude_code.otel_metrics_sum LIMIT 100;
-- 실측값과 MATERIALIZED 정의가 다르면 컬럼 정의만 ALTER 하면 됨.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- STEP 5 참고: 카디널리티 및 temporality 검증 (2026-08-11)
-- -----------------------------------------------------------------------------

-- (a) temporality 검증 — 문서 기본값은 delta인데 이 배포는 user-data.sh의
--     OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE="cumulative"로 명시 고정한다.
--     실측(2026-08-11, 라이브 클러스터): AggregationTemporality=2(cumulative) 345,193,089행,
--     =1(delta) 2행 — 사실상 전부 cumulative. incFlat/incBucketed와 grafana-ab-queries.sql
--     패널 9가 이미 두 값 모두 분기하므로 delta가 소수 섞여도 문제없다.
-- SELECT AggregationTemporality, count() AS rows
-- FROM claude_code.otel_metrics_sum
-- GROUP BY AggregationTemporality
-- ORDER BY rows DESC;

-- (b) 시리즈 수 추정 — Effort/AgentName/SkillName/McpToolName 같은 신규 라벨이 metric label로
--     붙으면서 시리즈 수가 곱셈으로 늘 수 있다. OTEL_METRICS_INCLUDE_SESSION_ID=false /
--     OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES=false 전환 판단에 이 값을 참고할 것 —
--     SeriesKey는 Attributes 맵 전체 해시라 라벨 조합 수를 그대로 반영한다.
-- SELECT MetricName, uniqExact(SeriesKey) AS series
-- FROM claude_code.otel_metrics_sum
-- GROUP BY MetricName
-- ORDER BY series DESC;

-- SELECT
--     uniqExact(Effort)      AS n_effort,
--     uniqExact(AgentName)   AS n_agent,
--     uniqExact(SkillName)   AS n_skill,
--     uniqExact(McpToolName) AS n_mcp_tool,
--     uniqExact(Model)       AS n_model
-- FROM claude_code.otel_metrics_sum
-- WHERE MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage');
-- -----------------------------------------------------------------------------
