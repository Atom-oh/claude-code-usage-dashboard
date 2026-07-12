# Data / 데이터 구성 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
All telemetry lands in two ClickHouse tables (`otel_metrics_sum`, `otel_logs`) with a
hot/cold storage policy (local EBS -> S3 after 45-90 days, dropped after 90-180 days). Values
are cumulative OTel counters, not deltas, which drives most of the query-layer complexity.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| ClickHouse schema (reference) | `clickhouse-schema.sql` | `otel_metrics_sum` / `otel_logs` DDL with promoted/materialized columns |
| ClickHouse schema (replicated) | `infra/files/clickhouse-schema-replicated.sql` | Same schema, applied by the ClickHouse operator on the EKS cluster |
| Hourly rollup | `otel_metrics_sum_hourly` (in `clickhouse-schema.sql`), fed by a materialized view on `otel_metrics_sum` | ~86x fewer rows than the raw table; dashboard queries read this instead of `otel_metrics_sum` directly (raw grows ~3M rows/day from 10s cumulative re-exports) |
| Grouping heuristic | `dashboard/server/grouping.js` | Session-scoped bedrock/enterprise classification (`GROUP_CTE`), reads the rollup's `has_org` column |
| Pricing table | `dashboard/server/pricing.js` | Per-model token pricing, model name normalization |
| Demo seed data | `dashboard/seed/*.sql` | Workshop demo data loaded into ClickHouse |

### 3. Key Decisions
- **Cumulative counters, diffed at query time** -- Claude Code exports session-cumulative
  values every ~30s; summing raw `Value` overcounts by orders of magnitude. `incFlat`/
  `incBucketed` in `dashboard/server/queries.js` diff at session boundaries instead (see
  `LOOKBACK_DAYS` for the baseline-lookback trade-off).
- **Query layer reads an hourly rollup, not the raw table** -- `incFlat`/`incBucketed` read
  `otel_metrics_sum_hourly` (an `AggregatingMergeTree` fed by a materialized view), keeping
  `max(Value)`/`sum(Value)` per (SeriesKey, SessionId, hour) so the same diff math still works
  at ~86x fewer rows. Only the chart drag-zoom's minute-grain buckets fall back to scanning
  `otel_metrics_sum` directly (`incBucketedRaw`), since minute buckets can't be built from an
  hourly rollup.
- **True series key is `cityHash64(toString(Attributes))`, not promoted columns** -- promoted
  columns (Model/TokenType/Decision/SkillName) alone collapse distinct OTel series and lose
  monotonicity; see `seriesKey` in `queries.js`.
- **bedrock/enterprise grouping is a session-level heuristic**, not a stored flag -- inferred
  from `Model` (Bedrock-style names) and `Attributes['organization.id']`, because Workshop
  Studio participants choose their auth path at runtime.
- **hot/cold TTL** caps ClickHouse disk growth automatically (45d/90d for logs, 90d/180d for
  metrics) instead of manual retention management.

### 4. Code Pointers
- `dashboard/server/queries.js:212` -- `incFlat()` (cumulative diff, session-flat)
- `dashboard/server/queries.js:301` -- `incBucketed()` (cumulative diff, time-bucketed)
- `dashboard/server/grouping.js:27` -- `GROUP_CTE` (bedrock/enterprise session classification)
- `dashboard/server/pricing.js` -- `normalizeModelId()`, per-token pricing table
- `clickhouse-schema.sql` -- promoted/materialized column definitions

### 5. Cross-references
- Related modules: [dashboard/server/CLAUDE.md](../../dashboard/server/CLAUDE.md)
- Related ADRs: (none yet -- the cumulative-diff design predates this doc set)
- Related runbooks: (none yet)

<a id="korean"></a>
## 한국어

