-- =============================================================================
-- Claude Code A/B Telemetry — 마이그레이션 002 (2026-08-11 스펙 동기화)
-- =============================================================================
-- 대상: 라이브 클러스터(ON CLUSTER 'replicated', infra/files/clickhouse-schema-replicated.sql와
--       동일 토폴로지). 로컬/참조 사본(clickhouse-schema.sql)은 CREATE TABLE 본문에 이미 같은
--       컬럼을 담고 있고 이 파일과 동일한 ALTER 블록을 별도로 갖는다 — 신규 설치는 그쪽이
--       담당, 기존 배포에는 이 파일을 실행한다.
--
-- 원칙: 기존 테이블 DROP 없음. 전부 `ADD COLUMN IF NOT EXISTS` + `MATERIALIZE COLUMN`
--       (SeriesKey/McpServerName 마이그레이션과 동일한 패턴 — clickhouse-schema.sql:91-95 참고).
--       otel_traces는 라이브에 아예 없는 신규 테이블이라 `CREATE TABLE IF NOT EXISTS`만 필요.
--
-- 실행:
--   kubectl -n claude-code exec <clickhouse-pod> -c clickhouse -- \
--     clickhouse-client --queries-file /path/to/clickhouse-migration-002.sql
--   (또는 clickhouse-client < clickhouse-migration-002.sql로 스트림 실행 — ON CLUSTER 문장은
--    분산 DDL이라 각 문장이 순차 실행되며 클러스터 전체에 전파된다.)
--
-- 검증(STEP 6-1): 이 파일 실행 후 아래 쿼리로 신규 컬럼이 실제로 채워지는지 확인.
--   SELECT MetricName, arrayJoin(mapKeys(Attributes)) k, count()
--   FROM claude_code.otel_metrics_sum GROUP BY 1,2 ORDER BY 1,3 DESC;
-- Speed는 0행이 정상(이 플릿은 fast 모드를 쓴 적이 없다 — 실측 2026-08-11).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. otel_metrics_sum — STEP 1(cost/token attribution) + STEP 4(identity/version)
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 2. otel_metrics_sum_hourly — StartType/AppVersion을 키 컬럼으로 추가.
--    주의: ADD COLUMN은 기존 파트에 빈 값만 채운다(AggregatingMergeTree라 MATERIALIZE COLUMN
--    이 없다 — 원본에서 재집계해야 함). 세션 카운트 패널(agents_view 필터)이 롤업 경로에서도
--    정확해야 하면 scripts/backfill-hourly-rollup.sh를 이 컬럼 추가 후 재실행할 것. 두 값이
--    빈 문자열이어도 `StartType != 'agents_view'` 필터는 안전(빈 값 통과) — 백필 전까지는
--    과거분 필터가 그냥 no-op이라는 뜻일 뿐, 잘못된 제외는 발생하지 않는다.
-- -----------------------------------------------------------------------------
ALTER TABLE claude_code.otel_metrics_sum_hourly ON CLUSTER 'replicated'
    ADD COLUMN IF NOT EXISTS StartType  LowCardinality(String) AFTER ToolName,
    ADD COLUMN IF NOT EXISTS AppVersion LowCardinality(String) AFTER StartType;

-- ORDER BY(정렬 키)는 라이브에서 ALTER로 바꿀 수 없다(MergeTree 계열 제약) — 새 키 컬럼을
-- 정렬 키에 넣으려면 테이블 재생성이 필요하다. 지금 범위에서는 컬럼만 추가하고 정렬 키는
-- 그대로 둔다(GROUP BY로 재집계하는 소비 패턴이라 정렬 키 미포함이 정확성에 영향을 주지
-- 않는다 — 다만 이 컬럼으로 필터링하는 쿼리는 정렬 키 프루닝을 못 받아 스캔이 더 든다).
-- MV(otel_metrics_sum_hourly_mv)의 SELECT를 바꾼다. ClickHouse 24.8은
-- `CREATE OR REPLACE MATERIALIZED VIEW`를 지원하지 않는다(TABLE/VIEW/DICTIONARY/FUNCTION만
-- 허용, 실측 확인) — `ALTER TABLE ... MODIFY QUERY`로 SELECT만 교체한다. TO 테이블은 그대로.
ALTER TABLE claude_code.otel_metrics_sum_hourly_mv ON CLUSTER 'replicated' MODIFY QUERY
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

-- -----------------------------------------------------------------------------
-- 3. otel_logs — STEP 3(신규 이벤트 5종) + STEP 4(identity/version)
-- -----------------------------------------------------------------------------
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
-- 4. otel_traces (STEP 2, beta) — 신규 테이블. 라이브에 존재하지 않음(실측: system.tables에
--    없음, 2026-08-11) — exporter의 create_schema: false 때문에 이 DDL이 먼저 실행돼야 한다.
--    정의는 clickhouse-schema.sql의 "2c. Traces (beta)" 섹션과 동일 —
--    ON CLUSTER/ReplicatedMergeTree/hot_cold TTL만 라이브 전용으로 다르다(otel_logs와 동일한
--    45일 cold 이동 + 90일 삭제 정책).
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
-- 5. 검증 (STEP 6-1) — 실측으로 신규 컬럼이 채워졌는지 확인. Speed=0행은 정상.
-- -----------------------------------------------------------------------------
SELECT MetricName, arrayJoin(mapKeys(Attributes)) AS k, count() AS c
FROM claude_code.otel_metrics_sum
WHERE MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')
GROUP BY MetricName, k
ORDER BY MetricName, c DESC;

SELECT
    countIf(Effort != '')          AS n_effort,
    countIf(PluginName != '')      AS n_plugin,
    countIf(McpServerName != '')   AS n_mcp_server,
    countIf(Speed != '')           AS n_speed,      -- 0 기대(실측 근거 있음)
    countIf(StartType != '')       AS n_start_type,
    countIf(EndUserId != '')       AS n_enduser_id,  -- user-data.sh 적용 전이면 0
    countIf(AppVersion != '')      AS n_app_version  -- service.version이 이미 항상 채워짐 — 100% 기대
FROM claude_code.otel_metrics_sum;

SELECT EventName, count() AS c
FROM claude_code.otel_logs
WHERE EventName IN ('skill_activated', 'compaction', 'api_refusal', 'api_retries_exhausted', 'plugin_loaded')
GROUP BY EventName
ORDER BY c DESC;

SELECT count() AS otel_traces_rows FROM claude_code.otel_traces;
