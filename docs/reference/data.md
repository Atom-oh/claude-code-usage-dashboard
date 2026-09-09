# Data / 데이터 구성 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
Telemetry lands in three ClickHouse tables: `otel_metrics_sum`, `otel_logs`, and (since
2026-08-11, beta) `otel_traces` — with a hot/cold storage policy (local EBS -> S3 after
45-90 days, dropped after 90-180 days). Metric values are cumulative OTel counters, not
deltas, which drives most of the query-layer complexity.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| ClickHouse schema (reference) | `clickhouse-schema.sql` | `otel_metrics_sum` / `otel_logs` / `otel_traces` DDL with promoted/materialized columns |
| ClickHouse schema (replicated) | `infra/files/clickhouse-schema-replicated.sql` | Same schema, applied by the ClickHouse operator on the EKS cluster |
| Migration (additive) | `clickhouse-migration-002.sql` | `ADD COLUMN IF NOT EXISTS` for the 2026-08-11 attribute/event/traces sync, run directly against the live cluster (no table drops) |
| Migration (segment-aware SeriesKey cutover) | `clickhouse-migration-003.sql` | Segment-aware `SeriesKey` cutover (folds `StartTimeUnix` in) + hourly-rollup rebuild via shadow table; run by an operator against the live cluster following `docs/runbooks/rollup-rebuild-segment-key.md` (not applied by Terraform) |
| Hourly rollup | `otel_metrics_sum_hourly` (in `clickhouse-schema.sql`), fed by a materialized view on `otel_metrics_sum` | ~86x fewer rows than the raw table; dashboard queries read this instead of `otel_metrics_sum` directly (raw grows ~3M rows/day from 10s cumulative re-exports) |
| Grouping heuristic | `dashboard/server/grouping.js` | Session-scoped bedrock/enterprise classification (`GROUP_CTE`), reads the rollup's `has_org` column |
| Pricing table | `dashboard/server/pricing.js` | Per-model token pricing, model name normalization |
| Demo seed data | `dashboard/seed/*.sql` | Workshop demo data loaded into ClickHouse |

### 1b. 2026-08-11 telemetry spec sync
Cross-checked the original attribute/event list against live telemetry (345M rows) rather than
trusting `code.claude.com/docs/en/monitoring-usage.md` alone — that doc turned out to be
missing several events that are actually emitted (`skill_activated`, `compaction`,
`api_retries_exhausted`, `hook_registered`, `hook_execution_complete`) and one non-obvious
existing one (`subagent_completed`). New promoted columns follow the measured attribute keys,
not the doc's.
- `otel_metrics_sum` gained `Effort`, `PluginName`, `MarketplaceName`, `McpServerName`,
  `McpToolName`, `Speed` (0 rows in this fleet — never observed fast mode), `StartType`
  (`agents_view` must be excluded from session-count panels — it's a `claude agents`
  dashboard-process run, not a conversation), `Source`, `EndUserId`, `AppVersion`.
- `otel_logs` gained columns for the 5 new events plus `PromptId`, `EndUserId`, `AppVersion`.
- `EndUserId`/`AppVersion` are promoted from `ResourceAttributes`, not `Attributes` --
  specifically so they survive a future `OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES=false` flip
  (that flag only drops *custom* `OTEL_RESOURCE_ATTRIBUTES` keys from metric datapoints; the
  standard `service.version`/custom `enduser.id` resource attributes stay resource-level).
- `otel_traces` (new table, beta) mirrors the ClickHouse OTel exporter's standard trace schema
  plus promoted `SpanType`, `DurationMs`, `TtftMs`, `AgentId`, `ParentAgentId`, `Decision`. It
  did not exist on the live cluster before this migration (`create_schema: false` on the
  exporter, so the DDL has to run first). `claude_code.tool.blocked_on_user`/`tool.execution`
  spans only exist on Claude Code ≥2.1.214 — this fleet has 20 versions in play
  (2.1.202-2.1.226 measured 2026-08-11), so those two panels will show real gaps, not zeros.
- Fixed a live bug found during the sync: `otel_logs.EventName` is stored **bare**
  (`tool_result`), not prefixed (`claude_code.tool_result`) — the MCP/tool-usage panel had been
  returning zero rows because of the mismatched prefix.
