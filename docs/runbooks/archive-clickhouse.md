# Runbook: Permanent ClickHouse Archive Before Account Teardown

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Overview
The workshop AWS account will be deleted. The only ClickHouse backups live in that account's
S3 bucket, under `cc-ab-clickhouse-<workshop-account-id>-<region>/cold/backup/` — the
`cold_s3` disk's endpoint already ends in `/cold/` (`infra/clickhouse.tf`), so
`Disk('cold_s3', 'backup/...')` resolves to that path, not a bucket-root `backup/`. That
prefix has a 30-day expiry lifecycle (`infra/s3.tf`), and everything disappears with the
account regardless of the lifecycle timer. `scripts/archive-clickhouse.sh` takes one more
`BACKUP DATABASE` snapshot, then copies the entire `cold/backup/` prefix out to a bucket in
your own (permanent) AWS account.

## When to Use
Once, shortly before the workshop account is torn down. Re-runnable if a prior run failed
partway (set `SKIP_BACKUP=1` to skip re-taking the snapshot and just re-sync).

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
- A pre-existing S3 bucket in your own account to hold the archive (`ARCHIVE_BUCKET`), and
  `s3:PutObject`/`s3:ListBucket` on it for whichever identity the destination side resolves to
  (the script prints that account ID in step 1 — check it before the long sync starts).
- `kubectl` context `fsi-demo-cluster`, access to namespace `claude-code` (same as
  [`incident-response.md`](incident-response.md)).
- Local disk space for the **entire `cold/backup/` prefix**, not just one backup. Don't
  estimate this from the "~30 days of backups" assumption — the lifecycle rule that's supposed
  to expire that prefix after 30 days had a prefix mismatch bug (fixed in this same PR; see
  Notes), so backups may have accumulated unbounded for longer than 30 days depending on when
  it's applied. The script measures the real source size with `aws s3 ls --summarize` and
  compares it against free space on `LOCAL_DIR` before doing anything destructive-adjacent —
  but if that preflight check fails, don't just add disk and retry blindly; check *why* the
  prefix is larger than expected first.

## Procedure

### 1. Sync-only run (no live backup, just move what already exists)
```bash
ARCHIVE_BUCKET=my-permanent-bucket SKIP_BACKUP=1 ./scripts/archive-clickhouse.sh
```
This still downloads and uploads real data — it just skips taking a fresh snapshot. Use it to
confirm both AWS identities work, the source bucket/prefix resolve correctly, and sync +
verification succeed before spending time (and disk) on a new multi-GB backup.

### 2. Full run
```bash
ARCHIVE_BUCKET=my-permanent-bucket ./scripts/archive-clickhouse.sh
```
This takes a fresh `BACKUP DATABASE claude_code TO Disk('cold_s3', 'backup/final-<UTC
timestamp>')` inside the cluster (same mechanism as the daily `clickhouse-backup` CronJob in
`infra/clickhouse.tf`), then syncs the whole `cold/backup/` prefix — including the still-live
daily backups — plus a copy of the schema files to
`s3://$ARCHIVE_BUCKET/$ARCHIVE_PREFIX/` (default prefix `clickhouse-ab-workshop`).

The script verifies object count, total bytes, and schema-file count match between source and
destination and exits non-zero if they don't.

### 3. Restore rehearsal (recommended while the workshop account is still alive)
Point a ClickHouse instance at the archive bucket and confirm a real restore works — this is
the only way to be sure the archive is actually usable.

`RESTORE DATABASE ... FROM Disk(...)` recreates tables using the DDL captured **inside the
backup itself** at backup time — it ignores any external schema file, including the
`schema/clickhouse-schema.sql` copy this script uploads alongside it. That captured DDL is
`ReplicatedMergeTree` with `storage_policy = 'hot_cold'`
(`infra/files/clickhouse-schema-replicated.sql`), so a plain single-node instance with no
Keeper and no `hot_cold` storage policy — like `dashboard/docker-compose.yml` as-is — will
fail a straight `RESTORE`. Two ways to actually rehearse it:

**Option A — restore onto matching infra.** Stand up a scratch Keeper + replicated ClickHouse
matching `infra/clickhouse.tf`'s shape (same macros, same `hot_cold` policy) and run
`RESTORE DATABASE claude_code FROM Disk('archive_s3', 'backup/final-<timestamp>')` unmodified.
Most faithful, most setup.

