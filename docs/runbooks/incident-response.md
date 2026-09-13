# Runbook: Incident Response

## Prerequisites

Run commands from the repository root in Bash. Confirm the target context/namespace and
have pod/log access. Telemetry collectors run on participant EC2 instances, so ingestion
incidents also need the approved SSH/SSM access path. Use the reader for telemetry queries;
DDL, backup/restore, and restricted `system.*` diagnostics require writer/admin access.

```bash
: "${KUBE_CONTEXT:?Set the target kubectl context}"
NAMESPACE=${NAMESPACE:-claude-code}
kube() { kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }
kube get pods -o wide
kube get events --sort-by=.lastTimestamp | tail -20
POD=$(kube get pods -l clickhouse.altinity.com/chi=cc-ab \
  -o jsonpath='{.items[0].metadata.name}')
: "${POD:?Select a Ready ClickHouse pod}"
```

Confirm `$POD` is Ready before queries. This helper passes the password via stdin into the
container environment, never a URL or command argument. It reads SQL from stdin and defaults
to the reader. Keep shell tracing disabled around credentials; do not dump Secrets or env files.

```bash
ch() (
  set -o pipefail
  set +x
  ch_pw=$(kube get secret "${CH_SECRET:-clickhouse-reader}" \
    -o jsonpath='{.data.CH_PASSWORD}' | base64 -d) || exit 1
  [ -n "$ch_pw" ] || exit 1
  { printf '%s\n' "$ch_pw"; cat; } | kube exec -i "$POD" -c clickhouse -- sh -c \
    'IFS= read -r CLICKHOUSE_PASSWORD; export CLICKHOUSE_PASSWORD; exec clickhouse-client --user "$1" --multiquery' \
    sh "${CH_USER:-otel_reader}"
)
```

For an admin query, prefix `ch` with `CH_USER=otel_writer CH_SECRET=clickhouse-writer`.
SQL blocks below are operator queries, not chat input. Stop on a failed command and inspect
the error; a partial query sequence is not a successful check.

## Triage

| Symptom | Start here |
|---|---|
| Dashboard pods unavailable, readiness failure, or edge errors | Dashboard outage |
| Pods healthy but charts stop advancing | Telemetry stopped flowing |
| ClickHouse or Keeper pods unhealthy | ClickHouse degradation |
| Requests succeed but values look implausible | Data looks wrong |
| Only chat fails | [Chat troubleshooting](ask-claude-chat-troubleshooting.md) |
| AI review is blocked | [PR review panel](pr-review-panel.md) |

## Dashboard outage

```bash
kube logs -l app=dashboard --tail=100 --prefix
kube describe deployment dashboard
```

Capture failing pod logs before replacing pods; use `kube logs POD --previous` for a
restarted container where available. In a separate terminal, run the port-forward in the
foreground and stop it with Ctrl-C when finished:

```bash
kube port-forward deployment/dashboard 8080:8080
```

```bash
curl --silent --show-error http://127.0.0.1:8080/healthz
curl --silent --show-error http://127.0.0.1:8080/readyz
```

`/healthz` checks process liveness. `/readyz` also checks ClickHouse and returns 503 during
shutdown; only these two paths bypass Basic Auth. Authentication configuration failures are
intentional fail-closed boot failures: repair the Secret instead of disabling authentication.
For `ImagePullBackOff`, inspect the event reason, image existence, registry permissions, and
architecture. Follow [deployment rollback](deploy-production.md) for a bad image.
If the pod is healthy but the public endpoint fails, inspect CloudFront, NLB targets, and
the applied security-group rules in `infra/dashboard.tf`/`infra/dns_cdn.tf`.

## Telemetry stopped flowing

Check authenticated `GET /api/health/data`. It returns 200 for `status: ok`, 503 for `stale`
or `unknown`. The raw metrics probe has a seven-day window; `unknown` also covers no rows
in that window. `DATA_STALE_MINUTES` defaults to 360. A healthy process alone does not
establish ingestion, and quiet workshop periods need different interpretation from active use.

```bash
ch <<'SQL'
SELECT max(TimeUnix) AS latest, dateDiff('second', max(TimeUnix), now()) AS gap_seconds
FROM claude_code.otel_metrics_sum;
SELECT count(), min(hour), max(hour) FROM claude_code.otel_metrics_sum_hourly;
SQL
```

On an affected participant instance:

```bash
sudo systemctl status otelcol.service
sudo journalctl -u otelcol.service --since '-2 hours' --no-pager | tail -40
sudo systemctl show otelcol.service -p Restart -p ExecStart
```

Check DNS/connectivity, exporter authentication, queue disk space/permissions, and the
installed `/etc/otelcol/config.yaml`. Restart the supervised service only after resolving
the cause. Keep the on-disk queue; it buffers retries but is bounded and is not a guarantee
against data loss. Compare the installed managed settings and client version with the
intended launch configuration without exposing credentials.

`user-data.sh` provisions `otel_ingest` for new instances; older fleets can still use
`otel_writer`. Verify the actual `CH_USER`, target endpoint, SSM mapping, and grants.
Do not patch a running workshop fleet's `/etc/otelcol/env` for a credential cutover;
follow [ingest user cutover](clickhouse-ingest-user-cutover.md) and replace instances.
The declared ClickHouse network allowlist is `10.0.0.0/8`; inspect the actual server-side
source address and deployed account configuration before blaming the participant's CIDR.

