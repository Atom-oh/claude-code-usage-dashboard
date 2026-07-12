# API / API 구성 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
A single Express app (`dashboard/server/index.js`) exposes ~25 read-only `GET /api/*`
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
`GET /api/*` 엔드포인트 25개 가량과, Bedrock 기반 `/api/chat` SQL 어시스턴트 엔드포인트를
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