- Bedrock sessions have no Claude account (`organization.id`/`user.account_uuid`/`user.email`
  are all empty — confirmed on 75.7M measured rows, not assumed) and no server-provided identity
  beyond `session.id`. `user-data.sh` now injects `enduser.id` from an EC2 instance tag (IMDSv2)
  into `OTEL_RESOURCE_ATTRIBUTES`; per-user queries fall back with
  `coalesce(nullIf(UserEmail,''), nullIf(EndUserId,''))`. This fallback is applied in
  `grafana-ab-queries.sql` and the new `dashboard/server/queries.js` functions added in this
  sync, but **not** retrofitted into the ~90 pre-existing `UserEmail` references (`userLeaderboard`
  and friends) — see the `incFlat`/`incBucketed` note below for why.

### 1c. 2026-09-09 project tag + entrypoint
- `clickhouse-migration-005.sql` adds two promoted columns to all three tables: `ProjectName`
  (`ResourceAttributes['project.name']`) and `Entrypoint` (`app.entrypoint`, read from
  `Attributes` on `otel_metrics_sum`, `LogAttributes` on `otel_logs`, `SpanAttributes` on
  `otel_traces`). The hourly rollup is untouched — project is not an `incFlat` dimension.
- 005 deliberately runs no `MATERIALIZE COLUMN`, unlike 002/003: both columns are a single
  map-key lookup, and a part that predates the `ADD COLUMN` still evaluates the default
  expression at read time (measured 2026-09-09 on `clickhouse/clickhouse-server:24.8.14.39`:
  zero mismatches against the map lookup across all pre-`ALTER` parts).
- Four new endpoints: `/api/usage/projects` (`projectBreakdown` — returns `[]` unless
  `GET /api/config` reports `schema.projectColumns === true`), `/api/usage/permission-modes`
  (`permissionModeChanges`), `/api/usage/decision-sources` (`toolDecisionSources`), and
  `/api/usage/entrypoints` (`entrypointBreakdown`). The project grain comes from the raw
  table via a self-contained session-boundary local diff subquery, not the rollup (ADR-001 —
  the rollup carries no `ProjectName`).
- `project.name` is never emitted by Claude Code itself — an operator has to inject it via
  `OTEL_RESOURCE_ATTRIBUTES`, and on this fleet `managed-settings.json` owns that variable,
  so per-repo `.claude/settings.json` is inert until the operator picks an ownership model —
  see README → Telemetry Ingestion → "Project tag (project.name)".

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
- **True series key is `cityHash64(toString(Attributes))` folded with `StartTimeUnix`, not
  promoted columns alone** -- promoted columns (Model/TokenType/Decision/SkillName) alone
  collapse distinct OTel series and lose monotonicity, and since migration-003 the raw
  `cityHash64(toString(Attributes))` alone is also insufficient: a same-`session.id` process
  restart (e.g. `--resume`) resets its counters, and without the `StartTimeUnix` component
  folded in, that reset is invisible to the diff logic. `claude_code.session.count` is excepted
  (it keeps the label-only key) because the dashboard's session unit is `session.id`, not the
  process. See `seriesKey` in `queries.js` and
  [ADR-003](../decisions/ADR-003-fold-start-time-into-series-key.md).
- **bedrock/enterprise grouping is a session-level heuristic**, not a stored flag -- inferred
  from `Model` (Bedrock-style names) and `Attributes['organization.id']`, because Workshop
  Studio participants choose their auth path at runtime.
- **hot/cold TTL** caps ClickHouse disk growth automatically (45d/90d for logs, 90d/180d for
  metrics) instead of manual retention management.
- **New dimensions (`AppVersion`, `EndUserId`) don't widen `incFlat`/`incBucketed`'s shared
  `GROUP BY`** (2026-08-11) -- that diff engine has ~40 consumers and a history of subtle
  boundary bugs (first-bucket raw stitch, hour-alignment skew); the two version-cohort
  endpoints that need `AppVersion` duplicate the diff formula locally instead. See ADR-001.

### 4. Code Pointers
- `dashboard/server/queries.js:212` -- `incFlat()` (cumulative diff, session-flat)
- `dashboard/server/queries.js:301` -- `incBucketed()` (cumulative diff, time-bucketed)
- `dashboard/server/queries.js` -- `versionCohortSessions()`/`versionCohortCost()` (2026-08-11,
  self-contained diff, does not go through `incFlat`)
