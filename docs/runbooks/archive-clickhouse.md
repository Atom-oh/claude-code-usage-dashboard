# Runbook: Permanent ClickHouse Archive Before Account Teardown

## Purpose

`scripts/archive-clickhouse.sh` takes a final native `BACKUP DATABASE ... TO S3(...)`,
then copies the entire source `backup/` prefix and three schema/reference files to a
permanent account. Run from the repository root. The script does real backup/download/upload
operations; `SKIP_BACKUP=1` skips only snapshot creation, not data transfer.

`infra/clickhouse.tf` declares daily S3 backups, and `infra/s3.tf` declares 30-day expiry
for `backup/`. Inspect the deployed CronJob, actual objects, and lifecycle before relying
on them. Neither a checked-in declaration nor an old “applied/not applied” note proves
current backup coverage. The final-snapshot script does not require the daily CronJob to
have been updated first, but its own SQL, IRSA, and target bucket must work.

## When to use

Archive before source backups reach their actual expiry and once more immediately before
account teardown. With the declared 30-day lifecycle, leave a margin shorter than 30 days
between copies if daily snapshot history must survive. Configure a retention policy for the
archive itself deliberately: source ClickHouse TTLs do not delete archived copies, which
contain user identifiers and raw telemetry.

## Prerequisites

- `aws`, `kubectl`, Bash, standard Unix tools, and disk capacity for **all actual objects**
  under `backup/`, not a guessed number of days. The script measures size after the final
  snapshot and creates private temporary staging, removed on exit.
- A `WORKSHOP_PROFILE` (default `workshop`) for the source identity with S3 list/read access.
  Authenticate through the approved profile workflow; never place credential values in docs
  or logs. Source profile credentials and pod IRSA credentials serve different purposes.
- A pre-existing `ARCHIVE_BUCKET` in the permanent destination account. Destination identity
  uses the ambient chain unless `ARCHIVE_PROFILE` is set. Require list/write, ownership
  verification, and `s3:GetBucketPublicAccessBlock`; allow policy inspection to assess sharing.
  No destination `DeleteObject` permission is needed.
- Destination Public Access Block: all four settings enabled. Uploads use `--sse AES256`.
  Public blocking does not exclude specific external principals in a bucket policy; review
  the policy and treat permission failures as unknown, not “no policy.”
- Correct `KUBE_CONTEXT`, `NAMESPACE`, and source `REGION`. Script defaults are
  `fsi-demo-cluster`, `claude-code`, and `ap-northeast-2`; override them for the target.
  A wrong region changes the reconstructed source bucket name.
- Kubernetes pod listing/exec and read access to Secret `clickhouse-writer`, plus a healthy
  ClickHouse replica. The script requires one shard, synchronizes all tables discovered in
  `system.replicas` on its selected pod, then takes the backup on that same pod. Multi-shard
  archival is unsupported; do not bypass its guard.

The script checks both AWS identities and both bucket owners. Same-account copies require
`ARCHIVE_SAME_ACCOUNT_OK=1`, which defeats account-teardown protection if the account will
be deleted. Do not use that override for a permanent teardown archive.

For a complete final cutoff, stop new telemetry production, let collectors flush their
queues, then stop ingestion before synchronization/snapshot. A running collector can deliver
rows after synchronization; simply stopping it with a nonempty queue leaves those rows outside
the backup. Record the final raw timestamp before removing participant instances.

## Procedure

### 1. Inspect the source and destination

Use the inspection commands in [backup and restore](backup-and-restore.md).
Verify the target profile/context before executing the script:

```bash
: "${ARCHIVE_BUCKET:?Set the permanent destination bucket}"
: "${KUBE_CONTEXT:?Set the source ClickHouse context}"
: "${REGION:?Set the source bucket region}"
export ARCHIVE_BUCKET KUBE_CONTEXT REGION
export NAMESPACE=${NAMESPACE:-claude-code}
```

If existing self-contained backups are present, a sync-only run checks the copy path:

```bash
SKIP_BACKUP=1 ./scripts/archive-clickhouse.sh
```

An empty prefix fails verification. Older `Disk('cold_s3', ...)` backups do not create an
exportable `backup/` hierarchy: the `type=s3` disk retains logical-path metadata on the PVC
and stores random blobs under `cold/`. Copying those blobs alone is not a restore strategy.
Never expire/delete `cold/` objects; they can be live table parts.

### 2. Take the final snapshot and copy

```bash
./scripts/archive-clickhouse.sh
```

