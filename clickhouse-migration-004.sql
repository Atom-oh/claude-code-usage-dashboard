-- =============================================================================
-- Claude Code A/B Telemetry — 마이그레이션 004 (스키마 마이그레이션 원장)
-- =============================================================================
-- migration: 004 | requires: 003 | records itself: INSERT INTO claude_code.schema_migrations
--
-- 대상: 라이브 클러스터(ON CLUSTER 'replicated', infra/files/clickhouse-schema-replicated.sql와
--       동일 토폴로지). 로컬/참조 사본(clickhouse-schema.sql)은 동등한 블록("004" 블록)을
--       자체적으로 갖는다 — 신규 설치는 그쪽이 담당, 기존 배포에는 이 파일을 실행한다.
--
-- 이 파일은 Terraform으로 적용되지 않는다 — 오퍼레이터가 직접 실행하며, 절차는
-- docs/runbooks/schema-migrations.md를 따른다.
--
-- 배경: 002와 003은 사람이 직접 실행하는 파일이고, 어느 클러스터에 무엇이 적용됐는지 기록하는
-- 곳이 없었다 — 확인 방법이 system.columns를 직접 뒤지는 것뿐이었고 otel_reader에는 그 권한이
-- 없다(infra/clickhouse.tf의 grants). 이 마이그레이션은 원장 테이블을 만들고, 002/003이
-- 적용됐는지를 컬럼 증거로 판정해 소급 기록한다. 004 자신은 원장 테이블의 존재가 곧 증거다.
--
-- 앞으로 추가되는 모든 clickhouse-migration-NNN.sql은 마지막에 자기 자신을 기록하는 가드된
-- INSERT를 포함한다. checksum은 작성 시점에 아래 명령으로 계산해 리터럴로 박는다:
--   grep -v 'INSERT INTO claude_code.schema_migrations' clickhouse-migration-00N.sql \
--     | sha256sum | cut -c1-64
-- version/name/checksum 리터럴은 반드시 `INSERT INTO claude_code.schema_migrations`와 같은
-- 물리적 줄에 있어야 한다 — 위 grep이 지우는 줄이 그 줄이라서, 다음 줄로 내리면 checksum이
-- 자기 자신을 해싱한 값이 되어 검증이 불가능해진다.
--
-- 실행:
--   kubectl -n claude-code exec <clickhouse-pod> -c clickhouse -- \
--     clickhouse-client --queries-file /path/to/clickhouse-migration-004.sql
--
-- 검증: SELECT version, name, applied_at FROM claude_code.schema_migrations ORDER BY version;
--       → 2, 3, 4 (003이 아직 적용되지 않은 클러스터에서는 2, 4). 대시보드에서는
--       GET /api/config의 schema.migrations로도 같은 목록이 보인다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 원장 테이블
--    ReplacingMergeTree가 아닌 이유: 아래 가드가 중복 INSERT를 애초에 막으므로, 머지 시점
--    중복 제거에 의존하면 "지금 몇 행인가"의 답이 머지 타이밍에 따라 달라진다.
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

-- -----------------------------------------------------------------------------
-- 2. 소급 기록 — 가드된 INSERT
--    가드는 스칼라 count() 서브셀렉트 두 개다: (a) 그 마이그레이션이 실제로 적용됐다는 컬럼
--    증거, (b) 아직 기록되지 않았다는 것. EXISTS 대신 count()를 쓰는 이유는 이 형태가 24.8에서
--    검증된 것이기 때문이다(실측 2026-09-03, clickhouse/clickhouse-server:24.8.14.39 컨테이너:
--    세 INSERT 모두 실행되어 2·3·4가 기록되고, 같은 파일을 두 번 더 돌려도 정확히 3행).
--
--    002의 증거: otel_metrics_sum.AppVersion 컬럼의 존재.
--    003의 증거: (1) otel_metrics_sum.SeriesKey의 default_expression이 StartTimeUnix를 포함하고,
--      (2) 그 컬럼의 MATERIALIZE COLUMN mutation이 system.mutations에 완료(is_done=1)로 남아 있고,
--          (또는 테이블이 비어 있을 것 — 신규 설치는 CREATE 부터 새 키라 MATERIALIZE 가 없다),
--      (3) 그 테이블에 미완료 mutation이 없을 것. (1)만 보면 003 §1(메타데이터 전용 MODIFY COLUMN)
--      직후 중단된 클러스터도 "적용됨"으로 기록된다(리뷰 지적 2026-09-04). rollup 재구축(003 §3~§6)
--      의 성공은 여기서 판별할 수 없다 — 그래서 003은 이제 §10에서 스스로 기록하고, 이 소급 INSERT는
--      원장이 생기기 전에 003을 끝낸 클러스터를 위한 것이다. StartTimeUnix 자체는 원래 있는 기본
--      컬럼이라 존재만으로는 아무것도 증명하지 않는다. system.mutations는 완료 mutation을 기본
--      finished_mutations_to_keep=100건까지만 보존하므로, 그 뒤에 003을 소급 기록해야 하면
--      003 §10의 INSERT를 직접 실행한다.
--    004의 증거: 이 원장 테이블 자체 — 그래서 (b) 가드만 둔다.
--
--    INSERT에는 ON CLUSTER를 붙이지 않는다(INSERT는 DDL이 아니다) — ReplicatedMergeTree의
--    복제 로그로 다른 레플리카에 전파된다. 한 파드에서 한 번만 실행할 것.
-- -----------------------------------------------------------------------------
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