### 1. 개요
모든 텔레메트리는 hot/cold 스토리지 정책(로컬 EBS -> 45~90일 후 S3, 90~180일 후 삭제)이
적용된 ClickHouse 테이블 2개(`otel_metrics_sum`, `otel_logs`)에 쌓입니다. 값은 델타가 아니라
누적(cumulative) OTel 카운터라서 쿼리 레이어 복잡도의 대부분이 여기서 나옵니다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| ClickHouse 스키마(참조용) | `clickhouse-schema.sql` | 승격/materialized 컬럼을 포함한 `otel_metrics_sum`/`otel_logs` DDL |
| ClickHouse 스키마(레플리카) | `infra/files/clickhouse-schema-replicated.sql` | EKS 클러스터의 ClickHouse operator가 적용하는 동일 스키마 |
| 시간별 rollup | `otel_metrics_sum_hourly`(`clickhouse-schema.sql` 안), `otel_metrics_sum` 위 materialized view가 채움 | 원본보다 행 수 ~86x 적음 — 대시보드 쿼리는 `otel_metrics_sum`을 직접 읽지 않고 이 테이블을 읽음(원본은 10초 누적 재-export로 하루 ~300만 행 증가) |
| 그룹 판별 로직 | `dashboard/server/grouping.js` | 세션 단위 bedrock/enterprise 판별(`GROUP_CTE`), rollup의 `has_org` 컬럼을 읽음 |
| 단가표 | `dashboard/server/pricing.js` | 모델별 토큰 단가, 모델명 정규화 |
| 데모 시드 데이터 | `dashboard/seed/*.sql` | ClickHouse에 적재하는 워크샵 데모 데이터 |

### 3. 주요 결정
- **누적 카운터를 쿼리 시점에 diff** -- Claude Code는 ~30초마다 세션 누적값을 export합니다.
  원본 `Value`를 그대로 합산하면 자릿수 단위로 과대집계됩니다. `queries.js`의
  `incFlat`/`incBucketed`가 세션 경계 기준으로 diff합니다(`LOOKBACK_DAYS`가 baseline 조회
  확장 트레이드오프).
- **쿼리 레이어는 원본이 아니라 시간별 rollup을 읽음** -- `incFlat`/`incBucketed`는
  `otel_metrics_sum_hourly`(materialized view가 채우는 `AggregatingMergeTree`)를 읽어
  (SeriesKey, SessionId, hour)당 `max(Value)`/`sum(Value)`만 보존, 같은 diff 수식이 ~86x
  적은 행으로 동작. 차트 드래그 줌의 분 단위 버킷만 원본 `otel_metrics_sum`을 직접 스캔
  (`incBucketedRaw`) — 분 버킷은 시간별 rollup으로 만들 수 없어서.
- **진짜 시리즈 키는 `cityHash64(toString(Attributes))`**, 승격 컬럼만으로는 부족 -- 승격
  컬럼(Model/TokenType/Decision/SkillName)만으로 GROUP BY하면 서로 다른 OTel 시리즈가 섞여
  단조성이 깨집니다(`queries.js`의 `seriesKey`).
- **bedrock/enterprise 그룹은 저장된 플래그가 아니라 세션 단위 휴리스틱** -- `Model`(Bedrock
  스타일 이름)과 `Attributes['organization.id']`로 추론합니다. Workshop Studio 참가자가
  런타임에 인증 방식을 고르기 때문입니다.
- **hot/cold TTL**로 ClickHouse 디스크 증가를 자동으로 캡(logs 45일/90일, metrics
  90일/180일) -- 수동 보존 관리 불필요.

### 4. 코드 포인터
- `dashboard/server/queries.js:212` -- `incFlat()`(누적 diff, 세션 단위)
- `dashboard/server/queries.js:301` -- `incBucketed()`(누적 diff, 시간 버킷)
- `dashboard/server/grouping.js:27` -- `GROUP_CTE`(bedrock/enterprise 세션 판별)
- `dashboard/server/pricing.js` -- `normalizeModelId()`, 토큰별 단가표
- `clickhouse-schema.sql` -- 승격/materialized 컬럼 정의

### 5. 상호 참조
- 관련 모듈: [dashboard/server/CLAUDE.md](../../dashboard/server/CLAUDE.md)
- 관련 ADR: (아직 없음 -- 누적 diff 설계가 이 문서 세트보다 먼저 있었음)
- 관련 런북: (아직 없음)