- `dashboard/server/grouping.js:27` -- `GROUP_CTE` (bedrock/enterprise session classification)
- `dashboard/server/pricing.js` -- `normalizeModelId()`, per-token pricing table
- `clickhouse-schema.sql` -- promoted/materialized column definitions
- `clickhouse-migration-002.sql` -- 2026-08-11 additive migration (run against the live cluster)
- `clickhouse-migration-003.sql` -- segment-aware `SeriesKey` cutover + hourly-rollup rebuild (run against the live cluster)

### 5. Cross-references
- Related modules: [dashboard/server/CLAUDE.md](../../dashboard/server/CLAUDE.md)
- Related ADRs: [ADR-001](../decisions/ADR-001-local-diff-over-shared-incflat-extension.md),
  [ADR-002](../decisions/ADR-002-bedrock-identity-fallback.md)
- Related runbooks: (none yet)

<a id="korean"></a>
## 한국어

### 1. 개요
텔레메트리는 ClickHouse 테이블 3개(`otel_metrics_sum`, `otel_logs`, 그리고 2026-08-11부터
beta로 추가된 `otel_traces`)에 쌓이며, hot/cold 스토리지 정책(로컬 EBS -> 45~90일 후 S3,
90~180일 후 삭제)이 적용됩니다. metric 값은 델타가 아니라 누적(cumulative) OTel 카운터라서
쿼리 레이어 복잡도의 대부분이 여기서 나옵니다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| ClickHouse 스키마(참조용) | `clickhouse-schema.sql` | 승격/materialized 컬럼을 포함한 `otel_metrics_sum`/`otel_logs`/`otel_traces` DDL |
| ClickHouse 스키마(레플리카) | `infra/files/clickhouse-schema-replicated.sql` | EKS 클러스터의 ClickHouse operator가 적용하는 동일 스키마 |
| 마이그레이션(추가형) | `clickhouse-migration-002.sql` | 2026-08-11 속성/이벤트/traces 동기화용 `ADD COLUMN IF NOT EXISTS` — 라이브 클러스터에 직접 실행(테이블 DROP 없음) |
| 마이그레이션(세그먼트 인식 SeriesKey 컷오버) | `clickhouse-migration-003.sql` | 세그먼트 인식 `SeriesKey` 컷오버(`StartTimeUnix` 접어 넣기) + shadow 테이블을 통한 시간별 rollup 재구축 — `docs/runbooks/rollup-rebuild-segment-key.md`를 따라 오퍼레이터가 라이브 클러스터에 직접 실행(Terraform 미적용) |
| 시간별 rollup | `otel_metrics_sum_hourly`(`clickhouse-schema.sql` 안), `otel_metrics_sum` 위 materialized view가 채움 | 원본보다 행 수 ~86x 적음 — 대시보드 쿼리는 `otel_metrics_sum`을 직접 읽지 않고 이 테이블을 읽음(원본은 10초 누적 재-export로 하루 ~300만 행 증가) |
| 그룹 판별 로직 | `dashboard/server/grouping.js` | 세션 단위 bedrock/enterprise 판별(`GROUP_CTE`), rollup의 `has_org` 컬럼을 읽음 |
| 단가표 | `dashboard/server/pricing.js` | 모델별 토큰 단가, 모델명 정규화 |
| 데모 시드 데이터 | `dashboard/seed/*.sql` | ClickHouse에 적재하는 워크샵 데모 데이터 |

### 1b. 2026-08-11 텔레메트리 스펙 동기화
원래 속성/이벤트 목록을 문서(`code.claude.com/docs/en/monitoring-usage.md`)만 믿지 않고
라이브 텔레메트리(345M행)로 교차검증했다 — 그 문서는 실제로 emit되는 이벤트 몇 개
(`skill_activated`, `compaction`, `api_retries_exhausted`, `hook_registered`,
`hook_execution_complete`)와 눈에 안 띄는 기존 이벤트 하나(`subagent_completed`)를 빠뜨리고
있었다. 신규 승격 컬럼은 문서가 아니라 실측된 attribute 키를 기준으로 만들었다.
- `otel_metrics_sum`에 `Effort`, `PluginName`, `MarketplaceName`, `McpServerName`,
  `McpToolName`, `Speed`(이 플릿에서 0행 — fast 모드를 쓴 적이 없음), `StartType`
  (`agents_view`는 대화가 아니라 `claude agents` 대시보드 프로세스 실행이라 세션 카운트
  패널에서 반드시 제외), `Source`, `EndUserId`, `AppVersion` 추가.
