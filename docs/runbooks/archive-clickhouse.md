# Runbook: Permanent ClickHouse Archive Before Account Teardown

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Overview
The workshop AWS account will be deleted. The only ClickHouse backups live in that account's
S3 bucket, under `cc-ab-clickhouse-<workshop-account-id>-<region>/backup/` — the daily
`clickhouse-backup` CronJob (`infra/clickhouse.tf`) runs `BACKUP DATABASE claude_code TO
S3('https://<bucket>.s3.<region>.amazonaws.com/backup/<date>')` directly, which writes real,
self-contained objects there (a `.backup` manifest plus `data/<db>/<table>/...` parts) — nothing
about restoring them depends on anything else in the account. That prefix has a 30-day expiry
lifecycle (`infra/s3.tf`), and everything disappears with the account regardless of the
lifecycle timer. `scripts/archive-clickhouse.sh` takes one more `BACKUP` snapshot, then copies
the entire `backup/` prefix out to a bucket in your own (permanent) AWS account.

**Measured 2026-07-27 (see Notes) — do not use `Disk('cold_s3', ...)` for backups.** An earlier
version of this backup mechanism (and of this script) used `Disk('cold_s3', 'backup/...')`.
That disk is a plain `type=s3` disk (`infra/clickhouse.tf`): it keeps logical paths only in the
pod's local metadata and writes S3 objects under content-addressed random keys
(`cold/<3-char>/<random>`), not at the logical path. A live check of the workshop bucket found
**zero objects** under `cold/backup/` — that mechanism never produced anything exportable, and
copying the `cold/` prefix directly would only grab live table data blobs, unrestorable without
the pod's PVC metadata. `BACKUP ... TO S3(...)` (used now) has no such dependency — verified by
a full backup→restore→row-count round trip, see Notes.

## When to Use
Once, shortly before the workshop account is torn down. Re-runnable if a prior run failed
partway (set `SKIP_BACKUP=1` to skip re-taking the snapshot and just re-sync).

**There is no strict ordering requirement against `terraform apply`.** This script's own
Step 2 (`BACKUP DATABASE claude_code TO S3(...)`) issues that command directly over the
`otel_writer` connection using the pod's existing IRSA credentials — it does not depend on
`infra/clickhouse.tf`'s CronJob being updated first, and works identically whether or not that
change has been applied. Run it once, close to account teardown, either way.

What *does* depend on timing is the pre-existing 30-day lifecycle filter on `infra/s3.tf`
(`prefix = "backup/"`, unchanged by this PR — see Notes): before `infra/clickhouse.tf`'s change
is applied, nothing is written to `backup/` at all (the old `Disk('cold_s3', ...)` mechanism
wrote elsewhere), so that filter has nothing to expire regardless of when you apply. After it's
applied, the daily CronJob starts writing real objects there, each starting at age 0 — applying
does **not** cause anything to expire immediately. The actual risk is longer-horizon: once
applied, don't go **more than 30 days** without running this script again, or the earliest
post-apply daily backups can age out before you've copied them anywhere permanent. Before
tearing down the account, always run this script one last time regardless of how recently you
last ran it.

## Prerequisites
- `~/.aws/credentials` with a profile for the workshop account, with `s3:ListBucket` and
  `s3:GetObject` on the `cc-ab-clickhouse-*` bucket (the pod's IRSA role has write access —
  `infra/s3.tf` — but this profile is a separate, human-held identity and needs its own grant):
  ```ini
  [workshop]
  aws_access_key_id = ...
  aws_secret_access_key = ...
  aws_session_token = ...   # only if the workshop account issues temporary credentials
  ```
- For the destination side, nothing extra: the script leaves `--profile` off by default and
  uses the ambient credential chain — i.e. the instance profile of the EC2 box you run it on.
  Set `ARCHIVE_PROFILE=<name>` only if you'd rather use a named profile.
