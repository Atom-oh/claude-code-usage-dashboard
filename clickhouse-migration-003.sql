-- =============================================================================
-- Claude Code A/B Telemetry — 마이그레이션 003 (segment-aware SeriesKey 컷오버)
-- =============================================================================
-- migration: 003 | requires: 002 | records itself: INSERT INTO claude_code.schema_migrations (§10, 검증 후 수동)
-- 대상: 라이브 클러스터(ON CLUSTER 'replicated', infra/files/clickhouse-schema-replicated.sql와
--       동일 토폴로지). 로컬/참조 사본(clickhouse-schema.sql)은 동등한 블록("003" 블록)을
--       CREATE TABLE 본문과 별도로 자체적으로 갖는다 — 신규 설치는 그쪽이 담당, 기존 배포에는
--       이 파일을 실행한다.
--
-- 이 파일은 Terraform으로 적용되지 않는다 — 오퍼레이터가 직접 실행하며, 절차는
-- docs/runbooks/rollup-rebuild-segment-key.md를 따른다.
--
-- 배경(ADR-003): SeriesKey는 지금까지 cityHash64(toString(Attributes))였다 — 프로세스가
-- --resume 등으로 같은 session.id를 유지한 채 카운터를 재시작하면 같은 키로 오인되어
-- 리셋 구간이 사라진다(실측 2026-09-02: 14일 cost.usage 155/1030쌍(15.05%)이 재시작을
-- 겪음). 이 마이그레이션은 아래 §1의 세그먼트 인식 키로 원본 컬럼을 교체하고, 시간별 rollup을
-- shadow 테이블 + EXCHANGE TABLES로 재구축해 같은 세그먼트 경계를 반영시킨다.
--
-- 실행: 이 파일은 --queries-file 로 한 번에 돌리지 않는다. §1→§2→§3 은 statement 단위로
--   실행하고, §4 백필(스크립트) 완료 + §7(b)(c) 검증 후에 §5 EXCHANGE 의 주석을 풀어 수동으로
--   실행한다. 실행문 상태로 두면 --queries-file 한 방 실행이 §3의 빈 _v2 를 §5에서 그대로
--   라이브로 교체해 과거 KPI 가 전부 사라진다(리뷰 지적 2026-09-04) — 그래서 §5는 주석이다.
--   kubectl -n claude-code exec <clickhouse-pod> -c clickhouse -- clickhouse-client
--   로 접속해 각 statement 를 붙여 넣는다.
--
-- 검증: §7(아래, 전부 주석 처리됨)의 6개 쿼리를 절차 진행 중/후 단계별로 실행.
--       docs/runbooks/rollup-rebuild-segment-key.md의 "검증" 절 참고.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. otel_metrics_sum — SeriesKey를 세그먼트 인식 키로 교체
--    실측: MODIFY COLUMN은 메타데이터 전용이다(system.mutations 0행, 기존 파트는 예전 값을
--    그대로 유지). 하지만 MV는 이 순간부터 새 정의로 즉시 쓰기 시작한다(실측 확인: 다음
--    insert부터 rollup에 세그먼트 키가 들어감) — 그래서 §2(MATERIALIZE COLUMN)가 끝나기
--    전까지 원본 테이블에는 레거시 키를 가진 기존 파트와 세그먼트 키를 가진 신규 행이
--    공존한다.
--    예외: claude_code.session.count는 프로세스당 1행이라 세그먼트 키를 적용하면 resume마다
--    새 세션으로 잡혀 세션 KPI가 부풀어 오른다(실측: 30일 기준 441 distinct session.id,
--    현재 KPI 455 → 세그먼트 인식 684, +50%). 그래서 §1의 표현식은 이 메트릭만 레거시 키를
--    유지하도록 분기한다.
-- -----------------------------------------------------------------------------
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated'
    MODIFY COLUMN SeriesKey UInt64 MATERIALIZED
        if(MetricName = 'claude_code.session.count',
           cityHash64(toString(Attributes)),
           cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix)));