- `otel_logs`에 신규 이벤트 5종용 컬럼 + `PromptId`, `EndUserId`, `AppVersion` 추가.
- `EndUserId`/`AppVersion`은 `Attributes`가 아니라 `ResourceAttributes`에서 승격 — 향후
  `OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES=false` 전환에도 살아남도록 의도한 선택(그 플래그는
  metric datapoint에서 *커스텀* `OTEL_RESOURCE_ATTRIBUTES` 키만 제거하고, 표준
  `service.version`/커스텀 `enduser.id` 같은 리소스 속성 자체는 그대로 남는다).
- `otel_traces`(신규 테이블, beta)는 ClickHouse OTel exporter의 표준 trace 스키마 + 승격
  `SpanType`, `DurationMs`, `TtftMs`, `AgentId`, `ParentAgentId`, `Decision`. 이 마이그레이션
  전에는 라이브 클러스터에 아예 없었다(exporter가 `create_schema: false`라 DDL을 먼저
  실행해야 함). `claude_code.tool.blocked_on_user`/`tool.execution` 스팬은 Claude Code
  v2.1.214 이상에서만 존재하는데, 이 플릿은 20개 버전(2.1.202~2.1.226, 2026-08-11 실측)이
  혼재해 있어 그 두 패널은 실제 공백을 보일 것이다(0이 아니라).
- 동기화 도중 실제 버그 발견·수정: `otel_logs.EventName`은 프리픽스 없이 **bare**로 저장됨
  (`tool_result`, `claude_code.tool_result`가 아님) — MCP/tool 사용량 패널이 프리픽스
  불일치로 항상 0행을 반환하고 있었다.
- Bedrock 세션은 Claude 계정이 없고(`organization.id`/`user.account_uuid`/`user.email`이
  전부 비어 있음 — 가정이 아니라 75.7M행 실측으로 확인) `session.id` 외엔 서버 제공
  identity가 없다. `user-data.sh`가 이제 EC2 인스턴스 태그(IMDSv2)에서 읽은 `enduser.id`를
  `OTEL_RESOURCE_ATTRIBUTES`에 주입하고, 유저별 쿼리는
  `coalesce(nullIf(UserEmail,''), nullIf(EndUserId,''))`로 폴백한다. 이 폴백은
  `grafana-ab-queries.sql`과 이번 동기화에서 추가한 `dashboard/server/queries.js` 신규
  함수에는 적용했지만, 기존 `UserEmail` 참조 ~90곳(`userLeaderboard` 등)에는 **적용하지
  않았다** — 이유는 아래 `incFlat`/`incBucketed` 항목 참고.

### 1c. 2026-09-09 프로젝트 태그 + 진입점
- `clickhouse-migration-005.sql`이 세 테이블 전부에 승격 컬럼 두 개를 추가한다: `ProjectName`
  (`ResourceAttributes['project.name']`)과 `Entrypoint`(`app.entrypoint` — `otel_metrics_sum`
  은 `Attributes`, `otel_logs`는 `LogAttributes`, `otel_traces`는 `SpanAttributes`에서 읽음).
  시간별 롤업은 건드리지 않는다 — project는 `incFlat` 차원이 아니다.
- 005는 002/003과 달리 `MATERIALIZE COLUMN`을 일부러 돌리지 않는다: 두 컬럼 모두 맵 키 한 번
  조회라, `ADD COLUMN` 이전에 만들어진 파트에서도 읽기 시점에 default 표현식이 평가되어
  정확한 값이 나온다(실측 2026-09-09, `clickhouse/clickhouse-server:24.8.14.39`: pre-`ALTER`
  파트 전수 비교에서 맵 조회 값과 mismatch 0).
