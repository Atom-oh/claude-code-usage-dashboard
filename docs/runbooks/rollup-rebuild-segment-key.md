# Runbook: Rebuild the Hourly Rollup for Segment-Aware SeriesKey

## Scope and stop conditions

Use this for migration 003 on an existing legacy replicated cluster. The executable source
is `clickhouse-migration-003.sql`; follow its numbered sections and verification queries.
It must be run **statement by statement**, never as one `--queries-file`/`--multiquery`
pass: the exchange and final ledger insert are intentionally commented out.

Before starting, verify 002's columns, writer/admin access, a usable backup, available disk
space, all-replica health, and a maintenance window. Use the `ch`/`kube` helpers from
[incident response](incident-response.md); the reader cannot inspect mutations
or run DDL. Record existing `SHOW CREATE TABLE` output, replication paths, source time range,
and a rollback plan. Check [schema migrations](schema-migrations.md) before interpreting
API probes or the ledger as completion evidence.

Stop if the live rollup already uses `/clickhouse/tables/{shard}/otel_metrics_sum_hourly_v2`
or if a shadow `_v2` table exists. A completed cutover/fresh install uses that path already;
rerunning the original shadow CREATE would attach to an existing replication path or fail.
Resolve previous work explicitly. Do not add `IF NOT EXISTS` to hide a collision.

## Transient effects

After section 1 changes the materialized key, new inserts immediately use segment keys.
Existing raw parts keep legacy values until section 2's materialization completes. **Both
the raw path and the old live rollup can temporarily overcount active sessions**: the MV
starts appending new keys to the old live rollup immediately. The rebuilt rollup replaces
that mixed history only at exchange. Avoid interpreting dashboard values during cutover.
The response cache can lag SQL by up to 320 seconds; schema probes refresh every ten minutes.

The segment key includes `StartTimeUnix`, except `claude_code.session.count`, whose identity
remains session-based. This restores counter resets; it is not a change to pricing or a
promise of a fixed percentage increase. Historical cost/token deltas are examples, not
acceptance thresholds for a different dataset.

## 1. Change the raw key and create the shadow table

Run migration sections 1 and 2 with writer/admin privileges:

```sql
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated'
    MODIFY COLUMN SeriesKey UInt64 MATERIALIZED
        if(MetricName = 'claude_code.session.count',
           cityHash64(toString(Attributes)),
           cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix)));
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated'
    MATERIALIZE COLUMN SeriesKey;
```

Run section 3's exact `CREATE TABLE ..._v2` statement from the migration. It includes the
16-column schema, full sorting key (including `StartType` and `AppVersion`), a distinct
Keeper path, and a DELETE-only 180-day TTL. This is desired DDL, not a claim about the current
live table. Creation/backfill need not wait for raw materialization: the helper computes
the segment key directly. Exchange must wait for verification.

## 2. Backfill history and late arrivals

In a separate terminal, keep a native-protocol port-forward to the selected pod running:

```bash
kube port-forward "$POD" 9000:9000
```

The workstation needs `clickhouse-client`. Define this wrapper in the operational shell;
only non-secret arguments appear in calls. The script uses a temporary password config and
removes it on exit. Its XML config assumes an XML-safe password; resolve special-character
handling before running with an incompatible credential.

```bash
backfill() (
  set +x
  export CH_HOST=127.0.0.1 CH_PORT=9000 CH_USER=otel_writer
  CH_PASSWORD=$(kube get secret clickhouse-writer -o jsonpath='{.data.CH_PASSWORD}' | base64 -d) || exit 1
  export CH_PASSWORD
  TARGET_TABLE="$1" RANGE_FROM="$2" RANGE_TO="$3" ./scripts/backfill-hourly-rollup.sh
)
H0=$(ch <<'SQL'
SELECT toString(toStartOfHour(now()));
SQL
)
backfill claude_code.otel_metrics_sum_hourly_v2 '' "$H0"
```

`H0` is the exclusive end of the initial history scan. `RANGE_FROM` defaults to raw minimum.
The helper chunks by day using ClickHouse time calculations; **a supplied start is rounded
down to the beginning of its day**. Account for this wider overlap when rerunning a tail or
gap fill, especially for delta rows. It does not promise an exact arbitrary sub-day start.

Immediately before exchange, repeat the tail scan for late arrivals:

```bash
: "${TAIL_FROM:?Set the earliest tail timestamp, allowing for collector downtime and backfill duration}"
backfill claude_code.otel_metrics_sum_hourly_v2 "$TAIL_FROM" "$H0"
```

Choose at least the longest collector outage (the migration suggests 24 hours as a starting
point), or the backfill start if earlier. The persistent queue can deliver much older data;
inspect actual outage/queue history. Pre-H0 rows arriving after the first scan otherwise
remain only in the old table. A residual arrival window remains between tail scan and
exchange; quiesce and drain ingestion if complete cutoff coverage is required.

`max_value`/`has_org` merges are idempotent; `sum_value` for delta data is not. Do not assume
the old observation of only two delta rows describes the target. Inspect delta overlap
before repeating any range, including the rounded-down start day.

## 3. Verify before exchange

As admin, inspect all replicas:

```sql
SELECT hostName(), table, command, is_done, latest_fail_reason
FROM clusterAllReplicas('replicated', system.mutations)
WHERE database = 'claude_code' AND table = 'otel_metrics_sum' AND NOT is_done;
SELECT countIf(SeriesKey != if(MetricName = 'claude_code.session.count',
    cityHash64(toString(Attributes)),
    cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix)))) AS mismatch
FROM claude_code.otel_metrics_sum
WHERE toYYYYMM(TimeUnix) =
    (SELECT min(toYYYYMM(TimeUnix)) FROM claude_code.otel_metrics_sum);
SELECT count(), min(hour), max(hour) FROM claude_code.otel_metrics_sum_hourly_v2;
```

