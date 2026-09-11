-- =============================================================================
-- Claude Code A/B Telemetry — 마이그레이션 005 (project.name / app.entrypoint 승격)
-- =============================================================================
-- migration: 005 | requires: 004 | records itself: INSERT INTO claude_code.schema_migrations
--
-- 대상: 라이브 클러스터(ON CLUSTER 'replicated', infra/files/clickhouse-schema-replicated.sql와
--       동일 토폴로지). 로컬/참조 사본(clickhouse-schema.sql)은 동등한 블록("005" 블록)을
--       자체적으로 갖는다 — 신규 설치는 그쪽이 담당, 기존 배포에는 이 파일을 실행한다.
--
-- 이 파일은 Terraform으로 적용되지 않는다 — 오퍼레이터가 직접 실행하며, 절차는
-- docs/runbooks/schema-migrations.md를 따른다.
--
-- 배경: Claude Code는 cwd/git 저장소 정보를 텔레메트리로 내보내지 않는다(문서·실측 모두 확인 —
-- workspace.host_paths는 데스크톱 전용이라 이 플릿에서 0행). 저장소 단위 분해는 운영자가 심는
-- 리소스 속성 project.name으로만 가능하다 — 주입 방법은 README "Telemetry Ingestion"의
-- 'Project tag (project.name)' 소절 참고. app.entrypoint는 반대로 이미 들어오고 있는데
-- (실측 2026-09-09, 프로드 otel_logs 14일: LogAttributes['app.entrypoint']='vscode' 29,938행,
-- 터미널 세션은 빈 값) 대시보드가 쓰지 않고 있었다.
--
-- 두 컬럼 모두 세 테이블(otel_metrics_sum / otel_logs / otel_traces)에 additive MATERIALIZED로
-- 올린다. app.entrypoint의 소스 맵이 테이블마다 다르다: 메트릭은 Attributes, 로그는
-- LogAttributes, 트레이스는 SpanAttributes. project.name은 세 테이블 모두 ResourceAttributes다.
-- 빈 값은 빈 문자열로 그대로 둔다 — 터미널 표기('terminal')는 쿼리 계층이 붙인다
-- (dashboard/server/queries.js entrypointBreakdown).
--
-- MATERIALIZE COLUMN을 일부러 실행하지 않는다 — 002/003과 다른 점이라 근거를 남긴다.
-- 실측(2026-09-09, clickhouse/clickhouse-server:24.8.14.39): ADD COLUMN 이전에 만들어진
-- 파트에서도 두 컬럼을 그냥 SELECT하면 default 표현식이 읽기 시점에 평가되어 정확한 값이 나오고,
-- 그 파트 전수 비교에서 컬럼 값과 맵 조회 값의 mismatch가 0이었다. 002/003이 MATERIALIZE를 돌린
-- 이유는 (a) SeriesKey가 Attributes 맵 전체를 해시하는 비싼 식이라 인라인 평가가 같은 쿼리를 11배
-- 느리게 만들었고 (b) 시간별 롤업 백필이 그 값을 읽어야 했기 때문인데, 여기 두 컬럼은 맵 키 한 번
-- 조회라 두 근거가 모두 없다. 반대로 mutation을 걸면 원본 테이블의 컬럼을 전부 재작성하는데
-- 기존 행에는 project.name이 애초에 없어 얻는 정보가 0이고, 진행 중 mutation은 앞으로의
-- 마이그레이션 가드(003의 `system.mutations ... is_done = 0`)를 막는다.
--
-- 시간별 롤업(otel_metrics_sum_hourly)은 건드리지 않는다 — 프로젝트별/진입점별 집계는 원본
-- 테이블만 읽는다(queries.js의 projectBreakdown은 자기완결 로컬 diff 서브쿼리,
-- entrypointBreakdown은 otel_logs 직접 스캔이라 둘 다 롤업 경로를 타지 않는다). 롤업에 키 컬럼을
-- 더하면 ADR-001이 다루는 GROUP BY 확장 문제를 그대로 불러온다.
--
-- 실행:
--   kubectl -n claude-code exec -i <clickhouse-pod> -c clickhouse -- \
--     clickhouse-client --multiquery < clickhouse-migration-005.sql
--
-- 사전 확인(필수): 아래 §3은 otel_traces를 ALTER한다. 그 테이블이 없는 클러스터에서는
-- Code 60 UNKNOWN_TABLE로 실패하고 --multiquery가 거기서 abort해 §4의 원장 INSERT까지
-- 실행되지 않는다(에러 코드는 2026-09-09 실측 확인. 같은 abort 패턴이 프로드 schema-init Job에서
-- BAD_TTL_EXPRESSION으로 실제 발생했다 — docs/architecture.md Storage Layer 참고). 먼저:
--   SELECT count() FROM system.tables WHERE database = 'claude_code' AND name = 'otel_traces';
--   → 0이면 §3을 건너뛰고 §1·§2·§4만 실행한다(§4 가드가 그 경우를 허용한다).
--
-- 사전 확인(필수, 2): 이 파일은 004(claude_code.schema_migrations 원장)를 전제한다 — 헤더의
-- requires: 004. 원장 테이블이 없으면 §4의 자기-기록 INSERT가 Code 60 UNKNOWN_TABLE로 실패해
-- (실측 2026-09-10, 24.8.14.39) 이 마이그레이션이 영원히 미기록으로 남는다. 먼저:
--   SELECT count() FROM system.tables WHERE database = 'claude_code' AND name = 'schema_migrations';
--   → 0이면 clickhouse-migration-004.sql을 먼저 실행한다.
--
-- 검증: SELECT version, name, applied_at FROM claude_code.schema_migrations ORDER BY version;
--       → 2, 3, 4, 5. 대시보드에서는 GET /api/config의 schema.migrations로 같은 목록이 보이고,
--       schema.projectColumns가 true로 바뀐다(부팅 + 10분 주기 프로브).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. otel_metrics_sum — app.entrypoint는 datapoint 속성(Attributes)이다.
-- -----------------------------------------------------------------------------
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated'
    ADD COLUMN IF NOT EXISTS ProjectName LowCardinality(String) MATERIALIZED ResourceAttributes['project.name'],
    ADD COLUMN IF NOT EXISTS Entrypoint  LowCardinality(String) MATERIALIZED Attributes['app.entrypoint'];