- A pre-existing S3 bucket in your own account to hold the archive (`ARCHIVE_BUCKET`), with
  `s3:PutObject`/`s3:ListBucket` for whichever identity the destination side resolves to (the
  script prints that account ID in step 1 — check it before the long sync starts), a Public
  Access Block fully enabled (the script fails closed if it isn't — see Notes on PII), and
  encryption at rest (the script uploads with `--sse AES256`; bucket default encryption is a
  reasonable belt-and-suspenders addition but not required by the script).
- `kubectl` context `fsi-demo-cluster`, access to namespace `claude-code`: `get`/`exec` on the
  `chi-cc-ab-*` pods and `get` on Secret `clickhouse-writer` (same access pattern as
  [`incident-response.md`](incident-response.md)).
- If the workshop's bucket was created in a region other than `ap-northeast-2`
  (`REGION`'s default, matching `infra/variables.tf`), set `REGION` explicitly — the source
  bucket name is reconstructed from the account ID and region, so a wrong region means a wrong
  (likely nonexistent) bucket name.
- Local disk space for the **entire `backup/` prefix**, not just one backup. Don't estimate
  this from the "~30 days of backups" assumption — until this PR's `clickhouse.tf` change is
  applied, nothing has ever been written to `backup/` (the old `Disk('cold_s3', ...)` mechanism
  wrote elsewhere entirely — see Notes), so the existing 30-day lifecycle filter has never had
  anything to expire and `backup/` may be empty, or may already hold an unknown amount once the
  CronJob starts writing there. The script measures the real source size with
  `aws s3 ls --summarize` and compares it against free space on `LOCAL_DIR` before doing anything
  destructive-adjacent — but if that preflight check fails, don't just add disk and retry
  blindly; check *why* the prefix is larger than expected first.
- Single shard only: the script picks one pod (`clickhouse.altinity.com/chi=cc-ab`, `head -1`)
  and backs up from it. It asserts `shardsCount = 1` (`infra/clickhouse.tf`) via
  `system.clusters` and refuses to run otherwise — a multi-shard cluster needs a different
  (per-shard or `ON CLUSTER`) approach that this script doesn't implement.

## Procedure

### 1. Sync-only run (no live backup, just move what already exists)
```bash
ARCHIVE_BUCKET=my-permanent-bucket SKIP_BACKUP=1 ./scripts/archive-clickhouse.sh
```
This still downloads and uploads real data — it just skips taking a fresh snapshot. Use it to
confirm both AWS identities work, the source bucket/prefix resolve correctly, and sync +
verification succeed before spending time (and disk) on a new multi-GB backup. Note this only
finds anything once the daily CronJob has run at least once with the `BACKUP TO S3(...)` form
(i.e. after `infra/clickhouse.tf`'s change is applied) — against an unpatched cluster still
running the old `Disk('cold_s3', ...)` form, `backup/` is empty and the script exits with an
explicit error rather than silently archiving nothing.

### 2. Full run
```bash
ARCHIVE_BUCKET=my-permanent-bucket ./scripts/archive-clickhouse.sh
```
This takes a fresh `BACKUP DATABASE claude_code TO S3('https://<source-bucket>.s3.<region>
.amazonaws.com/backup/final-<UTC timestamp>')` inside the cluster (same mechanism as the daily
`clickhouse-backup` CronJob in `infra/clickhouse.tf`), then syncs the whole `backup/` prefix —
including the still-live daily backups — plus a copy of three schema/reference files
(`clickhouse-schema.sql`, `infra/files/clickhouse-schema-replicated.sql`,
`grafana-ab-queries.sql`) to `s3://$ARCHIVE_BUCKET/$ARCHIVE_PREFIX/` (default prefix
`clickhouse-ab-workshop`), server-side encrypted (`--sse AES256`).

The script verifies success by re-running the same `aws s3 sync` as a `--dryrun` and checking
it reports nothing left to copy — not by comparing the live source's current object
count/bytes against the archive, since those can legitimately diverge afterwards (e.g. a
daily backup in the source expires between the upload and the check) without meaning the
archive is wrong.

### 3. Restore rehearsal (recommended while the workshop account is still alive)
Point a ClickHouse instance at the archive bucket and confirm a real restore works — this is
the only way to be sure the archive is actually usable.

`RESTORE ... FROM S3(...)` recreates tables using the DDL captured **inside the backup itself**
at backup time — it ignores any external schema file, including the `schema/clickhouse-schema.sql`
copy this script uploads alongside it. That captured DDL is `ReplicatedMergeTree`/
`ReplicatedAggregatingMergeTree` (`infra/files/clickhouse-schema-replicated.sql`), so a plain
single-node instance with no Keeper — like `dashboard/docker-compose.yml` as-is — will fail a
straight `RESTORE`. Two ways to actually rehearse it:

**Option A — restore onto matching infra.** Stand up a scratch Keeper + replicated ClickHouse
matching `infra/clickhouse.tf`'s shape (same macros) and run:
```sql
RESTORE DATABASE claude_code
  FROM S3('https://<archive-bucket>.s3.<region>.amazonaws.com/<archive-prefix>/backup/final-<timestamp>',
          '<ACCESS_KEY_ID>', '<SECRET_ACCESS_KEY>');
  -- rehearsal only — use short-lived/temporary credentials where possible, revoke after.
  -- If using STS temporary credentials instead of a long-lived IAM user, ClickHouse's S3()
  -- takes the session token as a 4th positional argument:
  --   S3('<url>', '<ACCESS_KEY_ID>', '<SECRET_ACCESS_KEY>', '<SESSION_TOKEN>')
```
Most faithful, most setup.

**Option B — restore onto a single node with `allow_different_table_def`.** Create the target
tables yourself first using non-replicated engines (swap `ReplicatedMergeTree(...)` for
`MergeTree()`, `ReplicatedAggregatingMergeTree(...)` for `AggregatingMergeTree()`, drop the
`ON CLUSTER`/keeper-path arguments — **the partition/order key must match exactly**, not just
column definitions: a mismatched `PARTITION BY` makes `RESTORE` fail with `CORRUPTED_DATA`
because the part's embedded partition ID no longer matches the freshly-computed one — this was
hit and fixed during verification, see Notes). `RESTORE DATABASE` restores every table in the
backup, so pre-create **all** of them this way, not just one — as of this writing that's
`otel_logs`, `otel_metrics_gauge`, `otel_metrics_sum`, and `otel_metrics_sum_hourly` (confirmed
live via `SELECT table FROM system.replicas WHERE database = 'claude_code'`); any table you skip
makes `RESTORE` try to create it with the embedded replicated DDL and fail the same way a
straight `RESTORE` would:
```sql
-- 1. Create claude_code and ALL FOUR tables first, using non-replicated engines. Column
--    lists come from clickhouse-schema.sql (uploaded alongside the backup under schema/) —
--    only the ENGINE/PARTITION BY/ORDER BY change, columns stay identical. Verified working
--    PARTITION BY / ORDER BY for otel_metrics_sum_hourly (adapt the same pattern for the
--    other three using their PARTITION BY / ORDER BY from clickhouse-schema.sql):
CREATE TABLE claude_code.otel_metrics_sum_hourly (
  -- ... same columns as clickhouse-schema.sql ...
)
  ENGINE = AggregatingMergeTree()
  PARTITION BY toYYYYMM(hour)
  ORDER BY (MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality, Model,
            TokenType, Decision, SkillName, ToolName, hour);
-- ... repeat for otel_logs, otel_metrics_gauge, otel_metrics_sum ...

-- 2. Then restore data into the tables you just created:
RESTORE DATABASE claude_code
  FROM S3('https://<archive-bucket>.s3.<region>.amazonaws.com/<archive-prefix>/backup/final-<timestamp>',
          '<ACCESS_KEY_ID>', '<SECRET_ACCESS_KEY>')
  SETTINGS allow_different_table_def = 1, allow_non_empty_tables = 1;

SHOW CREATE TABLE claude_code.otel_metrics_sum;  -- confirm materialized SeriesKey survived
-- Row counts on AggregatingMergeTree/otel_metrics_sum_hourly can differ from the source by
-- background merge state alone (parts collapse over time) even when the data is intact — a
-- count() match can be coincidental and a mismatch isn't necessarily a real problem. Compare
-- decoded aggregate values instead, over a time window you know is no longer being written to.
-- Aggregate columns need decoding to compare values, not just row counts. This schema uses
-- SimpleAggregateFunction (plain sum(), not sumMerge() — sumMerge is for AggregateFunction
-- columns and errors with ILLEGAL_TYPE_OF_ARGUMENT against SimpleAggregateFunction):
SELECT round(sum(sum_value)) FROM claude_code.otel_metrics_sum_hourly WHERE hour < '<cutoff-no-longer-being-written-to>';
```

Record the date this was last actually run (following `incident-response.md`'s "Last
verified" convention) — an untested restore procedure is a hypothesis, not a plan.

**Last verified: 2026-07-27** — probed against the live workshop cluster with
`BACKUP TABLE claude_code.otel_metrics_sum_hourly TO S3(...)`, then Option B restore into a
scratch database on the same cluster. Row counts and `sum(sum_value)` matched exactly
(658,942 rows, total 859774746755734) over an immutable time window on the source table; probe
objects and the scratch database were deleted afterward. Full-`DATABASE` restore and Option A
have not been separately rehearsed — re-verify before relying on either.

## Notes
- Only the `backup/` prefix is archived. **Do not archive or expire anything under `cold/`** —
  that prefix holds the `hot_cold` storage policy's live TTL-moved table data as
  content-addressed blobs (measured 2026-07-27: `cold/aaa/bzscpvamwnobmdnxgdzxliguiekpl`-style
  keys, no `backup/` subpath), commingled with no way to tell "backup blob" from "live data
  blob" by key alone. `BACKUP DATABASE` already captures those parts logically regardless of
  which disk they physically sit on at backup time, so there is nothing to separately copy —
  and applying a lifecycle rule to `cold/` would corrupt the live cluster's cold-tier data.
- `otel_metrics_sum_hourly` is included in the backup, but note it is only derivable from
  `otel_metrics_sum` via `scripts/backfill-hourly-rollup.sh` when the rollup table already has
  at least one row (that script no-ops on a fully empty table) — don't rely on it as a full
  substitute for the archived rollup data itself.
- This is the first script in the repo to use a named AWS CLI profile (`--profile`, for the
  workshop side only) rather than purely the ambient credential chain or in-cluster IRSA — see
  `docs/reference/iac.md` if adding more.
- Archived data retains whatever PII/session data was in `otel_logs`/`otel_metrics_sum`
  (e.g. `UserEmail`) beyond the source cluster's 90/180-day TTLs, indefinitely — the script
  enforces a Public Access Block on the archive bucket before uploading and encrypts objects
  with `--sse AES256`, but decide a retention/deletion policy for the archive bucket itself if
  this matters for your use case.
- `infra/s3.tf`'s lifecycle rule already filters on prefix `backup/` on `main` — this PR does
  not change that filter. What changes is where daily backups actually land: before this PR's
  `infra/clickhouse.tf` change, backups went to `Disk('cold_s3', ...)`, which (as measured above)
  never wrote anything to `backup/` at all, so the filter had nothing to expire regardless of
  its value. After this PR, `BACKUP ... TO S3(...)` writes real objects under `backup/`, and the
  pre-existing filter starts matching them for the first time.
- **Why `S3(...)` and not `Disk('cold_s3', ...)`**: measured live against the workshop cluster
  on 2026-07-27 — `aws s3 ls --recursive s3://cc-ab-clickhouse-<acct>-<region>/cold/` returned
  only randomized blob keys, zero matches under `cold/backup/`; the actual backup manifests live
  only in the ClickHouse pod's local disk metadata
  (`/var/lib/clickhouse/disks/cold_s3/backup/<date>/`). `BACKUP ... TO S3(...)` was then
  verified end-to-end: it produces objects at the real logical path
  (`<prefix>/data/claude_code/<table>/<part>/<column>.bin`, `<prefix>/.backup`) using the same
  pod IRSA credentials (`use_environment_credentials`, no extra config), and a restore from
  those objects reproduced the source table exactly (see "Last verified" above). If you're
  archiving from a cluster that still runs the pre-fix `Disk('cold_s3', ...)` daily backups,
  those backups are **not exportable** — they depend on the pod's PVC and disappear with the
  account regardless; only backups taken after `infra/clickhouse.tf`'s CronJob update land in
  `backup/` where this script can reach them.

---

<a id="korean"></a>

# 한국어

## 개요
워크샵 AWS 계정이 삭제될 예정입니다. ClickHouse 백업은 그 계정의 S3 버킷
`cc-ab-clickhouse-<워크샵계정ID>-<리전>`의 `backup/` 아래에만 존재합니다 — 일별
`clickhouse-backup` CronJob(`infra/clickhouse.tf`)이 직접
`BACKUP DATABASE claude_code TO S3('https://<버킷>.s3.<리전>.amazonaws.com/backup/<날짜>')`를
실행하므로, 거기 쓰인 객체(`.backup` 매니페스트 + `data/<db>/<table>/...` 파트)는 계정 안의
다른 무엇에도 의존하지 않는 자기완결적 결과물입니다. 이 프리픽스엔 30일 만료 라이프사이클이
걸려 있고(`infra/s3.tf`), 라이프사이클 타이머와 무관하게 계정이 사라지면 모두 같이
사라집니다. `scripts/archive-clickhouse.sh`는 `BACKUP` 스냅샷을 한 번 더 뜨고 `backup/`
프리픽스 전체를 내 계정(영구) S3 버킷으로 복사합니다.

**실측 확인(2026-07-27, 아래 참고 참조) — 백업에 `Disk('cold_s3', ...)`를 쓰지 마세요.**
이 백업 메커니즘(및 이 스크립트)의 이전 버전은 `Disk('cold_s3', 'backup/...')`를 썼습니다.
이 디스크는 일반 `type=s3` 디스크(`infra/clickhouse.tf`)로, 논리 경로를 파드 로컬
metadata에만 두고 S3에는 content-addressed 랜덤 키(`cold/<3글자>/<랜덤문자열>`)로 저장할 뿐
논리 경로 그대로 쓰지 않습니다. 워크샵 버킷을 실제로 확인한 결과 `cold/backup/` 아래
객체는 **0개**였습니다 — 이 메커니즘은 처음부터 이관 가능한 산출물을 만들지 않았고,
`cold/` 프리픽스를 그대로 복사해도 살아있는 테이블 데이터 blob만 가져오게 되어 파드의 PVC
metadata 없이는 복원이 불가능합니다. 지금 쓰는 `BACKUP ... TO S3(...)`는 그런 의존성이
없습니다 — 백업→복원→행수 대조 왕복 검증으로 확인했습니다(아래 참고 참조).

## 사용 시점
워크샵 계정이 삭제되기 직전 1회. 이전 실행이 중간에 실패했다면 재실행 가능(`SKIP_BACKUP=1`로
새 스냅샷 없이 재동기화만).

**순서가 중요합니다**: `infra/s3.tf`의 라이프사이클 필터(`prefix = "backup/"`)는 `main`에
이미 존재하고 이 PR은 그 값을 바꾸지 않습니다 — 이 PR이 바꾸는 건 `infra/clickhouse.tf`의
백업 목적지입니다(`Disk('cold_s3', ...)` → `BACKUP TO S3(...)`, 처음으로 그 `backup/` 경로에
실제로 쓰기 시작 — 참고 섹션 참조). 즉 이 PR의 `clickhouse.tf` 변경을 적용해야 원래 있던 30일
필터가 비로소 매칭 대상을 갖게 됩니다. 이 아카이브 스크립트를 먼저 실행해 검증까지 통과시킨
**다음에** `clickhouse.tf` 변경을 `terraform apply`하세요. 먼저 적용하면, 아직 아무 데도 영구
복사되지 않은 30일 초과 백업이 소스 버킷에서 먼저 만료될 수 있습니다.

## 사전 준비
- `~/.aws/credentials`에 워크샵 계정 프로필 1개, `cc-ab-clickhouse-*` 버킷에 대한
  `s3:ListBucket`/`s3:GetObject` 권한 포함(파드의 IRSA 롤은 쓰기 권한이 있지만 — `infra/s3.tf`
  — 이 프로필은 별개의 사람 자격증명이라 별도로 권한을 부여해야 합니다):
  ```ini
  [workshop]
  aws_access_key_id = ...
  aws_secret_access_key = ...
  aws_session_token = ...   # 워크샵 계정이 임시 자격증명이면 필요
  ```
- 대상(내 계정) 쪽은 추가 설정이 필요 없습니다. 스크립트는 기본적으로 `--profile`을 붙이지 않고
  기본 자격증명 체인 — 즉 이 스크립트를 실행하는 EC2의 인스턴스 프로필 — 을 씁니다. 명명된
  프로필을 쓰고 싶을 때만 `ARCHIVE_PROFILE=<이름>`을 지정합니다.
- 아카이브를 담을, 내 계정에 이미 존재하는 S3 버킷(`ARCHIVE_BUCKET`)과 대상 측 자격증명에 대한
  `s3:PutObject`/`s3:ListBucket` 권한(스크립트 1단계에서 그 계정 ID를 출력합니다 — 긴 sync가
  시작되기 전에 확인하세요), Public Access Block이 4개 항목 모두 활성화(스크립트가 아니면
  fail-closed로 중단 — PII 관련 참고 참조), 저장 시 암호화(스크립트가 업로드 시
  `--sse AES256`을 붙이지만, 버킷 기본 암호화를 추가로 걸어두면 이중 안전장치가 됩니다).
- `kubectl` context `fsi-demo-cluster`, `claude-code` 네임스페이스에서 `chi-cc-ab-*` 파드
  `get`/`exec`와 Secret `clickhouse-writer` `get` 권한
  ([`incident-response.md`](incident-response.md)와 동일한 접근 패턴).
- 워크샵 버킷이 `ap-northeast-2`(`REGION` 기본값, `infra/variables.tf`와 동일) 외의 리전에
  생성됐다면 `REGION`을 명시적으로 지정하세요 — 소스 버킷명은 계정 ID와 리전으로
  재구성되므로, 리전이 틀리면 존재하지 않는 버킷명을 만들어냅니다.
- **백업 1개가 아니라 `backup/` 프리픽스 전체** 분량의 로컬 디스크 여유 공간. "30일치
  백업"이라는 가정으로 용량을 추정하지 마세요 — 이 PR의 `infra/clickhouse.tf` 변경이
  적용되기 전에는 `backup/`에 아무것도 쓰인 적이 없습니다(예전 `Disk('cold_s3', ...)`
  메커니즘은 전혀 다른 곳에 썼습니다 — 아래 참고 참조). 그래서 기존 30일 라이프사이클
  필터는 지금까지 만료시킬 대상이 없었고, CronJob이 `backup/`에 쓰기 시작한 뒤로는 얼마나
  쌓여 있을지 알 수 없습니다. 스크립트는 실제 소스 크기를 `aws s3 ls --summarize`로 측정해
  `LOCAL_DIR`의 여유 공간과 비교한 뒤에만 진행합니다 — 이 사전 점검에서 실패하면 무작정
  디스크만 늘려 재시도하지 말고 왜 프리픽스가 예상보다 큰지 먼저 확인하세요.
- 단일 shard 전제: 스크립트는 pod 하나(`clickhouse.altinity.com/chi=cc-ab`, `head -1`)만
  선택해 그 파드에서 백업을 뜹니다. `system.clusters`로 `shardsCount = 1`
  (`infra/clickhouse.tf`)을 확인하고 아니면 실행을 거부합니다 — 다중 shard 클러스터는
  shard별 반복이나 `ON CLUSTER` 등 이 스크립트가 구현하지 않은 별도 접근이 필요합니다.

## 절차

### 1. 이관만 실행 (새 백업 없이 기존 것만 이관)
```bash
ARCHIVE_BUCKET=my-permanent-bucket SKIP_BACKUP=1 ./scripts/archive-clickhouse.sh
```
이름과 달리 실제로 데이터를 내리고 올립니다 — 새 스냅샷만 안 뜰 뿐입니다. 새로 몇 GB짜리
백업을 뜨기 전에(디스크도 아끼면서) 두 AWS 자격증명이 정상 동작하는지, 소스 버킷/프리픽스가
올바르게 계산되는지, sync·검증이 통과하는지 먼저 확인하는 용도입니다. 일별 CronJob이
`BACKUP TO S3(...)` 형식으로 갱신된(즉 `infra/clickhouse.tf` 변경이 적용된) 뒤에 실행해야
뭔가를 찾습니다 — 예전 `Disk('cold_s3', ...)`만 돌던 클러스터에서는 `backup/`이 비어 있어
스크립트가 조용히 빈 것을 이관하는 대신 명시적 에러로 중단합니다.

### 2. 전체 실행
```bash
ARCHIVE_BUCKET=my-permanent-bucket ./scripts/archive-clickhouse.sh
```
클러스터 안에서 새 `BACKUP DATABASE claude_code TO S3('https://<소스버킷>.s3.<리전>
.amazonaws.com/backup/final-<UTC 타임스탬프>')`를 실행하고(`infra/clickhouse.tf`의 일별
`clickhouse-backup` CronJob과 동일한 메커니즘), `backup/` 프리픽스 전체(아직 살아있는 일별
백업 포함)와 스키마/참조 파일 3개(`clickhouse-schema.sql`,
`infra/files/clickhouse-schema-replicated.sql`, `grafana-ab-queries.sql`)를
`s3://$ARCHIVE_BUCKET/$ARCHIVE_PREFIX/`(기본 프리픽스 `clickhouse-ab-workshop`)로 저장 시
암호화(`--sse AES256`)와 함께 동기화합니다.

스크립트는 같은 `aws s3 sync`를 `--dryrun`으로 다시 돌려 남은 작업이 없는지로 성공을
검증합니다 — 라이브 소스의 현재 객체 수/바이트를 아카이브와 직접 비교하지 않습니다. 그
비교는 업로드와 검증 사이에 소스의 일별 백업이 만료되는 등 정상적인 이유로도 어긋날 수
있어 아카이브가 잘못됐다는 뜻이 아닐 수 있기 때문입니다.

### 3. 복원 리허설 (워크샵 계정이 아직 살아있을 때 권장)
ClickHouse 인스턴스를 아카이브 버킷을 가리키게 설정하고 실제 복원이 되는지 확인합니다 —
아카이브가 실제로 쓸 수 있는지 확인하는 유일한 방법입니다.

`RESTORE ... FROM S3(...)`는 **백업 시점에 백업 안에 함께 캡처된 DDL**로 테이블을
재생성합니다 — 이 스크립트가 함께 올리는 `schema/clickhouse-schema.sql` 사본을 포함해 외부
스키마 파일은 전혀 참조하지 않습니다. 캡처된 DDL은 `ReplicatedMergeTree`/
`ReplicatedAggregatingMergeTree`이므로(`infra/files/clickhouse-schema-replicated.sql`),
Keeper가 없는 단일 노드(`dashboard/docker-compose.yml` 그대로)에서는 `RESTORE`가 그대로
실패합니다. 실제로 리허설하는 방법은 두 가지입니다:

**옵션 A — 동일한 인프라 위에 복원.** `infra/clickhouse.tf`와 같은 모양(동일 macros)의
스크래치 Keeper + replicated ClickHouse를 세우고:
```sql
RESTORE DATABASE claude_code
  FROM S3('https://<아카이브버킷>.s3.<리전>.amazonaws.com/<아카이브프리픽스>/backup/final-<타임스탬프>',
          '<ACCESS_KEY_ID>', '<SECRET_ACCESS_KEY>');
  -- 리허설 전용 — 가능하면 단기 임시 자격증명, 사용 후 폐기.
  -- 장기 IAM 사용자 키가 아니라 STS 임시 자격증명을 쓴다면, ClickHouse S3()는 4번째
  -- 위치 인자로 세션 토큰을 받습니다:
  --   S3('<url>', '<ACCESS_KEY_ID>', '<SECRET_ACCESS_KEY>', '<SESSION_TOKEN>')
```
가장 충실하지만 준비가 가장 많이 필요합니다.

**옵션 B — `allow_different_table_def`로 단일 노드에 복원.** 대상 테이블을 미리
non-replicated 엔진으로 직접 만들어 둡니다(`ReplicatedMergeTree(...)` → `MergeTree()`,
`ReplicatedAggregatingMergeTree(...)` → `AggregatingMergeTree()`로 바꾸고 `ON CLUSTER`/keeper
경로 인자는 제거 — **컬럼 정의뿐 아니라 partition/order key도 정확히 일치**해야 합니다:
`PARTITION BY`가 다르면 파트에 박힌 partition ID와 새로 계산한 ID가 달라 `RESTORE`가
`CORRUPTED_DATA`로 실패합니다 — 검증 중 실제로 겪고 고친 문제입니다, 아래 참고 참조).
`RESTORE DATABASE`는 백업 안의 모든 테이블을 복원하므로, 테이블 하나가 아니라 **전부**
이 방식으로 미리 만들어야 합니다 — 작성 시점 기준 `otel_logs`, `otel_metrics_gauge`,
`otel_metrics_sum`, `otel_metrics_sum_hourly` 4개입니다(`SELECT table FROM system.replicas
WHERE database = 'claude_code'`로 실측 확인). 하나라도 빠뜨리면 `RESTORE`가 그 테이블만
백업에 캡처된 replicated DDL로 새로 만들려다 실패합니다 — 애초에 이 옵션을 쓰는 이유와
같은 문제입니다:
```sql
-- 1. claude_code와 4개 테이블 전부를 non-replicated 엔진으로 먼저 생성. 컬럼 목록은
--    clickhouse-schema.sql(schema/ 아래 업로드된 사본)과 동일하게 두고 ENGINE/PARTITION
--    BY/ORDER BY만 바꿉니다. otel_metrics_sum_hourly에서 실제로 검증된 값(나머지 세
--    테이블도 clickhouse-schema.sql의 PARTITION BY / ORDER BY를 그대로 옮겨 적용):
CREATE TABLE claude_code.otel_metrics_sum_hourly (
  -- ... clickhouse-schema.sql과 동일한 컬럼 ...
)
  ENGINE = AggregatingMergeTree()
  PARTITION BY toYYYYMM(hour)
  ORDER BY (MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality, Model,
            TokenType, Decision, SkillName, ToolName, hour);
-- ... otel_logs, otel_metrics_gauge, otel_metrics_sum도 동일하게 반복 ...

-- 2. 그 다음 방금 만든 테이블에 복원:
RESTORE DATABASE claude_code
  FROM S3('https://<아카이브버킷>.s3.<리전>.amazonaws.com/<아카이브프리픽스>/backup/final-<타임스탬프>',
          '<ACCESS_KEY_ID>', '<SECRET_ACCESS_KEY>')
  SETTINGS allow_different_table_def = 1, allow_non_empty_tables = 1;

SHOW CREATE TABLE claude_code.otel_metrics_sum;  -- materialized SeriesKey가 살아있는지 확인
-- AggregatingMergeTree/otel_metrics_sum_hourly의 행수는 백그라운드 merge로 파트가
-- collapse되면서 소스와 자연히 달라질 수 있습니다(데이터가 온전해도) — count() 일치는
-- 우연일 수 있고 불일치가 곧 문제라는 뜻도 아닙니다. 더 이상 쓰기가 없는 구간을 잡아
-- 디코딩한 집계 값으로 비교하세요.
-- 집계 컬럼은 행수만으론 부족하고 값 디코딩까지 확인해야 합니다. 이 스키마는
-- SimpleAggregateFunction을 쓰므로 sumMerge()가 아니라 그냥 sum()으로 디코딩합니다
-- (sumMerge는 AggregateFunction 컬럼용이라 SimpleAggregateFunction엔
-- ILLEGAL_TYPE_OF_ARGUMENT 에러가 납니다):
SELECT round(sum(sum_value)) FROM claude_code.otel_metrics_sum_hourly WHERE hour < '<cutoff-no-longer-being-written-to>';
```

이 절차를 실제로 마지막에 실행한 날짜를 기록해 두세요(`incident-response.md`의 "최종
검증일" 관례와 동일) — 실제로 안 돌려본 복원 절차는 계획이 아니라 가설일 뿐입니다.

**최종 검증일: 2026-07-27** — 워크샵 클러스터에서 실제로
`BACKUP TABLE claude_code.otel_metrics_sum_hourly TO S3(...)`를 뜬 뒤, 같은 클러스터의
스크래치 DB에 옵션 B 방식으로 복원했습니다. 소스 테이블의 불변 구간에서 행수와
`sum(sum_value)`가 정확히 일치했습니다(658,942행, 합계 859774746755734). 프로브 산출물과
스크래치 DB는 이후 삭제했습니다. 전체 `DATABASE` 복원과 옵션 A는 별도로 리허설하지
않았습니다 — 의존하기 전에 다시 검증하세요.

## 참고
- `backup/` 프리픽스만 아카이브합니다. **`cold/` 아래는 절대 이관하거나 만료시키지
  마세요** — 이 프리픽스는 `hot_cold` storage policy가 TTL로 내린 살아있는 테이블 데이터를
  content-addressed blob으로 담고 있고(실측 2026-07-27: `cold/aaa/bzscpvamwnobmdnxgdzxliguiekpl`
  형태 키, `backup/` 하위 경로 없음), 키만 봐서는 "백업 blob"과 "살아있는 데이터 blob"을
  구분할 수 없습니다. `BACKUP DATABASE`는 백업 시점에 파트가 어느 디스크에 있든 논리적으로
  이미 포함하므로 별도로 복사할 필요가 없고, `cold/`에 라이프사이클을 걸면 라이브 클러스터의
  cold tier 데이터가 손상됩니다.
- `otel_metrics_sum_hourly`는 백업에 포함되지만, `scripts/backfill-hourly-rollup.sh`는 rollup
  테이블에 최소 1행이 있어야 동작합니다(완전히 비어 있으면 no-op) — 완전 손실 상황에서는
  백업된 rollup 데이터 자체를 대체할 수 없으니 재생성 가능성을 과신하지 마세요.
- 이 레포에서 named AWS CLI 프로필(`--profile`, 워크샵 계정 쪽에만)을 처음 쓰는 스크립트입니다
  (기존엔 앰비언트 자격증명 체인이나 클러스터 내 IRSA만 사용) — 더 늘어나면
  `docs/reference/iac.md` 참고.
- 아카이브에는 소스 클러스터의 90/180일 TTL을 넘어서도 `otel_logs`/`otel_metrics_sum`의
  `UserEmail` 등 PII/세션 데이터가 무기한 그대로 남습니다 — 스크립트가 업로드 전 아카이브
  버킷의 Public Access Block을 강제하고 `--sse AES256`으로 암호화하지만, 필요하다면 아카이브
  버킷 자체의 보존/삭제 정책을 별도로 정하세요.
- `infra/s3.tf`의 라이프사이클 규칙은 `main`에서부터 이미 prefix `backup/`을 필터링하고
  있었고, 이 PR은 그 값을 바꾸지 않습니다. 실제로 바뀌는 건 백업이 쓰이는 위치입니다 — 이
  PR의 `infra/clickhouse.tf` 변경 전에는 백업이 `Disk('cold_s3', ...)`로 갔고, 위 실측대로
  `backup/`에는 애초에 아무것도 쓰이지 않아 필터 값과 무관하게 만료시킬 대상이 없었습니다.
  이 PR 이후 `BACKUP ... TO S3(...)`가 `backup/` 아래에 실제 객체를 쓰기 시작하면서, 원래
  있던 필터가 처음으로 매칭 대상을 갖게 됩니다.
- **왜 `S3(...)`이고 `Disk('cold_s3', ...)`가 아닌가**: 2026-07-27 워크샵 클러스터를 실측한
  결과 — `aws s3 ls --recursive s3://cc-ab-clickhouse-<acct>-<region>/cold/`는 랜덤 blob
  키뿐이었고 `cold/backup/` 아래는 0건 매칭; 실제 백업 매니페스트는 ClickHouse 파드의 로컬
  디스크 metadata(`/var/lib/clickhouse/disks/cold_s3/backup/<날짜>/`)에만 존재했습니다.
  이어서 `BACKUP ... TO S3(...)`를 종단 검증했습니다: 파드 IRSA 자격증명
  (`use_environment_credentials`, 추가 설정 불필요) 그대로 실제 논리 경로
  (`<프리픽스>/data/claude_code/<테이블>/<파트>/<컬럼>.bin`, `<프리픽스>/.backup`)에 객체를
  만들고, 그 객체에서 복원한 결과가 소스 테이블과 정확히 일치했습니다(위 "최종 검증일"
  참조). 이 수정 전(`Disk('cold_s3', ...)`)의 일별 백업을 갖고 있는 클러스터라면 그 백업들은
  **이관 대상이 아닙니다** — 파드 PVC에 의존하고 계정 삭제와 함께 어차피 사라집니다.
  `infra/clickhouse.tf`의 CronJob 변경이 적용된 이후에 뜬 백업만 이 스크립트가 닿을 수 있는
  `backup/` 아래에 남습니다.