- 신규 엔드포인트 4개: `/api/usage/projects`(`projectBreakdown` — `GET /api/config`의
  `schema.projectColumns === true`가 아니면 `[]` 반환), `/api/usage/permission-modes`
  (`permissionModeChanges`), `/api/usage/decision-sources`(`toolDecisionSources`),
  `/api/usage/entrypoints`(`entrypointBreakdown`). 프로젝트 그레인은 롤업이 아니라 원본
  테이블 + 자기완결 세션-경계 로컬 diff 서브쿼리에서 나온다(ADR-001 — 롤업에는
  `ProjectName`이 없다).
- `project.name`은 Claude Code가 스스로 내보내지 않는다 — 운영자가 `OTEL_RESOURCE_ATTRIBUTES`
  로 심어야 하고, 이 플릿에서는 `managed-settings.json`이 그 변수를 소유하므로 저장소별
  `.claude/settings.json`은 운영자가 소유권 방식을 정하기 전까지 무효다 — README →
  Telemetry Ingestion → "Project tag (project.name)" 참고.

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
- **진짜 시리즈 키는 `cityHash64(toString(Attributes))`에 `StartTimeUnix`를 접어 넣은 것**,
  승격 컬럼만으로는 부족 -- 승격 컬럼(Model/TokenType/Decision/SkillName)만으로 GROUP BY하면
  서로 다른 OTel 시리즈가 섞여 단조성이 깨지고, migration-003 이후로는
  `cityHash64(toString(Attributes))` 단독으로도 부족하다: 같은 `session.id`를 유지하는
  프로세스 재시작(`--resume` 등)은 카운터를 리셋하는데, `StartTimeUnix` 컴포넌트를 접어
  넣지 않으면 diff 로직에 이 리셋이 보이지 않는다. `claude_code.session.count`는 예외라
  라벨 전용 키를 유지한다 — 대시보드의 세션 단위가 프로세스가 아니라 `session.id`이기
  때문이다. `queries.js`의 `seriesKey`와
  [ADR-003](../decisions/ADR-003-fold-start-time-into-series-key.md) 참고.
- **bedrock/enterprise 그룹은 저장된 플래그가 아니라 세션 단위 휴리스틱** -- `Model`(Bedrock
  스타일 이름)과 `Attributes['organization.id']`로 추론합니다. Workshop Studio 참가자가
  런타임에 인증 방식을 고르기 때문입니다.
- **hot/cold TTL**로 ClickHouse 디스크 증가를 자동으로 캡(logs 45일/90일, metrics
  90일/180일) -- 수동 보존 관리 불필요.
- **신규 차원(`AppVersion`, `EndUserId`)은 `incFlat`/`incBucketed`의 공유 `GROUP BY`를
  넓히지 않는다**(2026-08-11) -- 이 diff 엔진은 소비자 ~40개와 미묘한 경계 버그 이력(첫
  버킷 raw stitch, hour 정렬 스큐)을 갖고 있어, `AppVersion`이 필요한 두 버전 코호트
  엔드포인트는 diff 공식을 로컬로 복제한다. ADR-001 참고.

### 4. 코드 포인터
- `dashboard/server/queries.js:212` -- `incFlat()`(누적 diff, 세션 단위)
- `dashboard/server/queries.js:301` -- `incBucketed()`(누적 diff, 시간 버킷)
- `dashboard/server/queries.js` -- `versionCohortSessions()`/`versionCohortCost()`
  (2026-08-11, `incFlat`을 거치지 않는 자기완결형 diff)
- `dashboard/server/grouping.js:27` -- `GROUP_CTE`(bedrock/enterprise 세션 판별)
- `dashboard/server/pricing.js` -- `normalizeModelId()`, 토큰별 단가표
- `clickhouse-schema.sql` -- 승격/materialized 컬럼 정의
- `clickhouse-migration-002.sql` -- 2026-08-11 추가형 마이그레이션(라이브 클러스터에 실행)
- `clickhouse-migration-003.sql` -- 세그먼트 인식 `SeriesKey` 컷오버 + 시간별 rollup 재구축(라이브 클러스터에 실행)

### 5. 상호 참조
- 관련 모듈: [dashboard/server/CLAUDE.md](../../dashboard/server/CLAUDE.md)
- 관련 ADR: [ADR-001](../decisions/ADR-001-local-diff-over-shared-incflat-extension.md),
  [ADR-002](../decisions/ADR-002-bedrock-identity-fallback.md)
- 관련 런북: (아직 없음)