-- -----------------------------------------------------------------------------
-- 2. otel_logs — 로그 이벤트 속성은 LogAttributes다.
-- -----------------------------------------------------------------------------
ALTER TABLE claude_code.otel_logs ON CLUSTER 'replicated'
    ADD COLUMN IF NOT EXISTS ProjectName LowCardinality(String) MATERIALIZED ResourceAttributes['project.name'],
    ADD COLUMN IF NOT EXISTS Entrypoint  LowCardinality(String) MATERIALIZED LogAttributes['app.entrypoint'];

-- -----------------------------------------------------------------------------
-- 3. otel_traces — 스팬 속성은 SpanAttributes다. 위 "사전 확인"을 먼저 읽을 것.
-- -----------------------------------------------------------------------------
ALTER TABLE claude_code.otel_traces ON CLUSTER 'replicated'
    ADD COLUMN IF NOT EXISTS ProjectName LowCardinality(String) MATERIALIZED ResourceAttributes['project.name'],
    ADD COLUMN IF NOT EXISTS Entrypoint  LowCardinality(String) MATERIALIZED SpanAttributes['app.entrypoint'];

-- -----------------------------------------------------------------------------
-- 4. 자기 기록 — 가드된 INSERT (004 §2와 같은 규약)
--    증거: otel_metrics_sum과 otel_logs의 ProjectName 컬럼 존재. otel_traces는 "컬럼이 있거나,
--    테이블 자체가 없거나"를 허용한다(003의 롤업 ZK 경로 가드와 같은 형태) — 트레이스 테이블이
--    없는 클러스터에서 이 마이그레이션이 영원히 미기록으로 남는 쪽이 더 나쁘다.
--    INSERT에는 ON CLUSTER를 붙이지 않는다(INSERT는 DDL이 아니다) — ReplicatedMergeTree의
--    복제 로그로 다른 레플리카에 전파된다. 한 파드에서 한 번만 실행할 것.
-- -----------------------------------------------------------------------------
INSERT INTO claude_code.schema_migrations (version, name, checksum) SELECT 5, '005-project-tag-and-entrypoint', 'abdde352853f487d7b119ef2d15523629011ec988d308e1cbfad7a78d77b44f5'
FROM system.one
WHERE (SELECT count() FROM system.columns WHERE database = 'claude_code' AND table = 'otel_metrics_sum' AND name = 'ProjectName') > 0
  AND (SELECT count() FROM system.columns WHERE database = 'claude_code' AND table = 'otel_logs' AND name = 'ProjectName') > 0
  AND ((SELECT count() FROM system.columns WHERE database = 'claude_code' AND table = 'otel_traces' AND name = 'ProjectName') > 0
       OR (SELECT count() FROM system.tables WHERE database = 'claude_code' AND name = 'otel_traces') = 0)
  AND (SELECT count() FROM claude_code.schema_migrations WHERE version = 5) = 0;