-- -----------------------------------------------------------------------------
-- 2. otel_metrics_sum — 기존 파트에도 새 정의를 반영(백그라운드 mutation)
--    실측 규모: 약 498M행 / 2.24GiB. 진행 상황은 system.mutations에서 확인하며, 이 계정
--    (otel_reader)에는 system.mutations 조회 권한이 없다 — 권한 있는 계정으로 확인할 것.
--    과도기 효과: 이 mutation이 끝나기 전까지 RAW 경로(≤4시간 구간·분 단위 버킷의
--    incFlatRaw/incBucketedRaw, Grafana 패널, chat SQL이 원본 테이블을 직접 읽는 경우)는
--    statement 1 시점에 살아있던 세션에 대해 레거시 키 행과 세그먼트 키 행이 섞여 보여
--    일시적으로 과대집계된다. rollup 경로는 아래에서 별도로 재구축되므로 영향받지 않는다.
-- -----------------------------------------------------------------------------
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN SeriesKey;

-- -----------------------------------------------------------------------------
-- 3. otel_metrics_sum_hourly_v2 — shadow 롤업 테이블 생성
--    16개 컬럼/타입은 라이브 롤업(infra/files/clickhouse-schema-replicated.sql의
--    otel_metrics_sum_hourly CREATE 블록)과 동일하다.
--    ZK 경로는 의도적으로 라이브와 다르다(…_hourly_v2) — 같은 경로를 쓰면 이 테이블이
--    새로 생성되는 게 아니라 라이브 테이블의 replica로 붙어버린다.
--    IF NOT EXISTS를 일부러 쓰지 않는다 — 이전 실행의 _v2가 남아있다면 롤백 창이 아직
--    열려있다는 뜻이고, 이 statement는 그걸 조용히 재사용하지 말고 크게 실패해야 한다.
--    ORDER BY의 13개 컬럼 전체가 라이브의 정렬 키 드리프트(StartType/AppVersion이
--    migration-002에서 일반 컬럼으로만 추가되고 정렬 키에는 못 들어감 —
--    clickhouse-migration-002.sql:63-66 참고)를 이 shadow 재구축으로 해소한다.
--    TTL은 DELETE만 있고 볼륨을 참조하지 않으므로 storage_policy = 'hot_cold'가 라이브의
--    현재 default 정책과 무관하게 받아들여진다 — 동시에 신규 설치용 replicated 스키마
--    정의와도 이 테이블을 일치시킨다.
-- -----------------------------------------------------------------------------
CREATE TABLE claude_code.otel_metrics_sum_hourly_v2 ON CLUSTER 'replicated'
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
    StartType              LowCardinality(String),
    AppVersion             LowCardinality(String),
    max_value SimpleAggregateFunction(max, Float64),
    sum_value SimpleAggregateFunction(sum, Float64),
    has_org   SimpleAggregateFunction(max, UInt8)
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/otel_metrics_sum_hourly_v2', '{replica}')
PARTITION BY toYYYYMM(hour)
ORDER BY (MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality,
          Model, TokenType, Decision, SkillName, ToolName, StartType, AppVersion, hour)
TTL toDateTime(hour) + INTERVAL 180 DAY DELETE
SETTINGS storage_policy = 'hot_cold';

-- -----------------------------------------------------------------------------
-- 4. 백필(range 모드) — _v2에 [최소 시각, H0) 구간을 채운다.
--    H0 = 이 순간의 toStartOfHour(now())를 오퍼레이터가 직접 기록해 아래에 대입한다.
--    스크립트가 SeriesKey를 명시적으로(§1과 동일한 표현식 그대로) 계산하므로, 이 단계는
--    §2(MATERIALIZE COLUMN)의 완료를 기다릴 필요가 없다.
--
-- TARGET_TABLE=claude_code.otel_metrics_sum_hourly_v2 \
--   RANGE_TO='<H0>' CH_HOST=<host> CH_PASSWORD=<pw> ./scripts/backfill-hourly-rollup.sh
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 5. EXCHANGE TABLES — 라이브 이름과 shadow 테이블을 원자적으로 교체
--    원자적, 가시적 공백 없음. MV의 TO 대상은 이름으로 resolve되므로(실측 확인) 교체 즉시
--    재구축된 테이블에 쓰기 시작한다.
--    교체 이후 라이브 이름(otel_metrics_sum_hourly)의 실제 ZK 경로는
--    …/otel_metrics_sum_hourly_v2가 되고, 옛 데이터는 …/otel_metrics_sum_hourly에 남는다 —
--    이 이름/경로 역전이 이 절차에서 가장 헷갈리는 결과이니 반드시 인지할 것.
-- -----------------------------------------------------------------------------
--    사전 검사(EXCHANGE 직전): count() > 0, min(hour) ≈ raw 의 최소 시각, max(hour) = H0 - 1h 이어야 한다.
-- SELECT min(hour), max(hour), count() FROM claude_code.otel_metrics_sum_hourly_v2;
--    ※ §4 백필 완료 + §7(b)(c) 통과 후에만 주석을 풀어 실행한다(그 전에 실행하면 빈 rollup 이 라이브가 된다).
-- EXCHANGE TABLES claude_code.otel_metrics_sum_hourly AND claude_code.otel_metrics_sum_hourly_v2 ON CLUSTER 'replicated';

