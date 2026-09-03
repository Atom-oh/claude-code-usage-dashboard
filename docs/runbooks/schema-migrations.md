# Runbook: ClickHouse Schema Migrations

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Overview
`claude_code.schema_migrations` is a ledger table that records which hand-applied
`clickhouse-migration-NNN.sql` files a cluster has run. It was introduced by
`clickhouse-migration-004.sql`, which also backfills rows for `002` and `003` — migrations
that predate the ledger and were previously verifiable only by inspecting column metadata by
hand. `dashboard/server/schema.js`'s `probeMigrations()` reads the table and surfaces the
result at `GET /api/config`'s `schema.migrations`.

## When to Use
- Before and after applying any `clickhouse-migration-NNN.sql`, to confirm what a cluster
  already has and that the new file landed.
- Whenever a dashboard figure looks wrong and you need to know which schema version a
  cluster is actually running, rather than assuming it matches the latest file in the repo.

## Prerequisites
- `kubectl` access to the `claude-code` namespace on the target cluster.
- The migration file readable from a path the target pod can reach (e.g. copied in, or
  piped via `--queries-file` from a mounted volume).
- Know that the ledger `INSERT` in every migration file is **not** `ON CLUSTER` — run the
  file against **one** pod only and let ClickHouse's replication log carry the row to the
  other replicas. Running it against every pod would not corrupt anything (the guards make
  it a no-op on replicas that already see the row), but it is unnecessary load.

## Procedure

### 1. Check what is already applied
Two read-only ways to check, and they should agree:
```sql
SELECT version, name, applied_at FROM claude_code.schema_migrations ORDER BY version;
```
or, from the dashboard itself:
```
GET /api/config  ->  schema.migrations
```
`null` from the API means **undetermined** — either the probe hit an error, or the cluster
predates `clickhouse-migration-004.sql` and the table does not exist yet
(`dashboard/server/schema.js`'s `probeMigrations()` folds `UNKNOWN_TABLE` and every other
error to `null`). An **empty array** (`[]`) is a different, measured answer: the ledger
table exists and no migration has been recorded in it yet.

### 2. Apply the next migration file
```bash
kubectl -n claude-code exec <clickhouse-pod> -c clickhouse -- \
  clickhouse-client --queries-file /path/to/clickhouse-migration-NNN.sql
```
This is the same invocation `clickhouse-migration-004.sql`'s own header documents for
itself — do not invent a variant (no extra flags, no different `-n`/context). Copy the
migration file onto a path the pod can read before running this, or adapt the path to
however your cluster access already stages files (e.g. `kubectl cp`).

### 3. The header every future migration file must carry
Every `clickhouse-migration-NNN.sql` from `004` onward starts with a header line:
```
-- migration: NNN | requires: NNN-1 | records itself: INSERT INTO claude_code.schema_migrations
```
and ends with a guarded `INSERT` that records itself. Before writing a new migration file,
compute its checksum with:
```bash
grep -v 'INSERT INTO claude_code.schema_migrations' clickhouse-migration-00N.sql \
  | sha256sum | cut -c1-64
```
and paste the result as the literal `checksum` value in that file's own self-recording
`INSERT`. The `version`, `name` and `checksum` literals **must stay on the same physical
line as the `INSERT INTO claude_code.schema_migrations` keyword** — the `grep -v` above is
what strips that exact line before hashing, so moving any of the three literals onto a
continuation line would fold them into the hashed content and make the checksum
self-referential (and therefore unverifiable: the file's own recorded checksum would never
match a hash computed from the file as written).

### 4. The rule for every future migration
Every future `clickhouse-migration-NNN.sql` ends with its own guarded, self-recording
`INSERT INTO claude_code.schema_migrations`, and the identical block (same guards, same
checksum) is mirrored into both schema copies — `clickhouse-schema.sql` (single-node
reference/local copy) and `infra/files/clickhouse-schema-replicated.sql` (the file the
schema-init Job applies to new clusters). That is what makes a brand-new install "at N" by
definition: running the full schema file once satisfies every migration's column-evidence
guard and leaves the ledger fully populated without anyone applying the numbered files by
hand.

