# API / API 구성 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
A single Express app (`dashboard/server/index.js`) exposes ~35 read-only `GET /api/*`
endpoints backed by ClickHouse queries, plus a Bedrock-backed `/api/chat` SQL-assistant
endpoint. All routes share one `from`/`to`/filter-parsing wrapper.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| Route table + wrapper | `dashboard/server/index.js` | `route()` helper (parses range/query, calls handler, catches errors) |
| Query layer | `dashboard/server/queries.js` | All ClickHouse SQL, one exported function per endpoint |
| Chat/SQL-assistant | `dashboard/server/chat.js` | Bedrock ConverseStream + sandboxed `run_sql` tool loop |
| ClickHouse client | `dashboard/server/clickhouse.js` | `query()` (normal) / `queryReadonly()` (readonly=1, used by chat) |
| Pricing/derived metrics | `dashboard/server/pricing.js`, `productivity.js`, `costEfficiency.js` | Pure functions applied to query results |

### 3. Key Decisions
- **Read-only by design** -- every endpoint is a `GET`; the only write-adjacent surface is
  `/api/chat`, which is restricted to `SELECT`/`WITH` via `sanitizeSql()` and runs through
  `queryReadonly()` (ClickHouse `readonly=1` setting) as defense in depth.
- **Global filters (group/user/model) are applied per-query via `filterCond()`**, not a
  shared middleware -- because which columns exist to filter on differs per query (e.g.
  `otel_logs` has no `Model` column, so model filtering there goes through a session
  semi-join against `otel_metrics_sum`).
- **No auth on individual routes** -- auth is a single global Basic Auth middleware
  (`BASIC_AUTH_USER`/`PASSWORD` env vars), applied before all routes except `/healthz`.
- **2026-08-11 telemetry-sync endpoints don't extend `incFlat`/`incBucketed`** -- the two new
  version-cohort endpoints (`/api/integrity/version-cohort-*`) need `AppVersion` as an extra
  grouping dimension on a cumulative-counter diff, but that shared diff engine already has
  ~40 consumers and a long history of subtle boundary bugs (see `dashboard/server/CLAUDE.md`).
  Rather than widen its `GROUP BY`, these two endpoints duplicate the same session-boundary
  diff formula in a small self-contained query. Trade-off: no rollup optimization (always
  scans `otel_metrics_sum` directly), acceptable because these are integrity-check endpoints,
  not primary dashboard KPIs.
- **traces-beta endpoints return `{unsupported, rows}`, not a plain array** -- `/api/productivity/
  permission-wait` and `/api/productivity/ttft` read `otel_traces`, which is new (2026-08-11) and
  may be empty (beta env not rolled out, or the client is below the version that emits a given
  span type). Returning `[]` would be indistinguishable from "confirmed zero" on a KPI card,
  so an empty result comes back as `{unsupported: true, minVersion, rows: []}` instead.

### 4. Code Pointers
- `dashboard/server/index.js:129` -- `route()` wrapper (from/to parsing, error handling)
- `dashboard/server/index.js:24` -- global Basic Auth middleware (skips `/healthz`)
- `dashboard/server/queries.js:63` -- `filterCond()` (group/user/model filter builder)
- `dashboard/server/chat.js:84` -- `sanitizeSql()` (SELECT/WITH-only guard)
- `dashboard/server/chat.js:141` -- `handleChat()` (SSE stream, tool-use loop, `MAX_HOPS` cap)

### 5. Cross-references
- Related modules: [dashboard/server/CLAUDE.md](../../dashboard/server/CLAUDE.md)
- Related ADRs: (none yet)
- Related runbooks: (none yet)

<a id="korean"></a>
## 한국어

