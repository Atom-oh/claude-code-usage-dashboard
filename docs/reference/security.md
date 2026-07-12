# Security / 보안 구현 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
The dashboard has a small, deliberately conservative security surface: one global Basic Auth
gate, a read-only API by construction, and a sandboxed SQL tool for the Bedrock chat feature.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| Basic Auth middleware | `dashboard/server/index.js` | Global gate, active only when `BASIC_AUTH_USER`/`PASSWORD` are set; `/healthz` exempted |
| SQL sanitizer | `dashboard/server/chat.js` | `sanitizeSql()` -- rejects non-SELECT/WITH, multi-statement, and DDL/DML keywords |
| Readonly ClickHouse client | `dashboard/server/clickhouse.js` | `queryReadonly()` -- `readonly=1` ClickHouse setting, defense-in-depth behind the sanitizer |
| Secrets delivery | `infra/dashboard.tf`, k8s Secret `clickhouse-reader` | ClickHouse credentials injected via k8s Secret, never committed |
| Terraform secrets | `infra/secrets.auto.tfvars` (gitignored) | Apply-time secrets, not committed |

### 3. Key Decisions
- **Two independent layers guard `/api/chat`'s SQL execution**: a string-level sanitizer
  (`sanitizeSql()`) rejecting anything but a single `SELECT`/`WITH` statement, plus ClickHouse's
  own `readonly=1` session setting as a backstop if the sanitizer is ever bypassed.
- **Auth is one global middleware, not per-route** -- simpler to audit; every new route
  automatically inherits the gate, including the drill-down/chat endpoints added later.
- **No secrets in git** -- ClickHouse password lives in a k8s Secret (`clickhouse-reader`),
  fetched via `kubectl get secret ... -o jsonpath` for local debugging, never written to disk
  in the repo.

### 4. Code Pointers
- `dashboard/server/index.js:24` -- Basic Auth middleware registration
- `dashboard/server/chat.js:84` -- `sanitizeSql()`
- `dashboard/server/clickhouse.js` -- `queryReadonly()` export
- `infra/dashboard.tf` -- env injection from k8s Secret

### 5. Cross-references
- Related modules: [dashboard/server/CLAUDE.md](../../dashboard/server/CLAUDE.md)
- Related ADRs: (none yet)
- Related runbooks: (none yet)

<a id="korean"></a>
## 한국어

### 1. 개요
대시보드의 보안 표면은 작고 의도적으로 보수적입니다: 전역 Basic Auth 게이트 하나, 구조적으로
읽기 전용인 API, 그리고 Bedrock 채팅 기능을 위한 샌드박스된 SQL 도구.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| Basic Auth 미들웨어 | `dashboard/server/index.js` | 전역 게이트, `BASIC_AUTH_USER`/`PASSWORD` 설정 시에만 활성화, `/healthz`는 예외 |
| SQL sanitizer | `dashboard/server/chat.js` | `sanitizeSql()` -- SELECT/WITH 외, 다중 문장, DDL/DML 키워드 거부 |
| Readonly ClickHouse 클라이언트 | `dashboard/server/clickhouse.js` | `queryReadonly()` -- ClickHouse `readonly=1` 설정, sanitizer 뒤의 방어 심층화 |
| 시크릿 전달 | `infra/dashboard.tf`, k8s Secret `clickhouse-reader` | ClickHouse 자격증명을 k8s Secret으로 주입, 커밋되지 않음 |
| Terraform 시크릿 | `infra/secrets.auto.tfvars`(gitignore됨) | apply 시점 시크릿, 커밋되지 않음 |

### 3. 주요 결정
- **`/api/chat`의 SQL 실행을 독립된 2개 레이어로 보호**: 단일 `SELECT`/`WITH` 문 외 전부
  거부하는 문자열 레벨 sanitizer(`sanitizeSql()`), 그리고 sanitizer가 우회되더라도 막아주는
  ClickHouse 자체의 `readonly=1` 세션 설정.
- **인증은 라우트별이 아니라 전역 미들웨어 하나** -- 감사하기 더 쉽고, 나중에 추가된
  드릴다운/채팅 엔드포인트도 자동으로 게이트를 물려받습니다.
- **git에 시크릿 없음** -- ClickHouse 비밀번호는 k8s Secret(`clickhouse-reader`)에 있고,
  로컬 디버깅 시 `kubectl get secret ... -o jsonpath`로 가져오되 저장소에 파일로 남기지
  않습니다.

### 4. 코드 포인터
- `dashboard/server/index.js:24` -- Basic Auth 미들웨어 등록
- `dashboard/server/chat.js:84` -- `sanitizeSql()`
- `dashboard/server/clickhouse.js` -- `queryReadonly()` export
- `infra/dashboard.tf` -- k8s Secret에서 env 주입

### 5. 상호 참조
- 관련 모듈: [dashboard/server/CLAUDE.md](../../dashboard/server/CLAUDE.md)
- 관련 ADR: (아직 없음)
- 관련 런북: (아직 없음)