## Verification
Re-run step 1 and confirm the new version appears with a recent `applied_at`. Running the
same migration file a second time must be a no-op, never an error — the self-recording
`INSERT`'s guard is a `count()` sub-select against the ledger itself (`... AND (SELECT
count() FROM claude_code.schema_migrations WHERE version = N) = 0`), so a re-run adds zero
rows. This was measured directly against `clickhouse/clickhouse-server:24.8.14.39`: applying
`clickhouse-migration-004.sql` twice in a row still leaves exactly three ledger rows.

## Rollback
There is no rollback for the underlying schema change itself — these migrations create
tables/columns, and none of the guarded `INSERT`s undo prior DDL. If a migration needs to be
considered "unapplied" for tracking purposes, the ledger row can be removed by hand:
```sql
ALTER TABLE claude_code.schema_migrations DELETE WHERE version = N;
```
Deleting this row does **not** undo the schema change the migration made — it only removes
the record that it happened. Treat it purely as a bookkeeping correction, and only do it if
you have independently verified (via column evidence, same as the `002`/`003` guards do)
that the migration's actual DDL was reverted by some other means first.

## Notes
- **A cluster created before `004` shows `null` at `/api/config`'s `schema.migrations`
  until `004` is applied** — the table itself does not exist yet, so the probe's query fails
  and folds to `null` rather than an empty list.
- **The `002` and `003` rows are backfilled from column evidence, not from history.** Their
  `applied_at` is the timestamp `004` actually ran, not the timestamp `002` or `003` ran.
  An operator reading these timestamps to date an incident should not treat `002`'s or
  `003`'s `applied_at` as "when that migration was applied" — only `004`'s row (and any
  migration after it) carries a real application timestamp.
- The segment-aware `SeriesKey` detection surfaced at `/api/config`'s
  `schema.segmentAwareSeriesKey` is a **separate, data-based probe** (it reads recent
  `claude_code.cost.usage` rows, not the ledger) and remains the source of truth for the
  `--resume` lower-bound cost note — the ledger tells you which files ran, that probe tells
  you which behavior is actually in effect on live data.

---

<a id="korean"></a>

# 한국어

## 개요
`claude_code.schema_migrations`는 클러스터가 어느 `clickhouse-migration-NNN.sql` 파일을
직접 실행했는지 기록하는 원장 테이블입니다. `clickhouse-migration-004.sql`이 이 테이블을
만들면서 `002`와 `003`의 적용 여부도 함께 소급 기록합니다 — 이 두 마이그레이션은 원장이
생기기 전이라, 그전까지는 컬럼 메타데이터를 직접 뒤져야만 확인할 수 있었습니다.
`dashboard/server/schema.js`의 `probeMigrations()`가 이 테이블을 읽어 `GET /api/config`의
`schema.migrations`로 결과를 내보냅니다.

## 사용 시점
- `clickhouse-migration-NNN.sql`을 적용하기 전/후 — 클러스터가 이미 뭘 갖고 있는지, 새 파일이
  실제로 반영됐는지 확인할 때.
- 대시보드 수치가 이상해 보여서 클러스터가 실제로 어느 스키마 버전인지 확인해야 할 때 —
  저장소 최신 파일과 같을 것이라고 가정하지 말고 직접 확인.

## 사전 요구 사항
- 대상 클러스터의 `claude-code` 네임스페이스에 대한 `kubectl` 접근 권한.
- 대상 파드가 읽을 수 있는 경로에 마이그레이션 파일이 있어야 함(복사해 넣거나, 마운트된
  볼륨에서 `--queries-file`로 지정).
- 모든 마이그레이션 파일의 원장 `INSERT`는 `ON CLUSTER`가 **아니라는** 점을 알아야 합니다 —
  **한** 파드에서만 실행하고 ClickHouse의 복제 로그가 다른 레플리카에 전파하게 둡니다. 모든
  파드에서 각각 실행해도 깨지지는 않습니다(가드가 이미 그 행을 본 레플리카에서는 no-op으로
  만들어 줍니다), 다만 불필요한 부하입니다.

## 절차

### 1. 이미 적용된 것 확인
읽기 전용으로 확인하는 두 가지 방법이 있고, 서로 일치해야 합니다:
```sql
SELECT version, name, applied_at FROM claude_code.schema_migrations ORDER BY version;
```
또는 대시보드 자체에서:
```
GET /api/config  ->  schema.migrations
```
API에서 `null`이 오면 **판정 불가**를 의미합니다 — 프로브가 에러를 만났거나, 클러스터가
`clickhouse-migration-004.sql`보다 오래되어 테이블 자체가 아직 없는 경우입니다
(`dashboard/server/schema.js`의 `probeMigrations()`는 `UNKNOWN_TABLE`을 비롯한 모든 에러를
`null`로 접습니다). **빈 배열**(`[]`)은 다른, 실측된 답입니다: 원장 테이블은 존재하지만
아직 아무 마이그레이션도 기록되지 않았다는 뜻입니다.

### 2. 다음 마이그레이션 파일 적용
```bash
kubectl -n claude-code exec <clickhouse-pod> -c clickhouse -- \
  clickhouse-client --queries-file /path/to/clickhouse-migration-NNN.sql
```
이 명령은 `clickhouse-migration-004.sql` 자신의 헤더가 스스로 기록해 둔 것과 동일합니다 —
변형을 만들지 마세요(추가 플래그 없음, 다른 `-n`/context 없음). 실행 전에 마이그레이션
파일을 파드가 읽을 수 있는 경로로 복사하거나, 이미 쓰고 있는 클러스터 접근 방식(예:
`kubectl cp`)에 맞게 경로를 맞추세요.

### 3. 앞으로의 모든 마이그레이션 파일이 가져야 할 헤더
`004`부터 모든 `clickhouse-migration-NNN.sql`은 다음 헤더 줄로 시작합니다:
```
-- migration: NNN | requires: NNN-1 | records itself: INSERT INTO claude_code.schema_migrations
```
그리고 자기 자신을 기록하는 가드된 `INSERT`로 끝납니다. 새 마이그레이션 파일을 작성하기
전에 다음 명령으로 checksum을 계산하세요:
```bash
grep -v 'INSERT INTO claude_code.schema_migrations' clickhouse-migration-00N.sql \
  | sha256sum | cut -c1-64
