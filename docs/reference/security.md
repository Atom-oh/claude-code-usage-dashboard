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
- **PII retention is enforced by table TTL, and every store that holds `UserEmail` must carry
  one** -- `otel_metrics_sum` and `otel_metrics_gauge` move to the S3 cold volume at 90 days and
  drop at 180; `otel_logs` moves at 45 and drops at 90. The cold tier is the same S3 bucket under
  the same account, so moving is a storage-cost step, not a retention step -- only the `DELETE`
  leg discharges the PII obligation. The hourly rollup `otel_metrics_sum_hourly` also holds
  `UserEmail`, so it carries the same 90/180-day TTL as the raw table it summarizes; without it
  the rollup would retain user emails indefinitely after the source rows were deleted, silently
  bypassing retention. **Measured drift (2026-07-27): the live rollup had no TTL** --
  `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so the clause was never applied.
  The reconciling `ALTER ... MODIFY TTL` is now an executable statement in
  `infra/files/clickhouse-schema-replicated.sql` (the schema terraform actually applies, same
  pattern as the `SeriesKey` backfill `ALTER`). It had no execution path before: the schema-init
  Job's name was fixed, so editing the ConfigMap produced no Job diff and a completed Job never
  re-ran -- which is why the TTL never landed in the first place. The Job name now includes the
  schema file's `filemd5`, so a schema change replaces the Job and re-runs it on `terraform apply`.
  The rollup stays out of policy until that apply happens.
- **The chat's SQL trace is exposed to any authenticated user** -- `/api/chat` streams the
  model-authored SQL to the client (rendered by `ChatTrace`). Emails in it are masked with the
  same `maskEmailText()` used on tool results, but other telemetry literals a query may
  contain -- notably `SessionId` -- are **not** redacted and are visible on screen, in the DOM,
  and to any proxy logging the SSE body. This reverses an earlier decision to withhold the SQL;
  it was taken deliberately to make long turns legible, and it is a real exposure surface to
  weigh if the auth boundary ever becomes multi-tenant.
- **The same largely applies to the streamed reasoning summary** -- `send("thinking", ...)` runs
  `maskEmailText()` over each delta, but that is best-effort only: the regex sees one delta at a
  time, so an email split across a chunk boundary passes through unmasked. `SessionId` gets no
  masking at all. Same trust boundary and same deliberate trade-off as the SQL trace; revisit
  both together (a server-side accumulating buffer would close the chunk-boundary gap).
- **Emails are masked before they reach the server log too** -- a ClickHouse parse error echoes
  the offending SQL, so `err.message`/`err.stack` can carry a `UserEmail` literal, and the runbook
  tells operators to grep those pod logs. `maskEmailText()` is applied before `console.error`.
  `SessionId` in an echoed query is still logged as-is, same accepted trade-off as above.

### 4. Code Pointers
- `dashboard/server/index.js` -- Basic Auth middleware registration
- `dashboard/server/chat.js` -- `sanitizeSql()`
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
- **PII 보존 기간은 테이블 TTL로 강제하며, `UserEmail`을 담는 모든 저장소가 TTL을 가져야
  합니다** -- `otel_metrics_sum`·`otel_metrics_gauge`는 90일에 S3 cold 볼륨으로 이동하고 180일에
  삭제되며, `otel_logs`는 45일 이동·90일 삭제입니다. cold 티어도 같은 계정의 같은 S3 버킷이라
  이동은 스토리지 비용 단계일 뿐이고, PII 의무를 실제로 해소하는 건 `DELETE` 쪽뿐입니다.
  시간별 롤업 `otel_metrics_sum_hourly`도 `UserEmail`을 담으므로 원본과 동일한 90/180일 TTL을
  가집니다 — 없으면 원본이 삭제된 뒤에도 롤업에 사용자 이메일이 무기한 남아 보존 정책을 조용히
  우회합니다. **실측 드리프트(2026-07-27): 라이브 롤업에는 TTL이 없었습니다** — `CREATE TABLE IF
  NOT EXISTS`가 기존 테이블에 no-op이라 TTL 절이 적용된 적이 없습니다. 맞추는
  `ALTER ... MODIFY TTL`은 이제 terraform이 실제 적용하는
  `infra/files/clickhouse-schema-replicated.sql`에 **실행되는 문장**으로 들어있습니다(`SeriesKey`
  백필 `ALTER`와 같은 패턴). 그전에는 실행 경로 자체가 없었습니다 — schema-init Job 이름이
  고정이라 ConfigMap만 바꿔도 Job spec에 diff가 없고, 이미 완료된 Job은 다시 실행되지 않습니다.
  TTL이 애초에 적용되지 않은 이유가 이것입니다. 이제 Job 이름에 스키마 파일 `filemd5`가 들어가
  스키마가 바뀌면 Job이 교체·재실행됩니다. 그 apply가 일어나기 전까지는 정책 위반 상태입니다.
- **챗의 SQL trace는 인증된 모든 사용자에게 노출됩니다** -- `/api/chat`가 모델이 작성한 SQL을
  클라이언트로 스트리밍하고 `ChatTrace`가 렌더합니다. 안의 이메일은 툴 결과와 동일한
  `maskEmailText()`로 마스킹되지만, 쿼리에 실릴 수 있는 다른 telemetry 리터럴 — 특히
  `SessionId` — 은 **마스킹되지 않고** 화면·DOM·SSE 본문을 로깅하는 프록시에 그대로 남습니다.
  이는 SQL을 숨기던 이전 결정을 뒤집은 것으로, 긴 턴의 진행 상황을 읽을 수 있게 하려고 의도적으로
  택했습니다. 인증 경계가 멀티테넌트로 바뀌면 반드시 재검토해야 하는 노출 경로입니다.
- **스트리밍되는 추론 요약(thinking)도 동일합니다** -- `send("thinking", ...)`는 모델의 요약된
  추론을 마스킹 없이 그대로 전달합니다. 모델이 툴 결과에서 읽은 `SessionId`나 이메일을 다시
  언급하면 그 텍스트가 마스킹 없이 클라이언트에 도달합니다. SQL trace와 같은 신뢰 경계·같은
  의도적 트레이드오프이므로 재검토도 함께 해야 합니다.
- **이메일은 서버 로그에 적재되기 전에도 마스킹합니다** -- ClickHouse 파싱 에러가 문제가 된 SQL을
  그대로 에코하므로 `err.message`/`err.stack`에 `UserEmail` 리터럴이 실릴 수 있고, 런북이 그 파드
  로그를 grep하도록 안내합니다. 그래서 `console.error` 앞에 `maskEmailText()`를 적용합니다.
  에코된 쿼리 안의 `SessionId`는 위와 같은 사유로 여전히 그대로 남습니다.

### 4. 코드 포인터
- `dashboard/server/index.js` -- Basic Auth 미들웨어 등록
- `dashboard/server/chat.js` -- `sanitizeSql()`
- `dashboard/server/clickhouse.js` -- `queryReadonly()` export
- `infra/dashboard.tf` -- k8s Secret에서 env 주입

### 5. 상호 참조
- 관련 모듈: [dashboard/server/CLAUDE.md](../../dashboard/server/CLAUDE.md)
- 관련 ADR: (아직 없음)
- 관련 런북: (아직 없음)
