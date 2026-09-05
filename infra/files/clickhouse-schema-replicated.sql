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
    -- 2026-08-11 스펙 동기화 — ../../clickhouse-schema.sql(참조 사본)과 동기화 유지.
    -- clickhouse-migration-002.sql이 실행 시 이 정의와 동일한 ALTER를 기존 클러스터에 적용한다.
    PluginName      LowCardinality(String) MATERIALIZED Attributes['plugin.name'],
    MarketplaceName LowCardinality(String) MATERIALIZED Attributes['marketplace.name'],
    McpServerName   LowCardinality(String) MATERIALIZED Attributes['mcp_server.name'],
    McpToolName     LowCardinality(String) MATERIALIZED Attributes['mcp_tool.name'],
    Effort          LowCardinality(String) MATERIALIZED Attributes['effort'],
    Speed           LowCardinality(String) MATERIALIZED Attributes['speed'],
    StartType       LowCardinality(String) MATERIALIZED Attributes['start_type'],
    Source          LowCardinality(String) MATERIALIZED Attributes['source'],
    EndUserId       LowCardinality(String) MATERIALIZED ResourceAttributes['enduser.id'],
    AppVersion      LowCardinality(String) MATERIALIZED ResourceAttributes['service.version'],

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
    -- 전체 근거·2026-09-02 세그먼트 인식 전환 배경은 clickhouse-schema.sql의 동일 컬럼 주석과
    -- docs/decisions/ADR-003-fold-start-time-into-series-key.md를 참고.
    SeriesKey       UInt64                 MATERIALIZED
        if(MetricName = 'claude_code.session.count',
           cityHash64(toString(Attributes)),
           cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix)))
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
    ADD COLUMN IF NOT EXISTS SeriesKey UInt64 MATERIALIZED
        if(MetricName = 'claude_code.session.count',
           cityHash64(toString(Attributes)),
           cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix)));
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN SeriesKey;

-- 2026-09-02 세그먼트 인식 SeriesKey 전환(ADR-003) — 이 파일에는 의도적으로 MODIFY COLUMN을
-- 추가하지 않는다. 이 파일은 infra/clickhouse.tf의 schema_init Job이 파일이 바뀔 때마다(Job
-- 이름이 파일 md5) 재실행한다 — raw 키를 여기서 조율 없이 바꾸면 그 순간 살아있던 세션들의
-- 롤업이 누군가 재구축하기 전까지 이중집계된다. 전환은 롤업 재구축과 함께 조율되어야 하므로
-- clickhouse-migration-003.sql + docs/runbooks/rollup-rebuild-segment-key.md로 사람이 직접
-- 수행한다. 신규 설치는 위 CREATE에서 바로 새 키를 받고, 기존 클러스터는 migration-003으로만
-- 전환된다.

-- 2026-08-11 스펙 동기화 — clickhouse-migration-002.sql(실행용)과 동일 정의.
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated'
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
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN PluginName;
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN MarketplaceName;
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN McpServerName;
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN McpToolName;
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN Effort;
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN Speed;
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN StartType;
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN Source;
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN EndUserId;
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN AppVersion;

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
    -- 2026-08-11: StartType/AppVersion 승격 — ../../clickhouse-schema.sql(참조 사본)과
    -- 동기화 유지. 라이브 기존 클러스터는 clickhouse-migration-002.sql의 ADD COLUMN(정렬 키
    -- 변경 불가로 컬럼만 추가)이 담당 — 이 CREATE TABLE 블록은 신규 설치에서만 실행된다.
    -- 실측 드리프트: 그래서 라이브 ORDER BY에는 StartType/AppVersion이 빠져 있다(정렬 키는
    -- MergeTree에서 in-place로 못 바꾸므로 컬럼만 추가됐다). clickhouse-migration-003.sql의
    -- shadow 테이블 재구축(EXCHANGE TABLES)이 이 드리프트를 닫는다 — 그 절차가 끝나면 라이브
    -- 테이블도 아래 CREATE와 동일한 13컬럼 ORDER BY를 갖게 된다.
    StartType              LowCardinality(String),
    AppVersion             LowCardinality(String),
    max_value SimpleAggregateFunction(max, Float64),
    sum_value SimpleAggregateFunction(sum, Float64),
    has_org   SimpleAggregateFunction(max, UInt8)
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/otel_metrics_sum_hourly', '{replica}')
PARTITION BY toYYYYMM(hour)
ORDER BY (MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality,
          Model, TokenType, Decision, SkillName, ToolName, StartType, AppVersion, hour)