```
그 결과를 그 파일 자신의 자기-기록 `INSERT`에 `checksum` 리터럴로 붙여 넣습니다.
`version`, `name`, `checksum` 리터럴은 **반드시 `INSERT INTO
claude_code.schema_migrations` 키워드와 같은 물리적 줄에** 있어야 합니다 — 위 `grep -v`가
해싱 전에 지우는 줄이 정확히 그 줄이기 때문입니다. 셋 중 하나라도 다음 줄로 내리면 해시
대상 내용에 그 리터럴이 포함되어 checksum이 자기 자신을 참조하게 되고, 그러면 검증이
불가능해집니다(파일이 기록해 둔 checksum이 파일을 있는 그대로 해싱한 값과 결코 일치하지
않게 됩니다).

### 4. 앞으로의 마이그레이션 규칙
앞으로의 모든 `clickhouse-migration-NNN.sql`은 자기 자신을 기록하는 가드된 `INSERT INTO
claude_code.schema_migrations`로 끝나고, 동일한 블록(같은 가드, 같은 checksum)이 두 스키마
사본 — `clickhouse-schema.sql`(단일 노드 참조/로컬 사본)과
`infra/files/clickhouse-schema-replicated.sql`(schema-init Job이 신규 클러스터에 적용하는
파일) — 에 그대로 미러링됩니다. 이것이 신규 설치가 정의상 "N까지 적용된" 상태가 되는
이유입니다: 스키마 파일 전체를 한 번 실행하면 모든 마이그레이션의 컬럼-증거 가드가 충족되어
누구도 번호 붙은 파일을 손으로 하나씩 실행하지 않아도 원장이 완전히 채워집니다.

## 검증
1단계를 다시 실행해 새 버전이 최근 `applied_at`과 함께 나타나는지 확인합니다. 같은
마이그레이션 파일을 두 번 실행해도 에러가 아니라 반드시 no-op이어야 합니다 — 자기-기록
`INSERT`의 가드는 원장 자체에 대한 `count()` 서브셀렉트입니다(`... AND (SELECT count()
FROM claude_code.schema_migrations WHERE version = N) = 0`), 그래서 재실행은 행을 0개
추가합니다. 이는 `clickhouse/clickhouse-server:24.8.14.39`에서 직접 실측했습니다:
`clickhouse-migration-004.sql`을 연속으로 두 번 적용해도 원장은 여전히 정확히 3행입니다.

## 롤백
스키마 변경 자체에 대한 롤백은 없습니다 — 이 마이그레이션들은 테이블/컬럼을 만들고, 어떤
가드된 `INSERT`도 이전 DDL을 되돌리지 않습니다. 추적 목적으로 특정 마이그레이션을
"미적용"으로 취급해야 한다면 원장 행을 손으로 지울 수 있습니다:
```sql
ALTER TABLE claude_code.schema_migrations DELETE WHERE version = N;
```
이 행을 지우는 것은 그 마이그레이션이 만든 스키마 변경을 **되돌리지 않습니다** — 단지
"적용됐다"는 기록만 지웁니다. 순수한 기록 정정으로만 취급하고, 마이그레이션의 실제 DDL이
다른 방법으로 먼저 되돌려졌음을 (`002`/`003`의 가드처럼 컬럼 증거로) 독립적으로 확인한
경우에만 지우세요.

## 참고
- **`004` 이전에 만들어진 클러스터는 `004`가 적용되기 전까지 `/api/config`의
  `schema.migrations`에서 `null`을 보여줍니다** — 테이블 자체가 아직 없어 프로브의 쿼리가
  실패하고, 빈 목록이 아니라 `null`로 접힙니다.
- **`002`와 `003` 행은 이력이 아니라 컬럼 증거로 소급 기록됩니다.** 그 행들의 `applied_at`은
  `002`나 `003`이 실제로 실행된 시각이 아니라 `004`가 실행된 시각입니다. 인시던트 시각을
  파악하려고 이 타임스탬프를 읽는 오퍼레이터는 `002`/`003`의 `applied_at`을 "그 마이그레이션이
  적용된 시각"으로 오해해서는 안 됩니다 — 실제 적용 시각을 갖는 것은 `004`(및 그 이후
  마이그레이션)의 행뿐입니다.
- `/api/config`의 `schema.segmentAwareSeriesKey`로 노출되는 segment-aware `SeriesKey` 감지는
  **별개의, 데이터 기반 프로브**입니다(원장이 아니라 최근 `claude_code.cost.usage` 행을
  읽습니다). `--resume` 하한선 비용 문구의 근거는 계속 이 프로브가 담당합니다 — 원장은 어느
  파일이 실행됐는지를 알려주고, 이 프로브는 실제 데이터에서 어느 동작이 지금 적용 중인지를
  알려줍니다.