Require no unfinished/failed mutations and zero key mismatches on each replica. The oldest
partition/full-range check is necessary; recent rows alone already have new keys and can
hide untouched legacy parts. Require a nonempty shadow for a nonempty source, expected
history coverage up to H0, and explained gaps. On a continuously active fleet, its final
bucket should be H0 minus one hour; quiet periods require comparison with source activity.
Complete migration 003 section 7(b)/(c), tail scan, and delta checks before proceeding.

## 4. Exchange, then fill the gap

```sql
EXCHANGE TABLES claude_code.otel_metrics_sum_hourly
    AND claude_code.otel_metrics_sum_hourly_v2 ON CLUSTER 'replicated';
```

Record the exchange time and `HX`, the start of that hour plus one hour, using ClickHouse's
timezone. The live name now uses the `_hourly_v2` Keeper path; `_v2` holds the old data on
the original path. This expected name/path reversal must be consistent across replicas.

```bash
: "${HX:?Set the end of the hour containing the exchange}"
backfill claude_code.otel_metrics_sum_hourly "$H0" "$HX"
```

Include the whole exchange bucket: pre-exchange arrivals went to the old table. Do not
extend the end beyond HX; later buckets are MV-owned. The helper still rounds the start
down to a day, so audit delta sums across the entire effective overlap. If delta sums are
duplicated, repair only the affected delta buckets with a reviewed delete/refill plan,
wait for deletion mutations, and account for continuing arrivals. Do not blindly rerun a
live overlapping range to “fix” it.

## 5. Verify and record completion

Run migration 003 section 7(a)-(f), including:

- New live table receives inserts; old `_v2` is frozen. Compare aggregate values over time
  and, while crossing an hour boundary, `max(hour)`. Physical row counts can decrease through
  merges, so a count change alone does not prove MV routing. If the old table keeps receiving
  rows, use section 7(a)'s MV drop/recreate fallback and repeat the bounded gap repair.
- Zero raw key mismatches, no pending mutations across all replicas, and per-day coverage
  matching the source's retained history. Compare closed windows while accounting for late data.
- Old/new cost comparison with the migration's zero-default lag query. Treat its ratio as a
  diagnostic only: it includes pre-window series history and is not a billing total.
- Delta sums agree with raw delta values; run this against every affected overlap window:

```sql
SELECT r.MetricName, r.hour, r.rolled, w.raw
FROM (SELECT MetricName, hour, sum(sum_value) AS rolled
      FROM claude_code.otel_metrics_sum_hourly WHERE AggregationTemporality = 1
      GROUP BY MetricName, hour) AS r
LEFT JOIN (SELECT MetricName, toStartOfHour(TimeUnix) AS hour, sum(Value) AS raw
           FROM claude_code.otel_metrics_sum WHERE AggregationTemporality = 1
           GROUP BY MetricName, hour) AS w USING (MetricName, hour)
ORDER BY r.hour DESC;
```

Only after verification, run section 10's guarded ledger insert once. If the ledger does
not exist, apply 004 first; its evidence-based backfill may already record 3. Confirm exactly
one version-3 record, and retain the full verification evidence separately from the API probe.

## Rollback

Keep the old `_v2` table through the rollback window. If returning to the old table is
necessary, pause/drain ingestion and preserve both tables plus the exchange timestamps.
The migration's mechanical reversal is:

```sql
EXCHANGE TABLES claude_code.otel_metrics_sum_hourly
    AND claude_code.otel_metrics_sum_hourly_v2 ON CLUSTER 'replicated';
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated'
    MODIFY COLUMN SeriesKey UInt64 MATERIALIZED cityHash64(toString(Attributes));
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated'
    MATERIALIZE COLUMN SeriesKey;
```

**This is not a complete data rollback by itself.** The old table missed arrivals between
exchange and rollback and may contain transition-era segment keys. Reconstruct the affected
history with the intended legacy key, reconcile delta rows, and verify MV routing/raw keys
before resuming. The checked-in backfill helper always computes the segment key; running it
unchanged cannot rebuild a legacy rollup. Prepare and rehearse a matching legacy aggregation
before cutover if legacy rollback is required, or use the verified backup-recovery plan.
The original undercount of resumed sessions returns with legacy keys.

## Cleanup and local variant

After the rollback window and successful verification, inspect replication paths:

```sql
SELECT hostName(), zookeeper_path
FROM clusterAllReplicas('replicated', system.replicas)
WHERE database = 'claude_code' AND table = 'otel_metrics_sum_hourly';
```

After a successful forward cutover, all live replicas must use the `_hourly_v2` path. Recheck
before/after cleanup and after replica additions or schema-init reruns. Only then drop the
identified frozen old table:

```sql
DROP TABLE claude_code.otel_metrics_sum_hourly_v2 ON CLUSTER 'replicated';
```

For a stopped, non-replicated local stack, apply the reference schema's key change and
rebuild the rollup by `TRUNCATE` plus **explicit range-mode** backfill through the desired
end time. Default watermark mode on an empty rollup exits without filling it. A rebuilt
existing local stack may still lack ledger version 3 because it has no replicated-path
rebuild evidence; do not fabricate a record to conceal that limitation.