### 1. 개요
단일 Express 앱(`dashboard/server/index.js`)이 ClickHouse 쿼리 기반의 읽기 전용
`GET /api/*` 엔드포인트 35개 가량과, Bedrock 기반 `/api/chat` SQL 어시스턴트 엔드포인트를
제공합니다. 모든 라우트가 하나의 `from`/`to`/필터 파싱 래퍼를 공유합니다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| 라우트 테이블 + 래퍼 | `dashboard/server/index.js` | `route()` 헬퍼(범위/쿼리 파싱, 핸들러 호출, 에러 처리) |
| 쿼리 레이어 | `dashboard/server/queries.js` | 엔드포인트당 함수 하나씩, 모든 ClickHouse SQL |
| 채팅/SQL 어시스턴트 | `dashboard/server/chat.js` | Bedrock ConverseStream + 샌드박스된 `run_sql` 툴콜 루프 |
| ClickHouse 클라이언트 | `dashboard/server/clickhouse.js` | `query()`(일반) / `queryReadonly()`(readonly=1, chat에서 사용) |
| 단가/파생 지표 | `dashboard/server/pricing.js`, `productivity.js`, `costEfficiency.js` | 쿼리 결과에 적용하는 순수 함수 |

### 3. 주요 결정
- **설계상 읽기 전용** -- 모든 엔드포인트가 `GET`. 쓰기에 가까운 유일한 표면은 `/api/chat`인데
  `sanitizeSql()`로 `SELECT`/`WITH`만 허용하고, 방어 심층화로 `queryReadonly()`(ClickHouse
  `readonly=1` 설정)를 통과시킵니다.
- **전역 필터(group/user/model)는 공유 미들웨어가 아니라 쿼리별 `filterCond()`로 적용** --
  쿼리마다 필터링 가능한 컬럼이 다르기 때문입니다(예: `otel_logs`엔 `Model` 컬럼이 없어
  모델 필터링이 `otel_metrics_sum`과의 세션 세미조인을 거칩니다).
- **개별 라우트에 인증 없음** -- 인증은 단일 전역 Basic Auth 미들웨어(`BASIC_AUTH_USER`/
  `PASSWORD` 환경변수)이며 `/healthz`를 제외한 모든 라우트 앞에 적용됩니다.
- **2026-08-11 텔레메트리 동기화 엔드포인트는 `incFlat`/`incBucketed`를 확장하지 않음** --
  버전 코호트 엔드포인트 2개(`/api/integrity/version-cohort-*`)는 누적 카운터 diff에
  `AppVersion`이라는 새 그레인을 얹어야 하는데, 이 공유 diff 엔진은 이미 40여 개 소비자가
  쓰고 있고 경계 버그 이력이 길다(`dashboard/server/CLAUDE.md` 참고). `GROUP BY`를 넓히는
  대신, 이 두 엔드포인트만 같은 세션-경계 diff 공식을 로컬로 복제한다. 트레이드오프: rollup
  최적화 없이 항상 `otel_metrics_sum` 원본을 스캔 — 검증용 엔드포인트라 KPI 카드만큼 자주
  조회되지 않는다는 전제로 감내.
- **traces beta 엔드포인트는 배열이 아니라 `{unsupported, rows}`를 반환** -- `/api/
  productivity/permission-wait`와 `/api/productivity/ttft`는 신설된(2026-08-11) `otel_traces`를
  읽는데, beta env 미배포나 그 스팬을 아직 안 내는 클라이언트 버전 때문에 비어 있을 수 있다.
  `[]`는 KPI 카드에서 "확인된 0"과 구분이 안 되므로, 빈 결과는 대신
  `{unsupported: true, minVersion, rows: []}`로 내려간다.

### 4. 코드 포인터
- `dashboard/server/index.js:129` -- `route()` 래퍼(from/to 파싱, 에러 처리)
- `dashboard/server/index.js:24` -- 전역 Basic Auth 미들웨어(`/healthz` 제외)
- `dashboard/server/queries.js:63` -- `filterCond()`(group/user/model 필터 빌더)
- `dashboard/server/chat.js:84` -- `sanitizeSql()`(SELECT/WITH만 허용하는 가드)
- `dashboard/server/chat.js:141` -- `handleChat()`(SSE 스트림, 툴콜 루프, `MAX_HOPS` 상한)

### 5. 상호 참조
- 관련 모듈: [dashboard/server/CLAUDE.md](../../dashboard/server/CLAUDE.md)
- 관련 ADR: (아직 없음)
- 관련 런북: (아직 없음)