**Option B — restore onto a single node with `allow_different_table_def`.** Create the target
tables yourself first using non-replicated engines (swap `ReplicatedMergeTree(...)` for
`MergeTree()`, `ReplicatedAggregatingMergeTree(...)` for `AggregatingMergeTree()`, drop the
`ON CLUSTER`/keeper-path arguments — column and materialized-column definitions are otherwise
identical to `clickhouse-schema.sql`), then restore data into those pre-existing tables instead
of letting `RESTORE` create them from the embedded DDL:
```xml
<!-- config.d/storage.xml -->
<clickhouse>
  <storage_configuration>
    <disks>
      <archive_s3>
        <type>s3</type>
        <endpoint>https://<your-bucket>.s3.<region>.amazonaws.com/clickhouse-ab-workshop/</endpoint>
        <access_key_id>...</access_key_id>   <!-- rehearsal only — prefer IAM role/temp creds where possible, revoke/rotate after -->
        <secret_access_key>...</secret_access_key>
      </archive_s3>
    </disks>
  </storage_configuration>
  <backups>
    <allowed_disk>archive_s3</allowed_disk>
  </backups>
</clickhouse>
```
```sql
-- 1. Create claude_code and its tables first, using non-replicated engines
--    (adapted from clickhouse-schema.sql, uploaded alongside the backup under schema/).
-- 2. Then restore into the tables you just created:
RESTORE DATABASE claude_code FROM Disk('archive_s3', 'backup/final-<timestamp>')
  SETTINGS allow_different_table_def = 1;
SELECT count() FROM claude_code.otel_metrics_sum;
SHOW CREATE TABLE claude_code.otel_metrics_sum;  -- confirm materialized SeriesKey survived
```
Record the date this was last actually run (following `incident-response.md`'s "Last
verified" convention) — an untested restore procedure is a hypothesis, not a plan.

## Notes
- Only the `cold/backup/` prefix is archived — TTL-moved *table data* parts living elsewhere
  under `cold/` don't need a separate copy, `BACKUP DATABASE` already captures those parts
  logically regardless of which disk they physically sit on at backup time.
- `otel_metrics_sum_hourly` is included in the backup, but note it is only derivable from
  `otel_metrics_sum` via `scripts/backfill-hourly-rollup.sh` when the rollup table already has
  at least one row (that script no-ops on a fully empty table) — don't rely on it as a full
  substitute for the archived rollup data itself.
- This is the first script in the repo to use a named AWS CLI profile (`--profile`, for the
  workshop side only) rather than purely the ambient credential chain or in-cluster IRSA — see
  `docs/reference/iac.md` if adding more.
- Archived data retains whatever PII/session data was in `otel_logs`/`otel_metrics_sum`
  (e.g. `UserEmail`) beyond the source cluster's 90/180-day TTLs — decide a retention/deletion
  policy for the archive bucket itself if this matters for your use case.
- `infra/s3.tf`'s lifecycle rule used to filter on prefix `backup/`, which never matched the
  real object path `cold/backup/` — fixed in this same change (see the `s3.tf` diff). Before
  that fix, daily backups may have accumulated unbounded rather than expiring after 30 days as
  intended; if you're archiving from a cluster running the old rule, expect the source prefix
  to be larger than "30 days of dailies."

---

<a id="korean"></a>

# 한국어

## 개요
워크샵 AWS 계정이 삭제될 예정입니다. ClickHouse 백업은 그 계정의 S3 버킷
`cc-ab-clickhouse-<워크샵계정ID>-<리전>`의 `cold/backup/` 아래에만 존재합니다 — `cold_s3`
디스크의 endpoint 자체가 이미 `/cold/`로 끝나므로(`infra/clickhouse.tf`) `Disk('cold_s3',
'backup/...')`는 버킷 루트의 `backup/`이 아니라 이 경로로 해석됩니다. 이 프리픽스엔 30일
만료 라이프사이클이 걸려 있고(`infra/s3.tf`), 라이프사이클 타이머와 무관하게 계정이
사라지면 모두 같이 사라집니다. `scripts/archive-clickhouse.sh`는 `BACKUP DATABASE` 스냅샷을
한 번 더 뜨고 `cold/backup/` 프리픽스 전체를 내 계정(영구) S3 버킷으로 복사합니다.

## 사용 시점
워크샵 계정이 삭제되기 직전 1회. 이전 실행이 중간에 실패했다면 재실행 가능(`SKIP_BACKUP=1`로
새 스냅샷 없이 재동기화만).

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
  시작되기 전에 확인하세요).