-- -----------------------------------------------------------------------------
-- 6. 갭 채우기(range 모드) — 라이브 이름에 [H0, Hx) 구간을 채운다.
--    Hx = §5 EXCHANGE 를 실행한 시각의 toStartOfHour + 1시간(= EXCHANGE 가 속한 버킷의 끝).
--    watermark 모드가 아니라 range 모드를 쓰고 TARGET_TABLE 은 기본값(라이브 이름) 그대로 둔다.
--    EXCHANGE 이전에 MV 가 쓴 행은 옛 테이블(_v2)에 남으므로 새 라이브 롤업의 EXCHANGE 버킷에는
--    EXCHANGE 이후 도착분만 있다 — 그 버킷 안에서 마지막 샘플을 내고 끝난 세션의 최종 증가분은
--    다시 채우지 않으면 롤업에서 영구 누락된다(리뷰 지적 2026-09-05). max 계열(max_value/has_org)
--    은 겹쳐 백필해도 멱등하므로 EXCHANGE 버킷을 통째로 다시 채워 이를 살린다.
--    대가: sum_value(AggregationTemporality=1 행)는 SimpleAggregateFunction(sum) 이라 MV 가 이미
--    쓴 EXCHANGE 버킷의 delta 행이 한 번 더 더해진다(실측 2026-09-02 prod: delta 행은 롤업 전체에서
--    2건). Hx 이후 버킷은 MV 만 쓰므로 RANGE_TO 를 Hx 보다 뒤로 잡지 않는다. §7(f) 로 중복을 확인하고,
--    필요하면 그 버킷의 delta 행만 ALTER TABLE ... DELETE 후 같은 range 로 다시 채운다.
--
-- TARGET_TABLE=claude_code.otel_metrics_sum_hourly RANGE_FROM='<H0>' RANGE_TO='<Hx>' \
--   CH_HOST=<host> CH_PASSWORD=<pw> ./scripts/backfill-hourly-rollup.sh
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 7. 검증 — 전부 주석 처리(clickhouse-migration-002.sql §5와 동일한 패턴). 필요할 때
--    하나씩 주석을 풀어 실행할 것.
-- -----------------------------------------------------------------------------

-- (a) MV가 새 테이블에 쓰는지 확인 — 2~3분 간격으로 두 번 실행.
--     라이브 이름은 반드시 head가 전진해야 하고, _v2(옛 데이터)는 멈춰 있어야 한다.
--     옛 테이블이 계속 자라면 fallback: DROP VIEW claude_code.otel_metrics_sum_hourly_mv
--     ON CLUSTER 'replicated' 후 infra/files/clickhouse-schema-replicated.sql의
--     CREATE MATERIALIZED VIEW를 재실행하고, 갭 채우기(§6)를 다시 수행한다.
-- SELECT max(hour) AS head, count() AS rows FROM claude_code.otel_metrics_sum_hourly;
-- SELECT max(hour) AS head, count() AS rows FROM claude_code.otel_metrics_sum_hourly_v2;