For an active fleet, compare rollup `max(hour)` with `toStartOfHour(now())`, not `now()`.
An hourly bucket can be nearly an hour behind the wall clock. If raw data advances but
rollup does not, inspect the materialized view and ingest grants. Check `count()` before
using `min(hour)` to assess backfill: an empty rollup is not a completed backfill. The
backfill helper's watermark mode requires at least one rollup row and only fills history
before its earliest hour; it does not repair arbitrary interior gaps.

## ClickHouse degradation

```bash
kube get pods -l clickhouse.altinity.com/chi=cc-ab -o wide
kube logs "$POD" -c clickhouse --tail=100
kube exec "$POD" -c clickhouse -- df -h /var/lib/clickhouse
CH_USER=otel_writer CH_SECRET=clickhouse-writer ch <<'SQL'
SELECT hostName(), table, is_readonly, absolute_delay, queue_size
FROM clusterAllReplicas('replicated', system.replicas)
WHERE database = 'claude_code';
SELECT table, disk_name, sum(bytes_on_disk) AS bytes
FROM system.parts WHERE active AND database = 'claude_code'
GROUP BY table, disk_name ORDER BY bytes DESC;
SELECT table, command, is_done, latest_fail_reason FROM system.mutations
WHERE database = 'claude_code' AND NOT is_done;
SQL
```

Terraform declares one shard, three ClickHouse replicas, three Keeper nodes, and 100Gi hot
PVCs per ClickHouse replica. Verify the actual topology and scheduling capacity. A failed
replica can leave others serving; verify replication catch-up rather than assuming it.
Restore Keeper quorum first if lost. For disk pressure, inspect each table's `SHOW CREATE
TABLE`, storage policy, TTL, and pending moves/mutations. Do not force a cold-tier move on
a table using `storage_policy=default`, or assume source TTL changes have already applied.
Do not delete PVCs, Keeper registrations, or objects under the live `cold/` prefix.

## Data looks wrong

- For cumulative counters, compare with `incFlat`/`incBucketed` in
  `dashboard/server/queries.js`; raw `sum(Value)` overcounts. Direct summation is appropriate
  only for explicitly delta (`AggregationTemporality=1`) data.
- Check `/api/config` fields `schema.migrations`, `schema.segmentAwareSeriesKey`, and
  `schema.projectColumns`; missing/unknown evidence is not an applied migration. Follow
  [schema migrations](schema-migrations.md). During migration 003, raw and live rollup
  values can both be inflated until the relevant rewrite/rebuild finishes.
- Grouping is per session. `grouping.js` uses any nonempty model not starting with `claude-`
  as Bedrock evidence, then `has_org` for Enterprise, otherwise unknown. User-level grouping
  or `ExperimentGroup` is not equivalent.
- Compare the same window, filters, cohort/client versions, and reported/computed cost basis.
  Current Cost-page spend and ordinary chat cost use client reports; token-price computed
  cost is diagnostic. Missing reports are not evidence of free use. Consult
  `/api/integrity/version-cohort-sessions` for version imbalance.
- Event availability differs by auth path/client version; for example, the repository
  documents missing Bedrock `internal_error` events. Inspect emitted events before treating
  an absent event as zero errors. Trace endpoints can legitimately report `unsupported`.
- `project` is scoped to the four project-aware routes, not every dashboard query; see
  [API reference](../api-reference.md). Client-side email masking does not remove PII from
  the underlying API or database.

## Verification

Confirm desired pods Ready, `/readyz` 200, raw metric timestamps advancing during active
use, rollup coverage for the same period, and replica delays recovering. A current-hour
bucket alone does not establish complete history. Inspect data gaps after queue recovery;
a green freshness signal does not restore previously lost samples.

## Data recovery: last resort

Use [backup and restore](backup-and-restore.md) to select and rehearse a complete backup.
Verify the actual object prefix, backup status, credentials, topology, and available window
before any destructive operation. Retention declarations do not prove a backup exists.
Freeze producers, drain queued telemetry, pause ingestion and the backup schedule, and
record a recovery cutoff. Preserve a final snapshot if the damaged cluster can still take one.

The replicated schema uses literal Keeper paths without the database name. A different
logical database on the same Keeper ensemble can collide with production. Dropping one
replica and restoring it can simply resync damaged data from the surviving replicas.
`RESTORE` also does not overwrite nonempty tables by default.

Only after a successful rehearsal and explicit authorization for database-wide data loss,
run the established cluster-wide recovery with writer/admin SQL credentials and working
S3 environment/role credentials. Replace the URL with the verified complete backup prefix:

```sql
DROP DATABASE claude_code ON CLUSTER 'replicated' SYNC;
RESTORE DATABASE claude_code ON CLUSTER 'replicated'
  FROM S3('https://<backup-bucket>.s3.<region>.amazonaws.com/backup/<verified-backup-tag>');
```

The drop is irreversible except by restore. The repository records a scratch replicated-table
rehearsal of this pattern, not a current full-production-database recovery test. Single-table
in-place recovery needs its own plan. After restore, verify all replicas, schema/grants,
materialized-view routing, retained data and aggregates before resuming ingestion and
backups. Use the [permanent archive](archive-clickhouse.md) when a source account will be removed.