-- 롤업만 DELETE-only TTL(cold 이동 없음). 실측(2026-09-02, prod query_log): 라이브 롤업은
-- SETTINGS 없이 만들어져 storage_policy=default(볼륨 'default' 하나)라 아래 ALTER의 예전 형태
-- `... TO VOLUME 'cold'`가 Code 450 BAD_TTL_EXPRESSION(No such volume 'cold')으로 실패했고,
-- --multiquery인 schema_init Job이 여기서 abort해 이 파일의 이후 statement(MV/gauge/logs/
-- traces)가 IaC 경로로는 한 번도 적용되지 않았다(2026-08-12 7회 전부 실패). ClickHouse는
-- MODIFY SETTING storage_policy로 정책을 바꿀 때 새 정책이 옛 정책의 볼륨 이름을 전부
-- 포함해야 해서(StoragePolicy::checkCompatibleWith) default→hot_cold 전환도 거부된다.
-- 롤업은 ~4.5MiB라 cold 티어의 실익이 없고, retention 목적(UserEmail 삭제)은 DELETE만으로
-- 충분하다. CREATE와 ALTER의 TTL은 반드시 같아야 한다 — MODIFY TTL은 TTL 절 전체를 교체하므로
-- 둘이 다르면 신규 설치와 기존 클러스터의 끝 상태가 조용히 갈라진다.
TTL toDateTime(hour) + INTERVAL 180 DAY DELETE
SETTINGS storage_policy = 'hot_cold';

-- 위 CREATE TABLE IF NOT EXISTS는 롤업 테이블이 이미 있는 기존 클러스터에 no-op이라 TTL 절이
-- 적용되지 않는다 — 실측(2026-07-27) 라이브 롤업에는 TTL이 없었다(SeriesKey/McpServerName과
-- 완전히 같은 함정). TTL 없이 두면 UserEmail을 담은 롤업이 원본 삭제(180일) 뒤에도 무기한
-- 남아 retention을 우회하고, 그 구간에서 원본/롤업 집계가 발산한다. 이미 TTL이 같으면 no-op.
-- 볼륨을 참조하지 않으므로 storage_policy가 default든 hot_cold든 통과한다(위 주석 참고).
ALTER TABLE claude_code.otel_metrics_sum_hourly ON CLUSTER 'replicated'
    MODIFY TTL toDateTime(hour) + INTERVAL 180 DAY DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS claude_code.otel_metrics_sum_hourly_mv ON CLUSTER 'replicated'
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
-- 신규 설치는 CREATE MATERIALIZED VIEW IF NOT EXISTS라 위 정의로 바로 만들어진다. 기존
-- 클러스터의 MV 갱신은 clickhouse-migration-002.sql의 CREATE OR REPLACE가 담당(이 파일은
-- IF NOT EXISTS라 기존 배포에는 no-op).

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

    -- 2026-08-11 스펙 동기화 — ../../clickhouse-schema.sql(참조 사본)과 동기화 유지. 속성 키는
    -- 문서가 아니라 실측(mapKeys(LogAttributes), 2026-08-11) 기준.
    SkillName            LowCardinality(String) MATERIALIZED LogAttributes['skill.name'],
    InvocationTrigger    LowCardinality(String) MATERIALIZED LogAttributes['invocation_trigger'],
    SkillSource          LowCardinality(String) MATERIALIZED LogAttributes['skill.source'],
    PluginName           LowCardinality(String) MATERIALIZED LogAttributes['plugin.name'],
    MarketplaceName      LowCardinality(String) MATERIALIZED LogAttributes['marketplace.name'],
    RefusalCategory      LowCardinality(String) MATERIALIZED LogAttributes['category'],
    ServerFallbackHop    LowCardinality(String) MATERIALIZED LogAttributes['server_fallback_hop'],
    CompactionTrigger    LowCardinality(String) MATERIALIZED LogAttributes['trigger'],
    PreTokens            UInt64 MATERIALIZED toUInt64OrZero(LogAttributes['pre_tokens']),
    PostTokens           UInt64 MATERIALIZED toUInt64OrZero(LogAttributes['post_tokens']),
    DurationMs           UInt64 MATERIALIZED toUInt64OrZero(LogAttributes['duration_ms']),
    TotalAttempts        UInt32 MATERIALIZED toUInt32OrZero(LogAttributes['total_attempts']),
    TotalRetryDurationMs UInt64 MATERIALIZED toUInt64OrZero(LogAttributes['total_retry_duration_ms']),
    PromptId             String MATERIALIZED LogAttributes['prompt.id'],
    EndUserId            LowCardinality(String) MATERIALIZED ResourceAttributes['enduser.id'],
    AppVersion           LowCardinality(String) MATERIALIZED ResourceAttributes['service.version'],

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

-- otel_logs 신규 컬럼(2026-08-11)도 같은 사유로 백필 — clickhouse-migration-002.sql(실행용)과
-- 동일 정의.
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated'
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
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN SkillName;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN InvocationTrigger;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN SkillSource;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN PluginName;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN MarketplaceName;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN RefusalCategory;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN ServerFallbackHop;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN CompactionTrigger;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN PreTokens;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN PostTokens;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN DurationMs;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN TotalAttempts;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN TotalRetryDurationMs;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN PromptId;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN EndUserId;
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated' MATERIALIZE COLUMN AppVersion;