- `kubectl` context `fsi-demo-cluster`, 네임스페이스 `claude-code` 접근 권한
  ([`incident-response.md`](incident-response.md)와 동일).
- **백업 1개가 아니라 `cold/backup/` 프리픽스 전체** 분량의 로컬 디스크 여유 공간. "30일치
  백업"이라는 가정으로 용량을 추정하지 마세요 — 이 프리픽스를 30일 후 만료시켜야 할
  라이프사이클 규칙 자체가 prefix 불일치 버그로 실제 경로에 매칭되지 않고 있었습니다(이번
  변경에서 함께 수정 — 아래 참고 및 `s3.tf` diff 참조). 그 버그가 적용되기 전이었다면
  백업이 30일보다 훨씬 오래 무제한 누적됐을 수 있습니다. 스크립트는 실제 소스 크기를
  `aws s3 ls --summarize`로 측정해 `LOCAL_DIR`의 여유 공간과 비교한 뒤에만 진행합니다 — 이
  사전 점검에서 실패하면 무작정 디스크만 늘려 재시도하지 말고 왜 프리픽스가 예상보다 큰지
  먼저 확인하세요.

## 절차

### 1. 이관만 실행 (새 백업 없이 기존 것만 이관)
```bash
ARCHIVE_BUCKET=my-permanent-bucket SKIP_BACKUP=1 ./scripts/archive-clickhouse.sh
```
이름과 달리 실제로 데이터를 내리고 올립니다 — 새 스냅샷만 안 뜰 뿐입니다. 새로 몇 GB짜리
백업을 뜨기 전에(디스크도 아끼면서) 두 AWS 자격증명이 정상 동작하는지, 소스 버킷/프리픽스가
올바르게 계산되는지, sync·검증이 통과하는지 먼저 확인하는 용도입니다.

### 2. 전체 실행
```bash
ARCHIVE_BUCKET=my-permanent-bucket ./scripts/archive-clickhouse.sh
```
클러스터 안에서 새 `BACKUP DATABASE claude_code TO Disk('cold_s3', 'backup/final-<UTC
타임스탬프>')`를 실행하고(`infra/clickhouse.tf`의 일별 `clickhouse-backup` CronJob과 동일한
메커니즘), `cold/backup/` 프리픽스 전체(아직 살아있는 일별 백업 포함)와 스키마 파일 사본을
`s3://$ARCHIVE_BUCKET/$ARCHIVE_PREFIX/`(기본 프리픽스 `clickhouse-ab-workshop`)로 동기화합니다.

스크립트는 소스/대상의 객체 수, 총 바이트, 스키마 파일 수가 일치하는지 검증하고, 불일치 시
non-zero로 종료합니다.

### 3. 복원 리허설 (워크샵 계정이 아직 살아있을 때 권장)
ClickHouse 인스턴스를 아카이브 버킷을 가리키게 설정하고 실제 복원이 되는지 확인합니다 —
아카이브가 실제로 쓸 수 있는지 확인하는 유일한 방법입니다.

`RESTORE DATABASE ... FROM Disk(...)`는 **백업 시점에 백업 안에 함께 캡처된 DDL**로 테이블을
재생성합니다 — 이 스크립트가 함께 올리는 `schema/clickhouse-schema.sql` 사본을 포함해 외부
스키마 파일은 전혀 참조하지 않습니다. 캡처된 DDL은 `storage_policy = 'hot_cold'`가 걸린
`ReplicatedMergeTree`이므로(`infra/files/clickhouse-schema-replicated.sql`), Keeper도
`hot_cold` storage policy도 없는 단일 노드(`dashboard/docker-compose.yml` 그대로)에서는
`RESTORE`가 그대로 실패합니다. 실제로 리허설하는 방법은 두 가지입니다:

**옵션 A — 동일한 인프라 위에 복원.** `infra/clickhouse.tf`와 같은 모양(동일 macros, 동일
`hot_cold` policy)의 스크래치 Keeper + replicated ClickHouse를 세우고
`RESTORE DATABASE claude_code FROM Disk('archive_s3', 'backup/final-<타임스탬프>')`를 그대로
실행합니다. 가장 충실하지만 준비가 가장 많이 필요합니다.