Optional script inputs are `WORKSHOP_PROFILE`, `ARCHIVE_PROFILE`, `ARCHIVE_PREFIX` (default
`clickhouse-ab-workshop`), and `LOCAL_DIR` (default `./ch-archive`). Set them before the run
when defaults are inappropriate. Destination uploads are append-only (`sync` without
`--delete`), so source expiry does not erase an earlier archive.

The final snapshot prefix is `backup/final-<UTC timestamp>`. A backup is a **set of objects**,
including `.backup`, captured metadata, and data parts; retain the entire snapshot prefix.
The script also copies `clickhouse-schema.sql`, `infra/files/clickhouse-schema-replicated.sql`,
and `grafana-ab-queries.sql`. These reference copies describe the checkout, not necessarily
the schema captured inside an older backup.

A successful upload dry run must show no pending copies from this run's staging directory.
This checks transfer completeness according to `aws s3 sync`, not full content integrity or
restore usability. It does not require the changing live source and append-only archive to
have identical counts. On partial failure, fix the cause and use `SKIP_BACKUP=1` to recopy;
no automatic rollback deletes destination data.

<a id="3-restore-rehearsal-recommended-while-the-workshop-account-is-still-alive"></a>
### 3. Restore rehearsal

Rehearse while the source account still exists. Inspect the selected backup's metadata and
inventory all captured tables/views; do not assume the historical four-table inventory.
Current schema files include traces and the migration ledger. Restore uses the **embedded
backup DDL**, not the sidecar schema files.

**Option A: matching replicated scratch infrastructure.** Use an isolated Keeper ensemble
and compatible ClickHouse configuration/macros/storage policies. A renamed database on the
production Keeper ensemble is not isolation: the literal replication paths omit the database
name. Configure S3 access through the scratch server's approved environment/role credentials,
then use a SQL client authenticated independently to ClickHouse:

```sql
RESTORE DATABASE claude_code
  FROM S3('https://<archive-bucket>.s3.<region>.amazonaws.com/<archive-prefix>/backup/<backup-tag>');
```

Do not embed access keys or session tokens in SQL; query logs can retain them. Test the
scratch server's actual S3 authentication before depending on the restore.

**Option B: non-replicated scratch tables.** In a scratch environment, pre-create the database
and **every captured data table** with non-replicated `MergeTree`/`AggregatingMergeTree`
engines. Derive columns, materialized expressions, partition and sorting keys from that
backup's DDL. Remove `ON CLUSTER` and Keeper arguments. A mismatched `PARTITION BY` can fail
with `CORRUPTED_DATA`; a missing pre-created table can reintroduce replicated DDL. Preserve
materialized-view targets and validate all restored objects. Do not blindly run today's full
schema file as preparation for an older backup.

After reviewing those table definitions, load data into the empty scratch tables:

```sql
RESTORE DATABASE claude_code
  FROM S3('https://<archive-bucket>.s3.<region>.amazonaws.com/<archive-prefix>/backup/<backup-tag>')
  SETTINGS allow_different_table_def = 1;
SHOW CREATE TABLE claude_code.otel_metrics_sum;
SHOW CREATE TABLE claude_code.otel_metrics_sum_hourly;
```

The previously documented `allow_non_empty_tables = 1` option is only appropriate for a
separately reviewed scratch experiment with intentional existing data. Do not use it to
merge a backup into production or as a default rehearsal; overlapping parts can invalidate
comparisons.

Compare raw-table counts and key values for a closed, stable time window captured by the
backup. For `SimpleAggregateFunction` columns, compare aggregates grouped by the full sorting
key: `max(max_value)`, `sum(sum_value)`, and `max(has_org)`. Background merges can change
physical row counts in `otel_metrics_sum_hourly` without changing values. Do not use
`sumMerge()` on `SimpleAggregateFunction` or sum cumulative raw counters as a usage check.
Verify all captured tables, MV behavior, and ledger/schema evidence, then remove only the
scratch resources after recording results.

## Completion and recovery limits

Record the source/destination identities, exact backup prefix, cutoff, transfer result,
restore scope, elapsed time, and comparison results in the operational record. Keep
credentials and raw PII out of that record. Do not tear down the source account until the
required snapshot is independently usable from the destination.

Historical evidence in this repository covers a scratch single-table S3 backup/restore and
a scratch replicated restore pattern. It does not establish a current full-database restore
test or measured RTO. Follow [incident response](incident-response.md)
for destructive production recovery; archival itself does not delete source data.