-- -----------------------------------------------------------------------------
-- Traces (beta, 2026-08-11) — ../../clickhouse-schema.sql "2c. Traces (beta)" 섹션과 동일
-- 정의. otel_logs와 같은 45일 cold 이동 + 90일 삭제 정책. 신규 테이블이라 기존 클러스터에도
-- CREATE TABLE IF NOT EXISTS만으로 안전 — clickhouse-migration-002.sql과 동일 문장(중복 실행
-- 시 IF NOT EXISTS라 두 번째는 no-op).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claude_code.otel_traces ON CLUSTER 'replicated'
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
    SpanType        LowCardinality(String) MATERIALIZED SpanAttributes['span.type'],
    DurationMs      UInt64 MATERIALIZED toUInt64OrZero(SpanAttributes['duration_ms']),
    TtftMs          UInt64 MATERIALIZED toUInt64OrZero(SpanAttributes['ttft_ms']),
    AgentId         String MATERIALIZED SpanAttributes['agent_id'],
    ParentAgentId   String MATERIALIZED SpanAttributes['parent_agent_id'],
    Model           LowCardinality(String) MATERIALIZED SpanAttributes['model'],
    Decision        LowCardinality(String) MATERIALIZED SpanAttributes['decision']
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/otel_traces', '{replica}')
PARTITION BY toYYYYMM(Timestamp)
ORDER BY (ExperimentGroup, SpanType, toUnixTimestamp(Timestamp))
TTL toDateTime(Timestamp) + INTERVAL 45 DAY TO VOLUME 'cold',
    toDateTime(Timestamp) + INTERVAL 90 DAY DELETE
SETTINGS storage_policy = 'hot_cold';

-- -----------------------------------------------------------------------------
-- 004 블록 — 스키마 마이그레이션 원장 (clickhouse-migration-004.sql의 라이브 클러스터 사본)
--    신규 설치는 정의상 "004까지 적용된" 상태다 — 이 파일이 전부 실행되면 002/003의 컬럼
--    증거가 이미 성립하므로 아래 가드가 세 행을 모두 남긴다. 기존 배포에 이 파일을 다시
--    돌려도 두 번째 가드((b) 아직 기록되지 않았다)가 걸려 멱등이다(실측 2026-09-03,
--    24.8.14.39 컨테이너: 재실행 후에도 정확히 3행).
--    이 파일을 수정하면 schema-init Job 이름에 박힌 filemd5(...)가 바뀐다
--    (infra/clickhouse.tf) — 그래서 다음 terraform apply가 Job을 재생성하고 다시
--    실행하는데, 이 파일의 모든 문장이 IF NOT EXISTS / 가드된 INSERT라서 안전하다.
--    로컬/참조 사본은 clickhouse-schema.sql, 오퍼레이터가 직접 실행하는 파일은
--    clickhouse-migration-004.sql이며 세 파일의 INSERT는 동일 텍스트다.
--    절차는 docs/runbooks/schema-migrations.md.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claude_code.schema_migrations ON CLUSTER 'replicated'
(
    version     UInt16,
    name        String,
    applied_at  DateTime DEFAULT now(),
    checksum    String
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/schema_migrations', '{replica}')
ORDER BY version;

INSERT INTO claude_code.schema_migrations (version, name, checksum) SELECT 2, '002-telemetry-spec-sync', 'd57685094b64edd241f79d48902cf9fd90bdc74bd391fe2eb4b608514609f8d8'
FROM system.one
WHERE (SELECT count() FROM system.columns WHERE database = 'claude_code' AND table = 'otel_metrics_sum' AND name = 'AppVersion') > 0
  AND (SELECT count() FROM claude_code.schema_migrations WHERE version = 2) = 0;

INSERT INTO claude_code.schema_migrations (version, name, checksum) SELECT 3, '003-segment-aware-series-key', '7cbf3ee384022ae22aeda7ec374f1433e44f7392d3760ce84255a1d7d165598b'
FROM system.one
WHERE (SELECT count() FROM system.columns WHERE database = 'claude_code' AND table = 'otel_metrics_sum' AND name = 'SeriesKey' AND default_expression LIKE '%StartTimeUnix%') > 0
  AND ((SELECT count() FROM system.mutations WHERE database = 'claude_code' AND table = 'otel_metrics_sum' AND command LIKE '%MATERIALIZE COLUMN SeriesKey%' AND is_done = 1) > 0 OR (SELECT count() FROM claude_code.otel_metrics_sum) = 0)
  AND (SELECT count() FROM system.mutations WHERE database = 'claude_code' AND table = 'otel_metrics_sum' AND is_done = 0) = 0
  AND (SELECT count() FROM claude_code.schema_migrations WHERE version = 3) = 0;

INSERT INTO claude_code.schema_migrations (version, name, checksum) SELECT 4, '004-schema-migration-ledger', '29b114b2e242852ee208b4ef7fa6dc49d0e8b4b2daf988e18caa2543d62179a5'
FROM system.one
WHERE (SELECT count() FROM claude_code.schema_migrations WHERE version = 4) = 0;