-- (b) 키 일치 검증 — §2(MATERIALIZE COLUMN) 완료 후 실행. 2026-07-10 mismatch=0 검증과
--     동일한 패턴이며 반드시 0이어야 한다.
-- SELECT countIf(SeriesKey != if(MetricName = 'claude_code.session.count', cityHash64(toString(Attributes)), cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix)))) AS mismatch
-- FROM claude_code.otel_metrics_sum
-- WHERE TimeUnix >= now() - INTERVAL 1 DAY;

-- (c) mutation 진행 상황(권한 있는 계정으로 실행 — otel_reader는 system.mutations를 못 읽음).
-- SELECT count() FROM system.mutations
-- WHERE database = 'claude_code' AND table = 'otel_metrics_sum' AND NOT is_done;

-- (d) 14일 비용 총계 — 신규 롤업 vs 옛 _v2 테이블. 기대치: 약 +12~17%(실측 30일 기준
--     +12.7%). lagInFrame(mv, 1, 0)의 0-default가 핵심이다: 새 세그먼트의 첫 버킷은
--     증가분 전체를 싣고 있으므로, lagInFrame(mv, 1, mv) default를 쓰면 이 마이그레이션이
--     복구하려는 값이 그대로 지워진다. 동시에 이 0-default는 창(window) 이전부터 존재하던
--     시리즈의 과거 전체도 함께 잡아버리는데, 이는 신규/구 롤업 양쪽에 동일하게 적용되므로
--     절대값이 아니라 비율(ratio)로 읽어야 한다.
-- SELECT round(sum(inc), 2) AS cost_usd FROM (
--   SELECT greatest(mv - lagInFrame(mv, 1, 0) OVER
--            (PARTITION BY MetricName, SessionId, SeriesKey ORDER BY hour), 0) AS inc
--   FROM (SELECT hour, MetricName, SessionId, SeriesKey, max(max_value) AS mv
--         FROM claude_code.otel_metrics_sum_hourly
--         WHERE MetricName = 'claude_code.cost.usage'
--           AND hour >= toStartOfHour(now()) - INTERVAL 14 DAY
--         GROUP BY hour, MetricName, SessionId, SeriesKey));
-- SELECT round(sum(inc), 2) AS cost_usd FROM (
--   SELECT greatest(mv - lagInFrame(mv, 1, 0) OVER
--            (PARTITION BY MetricName, SessionId, SeriesKey ORDER BY hour), 0) AS inc
--   FROM (SELECT hour, MetricName, SessionId, SeriesKey, max(max_value) AS mv
--         FROM claude_code.otel_metrics_sum_hourly_v2
--         WHERE MetricName = 'claude_code.cost.usage'
--           AND hour >= toStartOfHour(now()) - INTERVAL 14 DAY
--         GROUP BY hour, MetricName, SessionId, SeriesKey));

-- (e) 일별 행 커버리지 — 신규 vs 옛 테이블, 빠진 날이 없어야 한다.
-- SELECT toStartOfDay(hour) AS d, count() AS rows FROM claude_code.otel_metrics_sum_hourly
-- GROUP BY d ORDER BY d;
-- SELECT toStartOfDay(hour) AS d, count() AS rows FROM claude_code.otel_metrics_sum_hourly_v2
-- GROUP BY d ORDER BY d;

-- (f) delta 행 중복 확인 — §6 이 MV 구간과 겹쳤다면 rolled 가 raw 의 2배로 나온다.
--     상관 서브쿼리는 24.8 에서 실행되지 않으므로 두 집계의 JOIN 으로 쓴다.
-- SELECT r.MetricName, r.hour, r.rolled, w.raw
-- FROM (SELECT MetricName, hour, sum(sum_value) AS rolled
--       FROM claude_code.otel_metrics_sum_hourly WHERE AggregationTemporality = 1
--       GROUP BY MetricName, hour) AS r
-- LEFT JOIN (SELECT MetricName, toStartOfHour(TimeUnix) AS hour, sum(Value) AS raw
--            FROM claude_code.otel_metrics_sum WHERE AggregationTemporality = 1
--            GROUP BY MetricName, hour) AS w USING (MetricName, hour)
-- ORDER BY r.hour DESC LIMIT 20;