**옵션 B — `allow_different_table_def`로 단일 노드에 복원.** 대상 테이블을 미리
non-replicated 엔진으로 직접 만들어 둡니다(`ReplicatedMergeTree(...)` → `MergeTree()`,
`ReplicatedAggregatingMergeTree(...)` → `AggregatingMergeTree()`로 바꾸고 `ON CLUSTER`/keeper
경로 인자는 제거 — 컬럼·materialized 컬럼 정의는 `clickhouse-schema.sql`과 동일). 그 다음
`RESTORE`가 DDL로 새로 테이블을 만들게 하지 않고, 이미 만든 테이블에 데이터만 복원하게
합니다:
```xml
<!-- config.d/storage.xml -->
<clickhouse>
  <storage_configuration>
    <disks>
      <archive_s3>
        <type>s3</type>
        <endpoint>https://<내버킷>.s3.<리전>.amazonaws.com/clickhouse-ab-workshop/</endpoint>
        <access_key_id>...</access_key_id>   <!-- 리허설 전용 — 가능하면 IAM role/임시 자격증명, 사용 후 폐기/회전 -->
        <secret_access_key>...</secret_access_key>
      </archive_s3>
    </disks>
  </storage_configuration>
  <backups>
    <allowed_disk>archive_s3</allowed_disk>
  </backups>
</clickhouse>
```
```sql
-- 1. claude_code와 테이블들을 non-replicated 엔진으로 먼저 생성
--    (schema/ 아래 업로드된 clickhouse-schema.sql을 바탕으로 수정).
-- 2. 그 다음 방금 만든 테이블에 복원:
RESTORE DATABASE claude_code FROM Disk('archive_s3', 'backup/final-<타임스탬프>')
  SETTINGS allow_different_table_def = 1;
SELECT count() FROM claude_code.otel_metrics_sum;
SHOW CREATE TABLE claude_code.otel_metrics_sum;  -- materialized SeriesKey가 살아있는지 확인
```
이 절차를 실제로 마지막에 실행한 날짜를 기록해 두세요(`incident-response.md`의 "최종
검증일" 관례와 동일) — 실제로 안 돌려본 복원 절차는 계획이 아니라 가설일 뿐입니다.

## 참고
- `cold/backup/` 프리픽스만 아카이브합니다 — `cold/` 아래 다른 위치의 TTL 이동 테이블 파트는
  별도로 옮길 필요가 없습니다. `BACKUP DATABASE`는 백업 시점에 파트가 어느 디스크에 있든
  논리적으로 이미 포함합니다.
- `otel_metrics_sum_hourly`는 백업에 포함되지만, `scripts/backfill-hourly-rollup.sh`는 rollup
  테이블에 최소 1행이 있어야 동작합니다(완전히 비어 있으면 no-op) — 완전 손실 상황에서는
  백업된 rollup 데이터 자체를 대체할 수 없으니 재생성 가능성을 과신하지 마세요.
- 이 레포에서 named AWS CLI 프로필(`--profile`, 워크샵 계정 쪽에만)을 처음 쓰는 스크립트입니다
  (기존엔 앰비언트 자격증명 체인이나 클러스터 내 IRSA만 사용) — 더 늘어나면
  `docs/reference/iac.md` 참고.
- 아카이브에는 소스 클러스터의 90/180일 TTL을 넘어서도 `otel_logs`/`otel_metrics_sum`의
  `UserEmail` 등 PII/세션 데이터가 그대로 남습니다 — 필요하다면 아카이브 버킷 자체의
  보존/삭제 정책을 별도로 정하세요.
- `infra/s3.tf`의 라이프사이클 규칙은 원래 prefix `backup/`을 필터링했는데, 실제 객체 경로인
  `cold/backup/`과 매칭되지 않았습니다 — 이번 변경에서 함께 수정했습니다(`s3.tf` diff 참조).
  이 수정 전이라면 일별 백업이 30일로 만료되지 않고 무제한 누적됐을 수 있습니다 — 예전 규칙이
  적용된 클러스터에서 아카이브한다면 소스 프리픽스가 "30일치 일별 백업"보다 클 것으로
  예상하세요.
