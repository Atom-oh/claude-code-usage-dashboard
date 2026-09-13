# Runbook: ClickHouse Backup and Restore

## Declared posture

`infra/clickhouse.tf` declares `clickhouse-backup` at `0 18 * * *` UTC (03:00 KST), using
`otel_writer` for SQL and ClickHouse pod IRSA for S3. It synchronizes every replicated table
on the dedicated replica-0 service, then backs up on the same replica. Each run writes a
self-contained **object set**, not one object, to `backup/<UTC-date>_<HHMMSS>/`.

`infra/s3.tf` declares 30-day expiry for `backup/` only. These are desired settings: inspect
the deployed schedule, job results, destinations, lifecycle, and complete backup objects.
A daily schedule targets roughly 24-hour intervals; actual recoverable-data age can exceed
24 hours after missed jobs, replication lag, or restore failure. Derive the current recovery
point from the latest verified usable snapshot. No measured full-database RTO is established
by this repository.

## Prerequisites

Use `kube` and the privileged SQL access pattern in
[incident response](incident-response.md). Have AWS read access to the actual
backup bucket and Terraform state for its output. Restore drills also require an isolated
scratch target and credentials able to read the selected snapshot there.

<a id="1-inspect-deployed-backups"></a>
## 1. Inspect deployed backups

```bash
: "${REGION:?Set the backup bucket region}"
BUCKET=$(terraform -chdir=infra output -raw clickhouse_backup_bucket)
kube get cronjob clickhouse-backup -o yaml
kube get jobs --sort-by=.metadata.creationTimestamp
aws s3api get-bucket-lifecycle-configuration --region "$REGION" --bucket "$BUCKET"
aws s3 ls --recursive "s3://$BUCKET/backup/"
```

Inspect the latest backup Job's completion status and logs, including `SYSTEM SYNC REPLICA`
and `BACKUP` failures. `lastScheduleTime` only proves scheduling. Confirm a `.backup`
manifest and all required metadata/data objects under the selected prefix. A partial prefix
or successful S3 listing does not prove a usable backup. Use the correct AWS profile if
Terraform, source-bucket access, and scratch restore use different identities.

For an authorized manual snapshot, create a distinct Job from the current CronJob and wait:

```bash
BACKUP_JOB="clickhouse-backup-manual-$(date -u +%Y%m%d%H%M%S)"
kube create job "$BACKUP_JOB" --from=cronjob/clickhouse-backup
kube wait --for=condition=complete "job/$BACKUP_JOB" --timeout=1800s
kube logs "job/$BACKUP_JOB"
```

Avoid overlapping it with an active scheduled backup. On timeout, inspect whether the Job
is failed or still running before retrying. Determine the resulting snapshot prefix from its
logs and S3 objects; do not substitute the Job name for the timestamp chosen by the container.

## 2. Restore procedure

Follow [archive restore rehearsal](archive-clickhouse.md).
For a daily snapshot, substitute this bucket's `backup/<UTC-date>_<HHMMSS>` URL for the
archive URL. Preserve the entire snapshot prefix, and use the DDL captured with that backup.

The replicated schema uses literal Keeper paths. Never rehearse a replicated restore into
a differently named database on production Keeper: database renaming does not change those
paths. Use isolated replicated infrastructure or fully pre-created non-replicated scratch
tables. The production destructive recovery procedure is in
[incident response](incident-response.md).

## 3. Quarterly restore drill

1. Select a recent complete snapshot and record its timestamp/cutoff and actual age.
2. Start a timer and restore every captured table into the approved isolated scratch target.
3. Verify schema/materialized expressions and raw counts over a stable closed window.
   Compare grouped aggregate values for rollup tables, not physical row counts that change
   with merges. Confirm the backup inventory includes every table the intended restore needs.
4. Exercise the restored read path and check replica/MV behavior appropriate to that target.
5. Record exact snapshot, date, scope, elapsed time, and pass/fail. This establishes the RTO
   for the tested scope; a single-table test does not measure full-database recovery.
6. After recording evidence, remove only the explicitly identified scratch resources.

Rehearse again after material changes to schema, backup destination, credentials, or restore
topology. A source table that continued to accept late telemetry is not a stable comparison
baseline merely because its timestamp window ended.

## Rollback and gaps

A failed scratch restore does not modify production. Stop and recreate the scratch target
before retrying; do not enable nonempty restore to suppress an unexplained mismatch.
Never drop the production database as drill cleanup.

There is no backup-job failure alarm declared under `infra/`; the two optional paths in
[alerting](alerting.md) cover freshness and edge errors only. There is no declared automatic
cross-region backup copy. Use [permanent archival](archive-clickhouse.md) before source
expiry/account teardown; source TTLs and lifecycle do not establish archive retention.