-- -----------------------------------------------------------------------------
-- 8. 롤백 창 및 정리
--    _v2(옛 데이터)는 롤백 창 동안 보존한다. 롤백 = EXCHANGE TABLES 재실행 +
--    MODIFY COLUMN을 레거시 표현식(cityHash64(toString(Attributes)))으로 되돌리기 +
--    MATERIALIZE COLUMN(실측: 왕복 후 mismatch=0).
--    롤백 EXCHANGE 뒤에는 컷오버~롤백 사이에 라이브 이름에 쌓인 시간대가 옛 테이블에 없다 — §6과 같은 range 모드로 그 구간을 다시 채운다.
--    창이 끝나면:
-- DROP TABLE claude_code.otel_metrics_sum_hourly_v2 ON CLUSTER 'replicated';
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 9. 로컬(비복제, docker compose) 스택 변형
--    참조 스키마의 CREATE는 이미 전체 정렬 키를 갖고 있으므로 로컬 롤업은 shadow 테이블이
--    필요 없다: TRUNCATE TABLE claude_code.otel_metrics_sum_hourly 후
--    scripts/backfill-hourly-rollup.sh로 다시 채우면 된다(로컬은 트래픽 걱정이 없다).
--    자세한 내용은 clickhouse-schema.sql의 자체 "003" 블록을 참고.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 10. 자기 기록 — §7 검증을 모두 통과한 뒤 주석을 풀어 마지막으로 실행한다(§5와 같은 이유로 실행문으로 두지 않는다).
--    clickhouse-migration-004.sql이 만든 원장(claude_code.schema_migrations)에 이 마이그레이션을
--    기록한다. 004의 소급 INSERT와 텍스트가 같으며(가드도 같다), 004 §2가 설명하듯 004의 소급
--    기록은 메타데이터 증거만 볼 수 있으므로 rollup 재구축까지 끝냈다는 사실은 이 문장이
--    오퍼레이터의 손으로 남긴다. 원장 테이블이 아직 없으면(004 미적용) 004를 먼저 실행한다.
--    INSERT에는 ON CLUSTER를 붙이지 않는다 — 한 파드에서 한 번만.
--    가드 넷: SeriesKey 식(§1), MATERIALIZE 완료(§2, 또는 빈 테이블), 미완료 mutation 없음, 라이브 롤업의
--    ZK 경로가 …_hourly_v2 로 끝남(§5 EXCHANGE 의 이름/경로 역전 — 재구축이 실제로 라이브가 됐다는 증거).
--    MATERIALIZE mutation 기록이 finished_mutations_to_keep(기본 100)에서 밀려난 뒤라면 system.mutations
--    조건 두 줄을 빼고 실행한다 — 그때는 §7 검증 통과가 그 자리의 증거다.
-- -----------------------------------------------------------------------------
-- INSERT INTO claude_code.schema_migrations (version, name, checksum) SELECT 3, '003-segment-aware-series-key', '2c22a451ed888c93a3613ccaf1698ccf4dda636fa6ad02e8cdcbfbe64be2824d'
-- FROM system.one
-- WHERE (SELECT count() FROM system.columns WHERE database = 'claude_code' AND table = 'otel_metrics_sum' AND name = 'SeriesKey' AND default_expression LIKE '%StartTimeUnix%') > 0
--   AND ((SELECT count() FROM system.mutations WHERE database = 'claude_code' AND table = 'otel_metrics_sum' AND command LIKE '%MATERIALIZE COLUMN SeriesKey%' AND is_done = 1) > 0 OR (SELECT count() FROM claude_code.otel_metrics_sum) = 0)
--   AND (SELECT count() FROM system.mutations WHERE database = 'claude_code' AND table = 'otel_metrics_sum' AND is_done = 0) = 0
--   AND ((SELECT count() FROM system.tables WHERE database = 'claude_code' AND name = 'otel_metrics_sum_hourly' AND engine_full LIKE '%otel_metrics_sum_hourly_v2%') > 0 OR (SELECT count() FROM claude_code.otel_metrics_sum) = 0)
--   AND (SELECT count() FROM claude_code.schema_migrations WHERE version = 3) = 0;

-- SELECT version, applied_at FROM claude_code.schema_migrations WHERE version = 3;  -- 정확히 1행이어야 한다
