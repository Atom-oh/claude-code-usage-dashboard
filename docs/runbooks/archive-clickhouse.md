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
`Disk('cold_s3', 'backup/...')` resolves to that path, not a bucket-root `backup/`. The parent
`backup/` prefix (i.e. `cold/backup/`) has a 30-day expiry lifecycle (`infra/s3.tf`), and both
disappear with the account regardless of the lifecycle timer. `scripts/archive-clickhouse.sh`
takes one more `BACKUP DATABASE` snapshot, then copies the entire `cold/backup/` prefix out to
a bucket in your own (permanent) AWS account.

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
- Local disk space for the **entire `cold/backup/` prefix**, not just one backup — the sync
  pulls every daily backup still inside the 30-day window plus the new final one, so budget
  for up to ~30x a single backup's size (sized like `otel_metrics_sum` — see
  `docs/architecture.md` for current row counts). Running out of disk here with no time left
  before teardown is unrecoverable — check free space generously before the full run.

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
the only way to be sure the archive is actually usable. **The backed-up DDL uses
`ReplicatedMergeTree`** (`infra/files/clickhouse-schema-replicated.sql`), so a plain single-node
`dashboard/docker-compose.yml` instance cannot `RESTORE` it directly — either stand up a
Keeper + replicated instance matching `infra/clickhouse.tf`'s shape, or rewrite the schema's
engine clauses to non-replicated `MergeTree`/`AggregatingMergeTree` equivalents first (the
column/materialized definitions are otherwise identical to `clickhouse-schema.sql`):
```xml
<!-- config.d/storage.xml -->
<clickhouse>
  <storage_configuration>
    <disks>
      <archive_s3>
        <type>s3</type>
        <endpoint>https://<your-bucket>.s3.<region>.amazonaws.com/clickhouse-ab-workshop/</endpoint>
        <access_key_id>...</access_key_id>
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
RESTORE DATABASE claude_code FROM Disk('archive_s3', 'backup/final-<timestamp>');
SELECT count() FROM claude_code.otel_metrics_sum;
SHOW CREATE TABLE claude_code.otel_metrics_sum;  -- confirm materialized SeriesKey survived
```

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
- Follow-up worth filing separately: `infra/s3.tf`'s lifecycle rule filters on prefix
  `backup/`, but actual backup objects live under `cold/backup/` — the rule as written may
  never match anything, meaning daily backups might not actually be expiring after 30 days.

---

<a id="korean"></a>

# 한국어

## 개요
워크샵 AWS 계정이 삭제될 예정입니다. ClickHouse 백업은 그 계정의 S3 버킷
`cc-ab-clickhouse-<워크샵계정ID>-<리전>`의 `cold/backup/` 아래에만 존재합니다 — `cold_s3`
디스크의 endpoint 자체가 이미 `/cold/`로 끝나므로(`infra/clickhouse.tf`) `Disk('cold_s3',
'backup/...')`는 버킷 루트의 `backup/`이 아니라 이 경로로 해석됩니다. 상위 `backup/`
프리픽스(즉 `cold/backup/`)엔 30일 만료 라이프사이클이 걸려 있고(`infra/s3.tf`), 둘 다
라이프사이클 타이머와 무관하게 계정이 사라지면 같이 사라집니다. `scripts/archive-clickhouse.sh`는
`BACKUP DATABASE` 스냅샷을 한 번 더 뜨고 `cold/backup/` 프리픽스 전체를 내 계정(영구) S3
버킷으로 복사합니다.

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
- **백업 1개가 아니라 `cold/backup/` 프리픽스 전체** 분량의 로컬 디스크 여유 공간 — sync는
  30일 창 안에 아직 남아있는 일별 백업 전부 + 새 final 백업을 받으므로, 백업 1개 크기의
  최대 ~30배를 여유로 잡으세요(`otel_metrics_sum` 규모 기준 — 현재 행 수는
  `docs/architecture.md` 참고). 계정 소멸 직전 여기서 디스크가 부족해지면 만회할 시간이
  없습니다 — 전체 실행 전에 여유 공간을 넉넉히 확인하세요.

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
아카이브가 실제로 쓸 수 있는지 확인하는 유일한 방법입니다. **백업된 DDL은
`ReplicatedMergeTree`를 씁니다**(`infra/files/clickhouse-schema-replicated.sql`) — 그래서 단일
노드인 `dashboard/docker-compose.yml`로는 바로 `RESTORE`할 수 없습니다. Keeper + replicated
구성을 `infra/clickhouse.tf`와 같은 모양으로 세우거나, 먼저 스키마의 엔진 절만 non-replicated
`MergeTree`/`AggregatingMergeTree`로 바꿔야 합니다(컬럼·materialized 정의는
`clickhouse-schema.sql`과 동일):
```xml
<!-- config.d/storage.xml -->
<clickhouse>
  <storage_configuration>
    <disks>
      <archive_s3>
        <type>s3</type>
        <endpoint>https://<내버킷>.s3.<리전>.amazonaws.com/clickhouse-ab-workshop/</endpoint>
        <access_key_id>...</access_key_id>
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
RESTORE DATABASE claude_code FROM Disk('archive_s3', 'backup/final-<타임스탬프>');
SELECT count() FROM claude_code.otel_metrics_sum;
SHOW CREATE TABLE claude_code.otel_metrics_sum;  -- materialized SeriesKey가 살아있는지 확인
```

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
- 별도로 이슈화할 만한 후속 발견: `infra/s3.tf`의 라이프사이클 규칙은 prefix `backup/`을
  필터링하지만 실제 백업 객체는 `cold/backup/` 아래에 있습니다 — 규칙이 아무것도 매칭하지
  않아 일별 백업이 실제로는 30일 후에도 만료되지 않고 있을 가능성이 있습니다.
