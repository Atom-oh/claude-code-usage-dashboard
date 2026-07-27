# Runbook: Permanent ClickHouse Archive Before Account Teardown

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Overview
The workshop AWS account will be deleted. The only ClickHouse backups live in that account's
S3 bucket (`cc-ab-clickhouse-<workshop-account-id>-<region>/backup/`) with a 30-day expiry
lifecycle (`infra/s3.tf`), and they disappear with the account regardless of the lifecycle
timer. `scripts/archive-clickhouse.sh` takes one more `BACKUP DATABASE` snapshot, then copies
the entire `backup/` prefix out to a bucket in your own (permanent) AWS account.

## When to Use
Once, shortly before the workshop account is torn down. Re-runnable if a prior run failed
partway (set `SKIP_BACKUP=1` to skip re-taking the snapshot and just re-sync).

## Prerequisites
- `~/.aws/credentials` with a profile for the workshop account:
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
- Local disk space for one ClickHouse backup (sized like `otel_metrics_sum` — see
  `docs/architecture.md` for current row counts).

## Procedure

### 1. Dry run (no live backup, just move what already exists)
```bash
ARCHIVE_BUCKET=my-permanent-bucket SKIP_BACKUP=1 ./scripts/archive-clickhouse.sh
```
Confirms both AWS profiles work, the source bucket name resolves correctly, and sync +
verification succeed — before spending time on a fresh multi-GB backup.

### 2. Full run
```bash
ARCHIVE_BUCKET=my-permanent-bucket ./scripts/archive-clickhouse.sh
```
This takes a fresh `BACKUP DATABASE claude_code TO Disk('cold_s3', 'backup/final-<UTC
timestamp>')` inside the cluster (same mechanism as the daily `clickhouse-backup` CronJob in
`infra/clickhouse.tf`), then syncs the whole `backup/` prefix — including the still-live daily
backups — plus a copy of the schema files to
`s3://$ARCHIVE_BUCKET/$ARCHIVE_PREFIX/` (default prefix `clickhouse-ab-workshop`).

The script verifies object count and total bytes match between source and destination and
exits non-zero if they don't.

### 3. Restore rehearsal (recommended while the workshop account is still alive)
Point a local ClickHouse (e.g. `dashboard/docker-compose.yml`) at the archive bucket and
confirm a real restore works — this is the only way to be sure the archive is actually usable:
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
- Only the `backup/` prefix is archived — the `cold/` prefix (TTL-moved parts) doesn't need a
  separate copy, `BACKUP DATABASE` already captures those parts logically regardless of which
  disk they physically sit on.
- `otel_metrics_sum_hourly` is included in the backup but is fully derivable from
  `otel_metrics_sum` via `scripts/backfill-hourly-rollup.sh` if ever lost — it's not the
  precious data.
- This is the first script in the repo to use a named AWS CLI profile (`--profile`, for the
  workshop side only) rather than purely the ambient credential chain or in-cluster IRSA — see
  `docs/reference/iac.md` if adding more.

---

<a id="korean"></a>

# 한국어

## 개요
워크샵 AWS 계정이 삭제될 예정입니다. ClickHouse 백업은 그 계정의 S3 버킷
(`cc-ab-clickhouse-<워크샵계정ID>-<리전>/backup/`)에만 존재하고 30일 만료 라이프사이클이
걸려 있습니다(`infra/s3.tf`) — 라이프사이클 타이머와 무관하게 계정이 사라지면 같이 사라집니다.
`scripts/archive-clickhouse.sh`는 `BACKUP DATABASE` 스냅샷을 한 번 더 뜨고 `backup/` 프리픽스
전체를 내 계정(영구) S3 버킷으로 복사합니다.

## 사용 시점
워크샵 계정이 삭제되기 직전 1회. 이전 실행이 중간에 실패했다면 재실행 가능(`SKIP_BACKUP=1`로
새 스냅샷 없이 재동기화만).

## 사전 준비
- `~/.aws/credentials`에 워크샵 계정 프로필 1개:
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
- ClickHouse 백업 1개 분량의 로컬 디스크 여유 공간.

## 절차

### 1. 드라이런 (새 백업 없이 기존 것만 이관)
```bash
ARCHIVE_BUCKET=my-permanent-bucket SKIP_BACKUP=1 ./scripts/archive-clickhouse.sh
```
새로 몇 GB짜리 백업을 뜨기 전에 두 AWS 프로필이 정상 동작하는지, 소스 버킷 이름이 올바르게
계산되는지, sync·검증이 통과하는지 먼저 확인합니다.

### 2. 전체 실행
```bash
ARCHIVE_BUCKET=my-permanent-bucket ./scripts/archive-clickhouse.sh
```
클러스터 안에서 새 `BACKUP DATABASE claude_code TO Disk('cold_s3', 'backup/final-<UTC
타임스탬프>')`를 실행하고(`infra/clickhouse.tf`의 일별 `clickhouse-backup` CronJob과 동일한
메커니즘), `backup/` 프리픽스 전체(아직 살아있는 일별 백업 포함)와 스키마 파일 사본을
`s3://$ARCHIVE_BUCKET/$ARCHIVE_PREFIX/`(기본 프리픽스 `clickhouse-ab-workshop`)로 동기화합니다.

스크립트는 소스/대상의 객체 수와 총 바이트가 일치하는지 검증하고, 불일치 시 non-zero로
종료합니다.

### 3. 복원 리허설 (워크샵 계정이 아직 살아있을 때 권장)
로컬 ClickHouse(예: `dashboard/docker-compose.yml`)를 아카이브 버킷을 가리키게 설정하고 실제
복원이 되는지 확인합니다 — 아카이브가 실제로 쓸 수 있는지 확인하는 유일한 방법입니다:
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
- `backup/` 프리픽스만 아카이브합니다 — `cold/` 프리픽스(TTL로 이동된 파트)는 별도로 옮길
  필요가 없습니다. `BACKUP DATABASE`는 파트가 어느 디스크에 있든 논리적으로 이미 포함합니다.
- `otel_metrics_sum_hourly`는 백업에 포함되지만, 잃어도 `scripts/backfill-hourly-rollup.sh`로
  원본에서 재생성 가능한 데이터입니다 — 지켜야 할 원본은 아닙니다.
- 이 레포에서 named AWS CLI 프로필(`--profile`, 워크샵 계정 쪽에만)을 처음 쓰는 스크립트입니다
  (기존엔 앰비언트 자격증명 체인이나 클러스터 내 IRSA만 사용) — 더 늘어나면
  `docs/reference/iac.md` 참고.
