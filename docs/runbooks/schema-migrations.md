# Runbook: ClickHouse Schema Migrations

## Scope and prerequisites

Numbered SQL files describe migrations; they do not establish deployed state. Inspect the
actual schema, data, and ledger before choosing an operation. Use writer/admin access from
[incident response](incident-response.md) for DDL and `system.*` diagnostics.
Read the selected migration's prerequisites and take a verified recovery snapshot before
changing live schema. The numbered files target cluster `replicated`; local non-replicated
installations use `clickhouse-schema.sql` instead.

| File | Operation and ordering |
|---|---|
| `clickhouse-migration-002.sql` | Add telemetry columns, traces, and rollup dimensions; includes background materializations. |
| `clickhouse-migration-003.sql` | Requires 002. Change `SeriesKey` and rebuild the hourly rollup. **Run statement by statement** using the [rollup cutover](rollup-rebuild-segment-key.md); never stream the whole file. |
| `clickhouse-migration-004.sql` | Requires 002, not completion of 003. Create the ledger and backfill 002/003 records only when their evidence guards pass. |
| `clickhouse-migration-005.sql` | Requires 004. Add `ProjectName`/`Entrypoint` to raw metrics, logs, and traces where present; deliberately no materialization or rollup change. |
| `clickhouse-migration-006.sql` | Requires ledger 004, not 005. Create four dedicated Codex metric tables and record exporter-compatible column evidence; no rebuild or materialization. |
| `clickhouse-migration-007.sql` | Requires ledger 004. Add typed Codex cost events, scope evidence and ingestion views. Use the [cost schema runbook](codex-cost-schema.md) for separate bounded backfill and read activation. |
| `clickhouse-migration-008.sql` | Requires ledger 004. Add exact Codex diagnostic identity states and an ingestion view. Use the [diagnostic schema runbook](codex-diagnostic-schema.md) for bounded backfill and tools/performance read activation. |
| `clickhouse-migration-009.sql` | Requires ledger 004. Add Claude session provider membership and an ingestion view. Use the [provider schema runbook](claude-provider-schema.md) for bounded backfill and `CLAUDE_PROVIDER_GROUPS` activation. |
| `clickhouse-migration-010.sql` | Requires ledger 004. Add exact turn/request key sets per session-hour. Follow [Session turns](#session-turns-migration-010) for bounded backfill and `SESSION_TURNS_READ_FROM` activation. |

Run a numbered migration through one selected pod. `ON CLUSTER` DDL propagates through the
cluster; the guarded ledger `INSERT` is **not** `ON CLUSTER` and replicates normally. Do not
run concurrent copies on every replica. Local `system.*` guards alone cannot confirm other
replicas have finished mutations.

## 1. Inspect current evidence

```bash
CH_USER=otel_writer CH_SECRET=clickhouse-writer ch <<'SQL'
SELECT name, engine FROM system.tables
WHERE database = 'claude_code' ORDER BY name;
SELECT table, name, default_kind, default_expression FROM system.columns
WHERE database = 'claude_code'
  AND name IN ('SeriesKey', 'AppVersion', 'ProjectName', 'Entrypoint')
ORDER BY table, name;
SELECT hostName(), table, command, is_done, latest_fail_reason
FROM clusterAllReplicas('replicated', system.mutations)
WHERE database = 'claude_code' AND NOT is_done;
SQL
```

If `schema_migrations` exists, read it:

```bash
ch <<'SQL'
SELECT version, name, applied_at, checksum
FROM claude_code.schema_migrations ORDER BY version;
SQL
```

Compare authenticated `GET /api/config`:

| Field | Interpretation |
|---|---|
| `schema.migrations` | `null`: probe failed or ledger absent; `[]`: ledger was queried and contained no records. `[2,3,4,5]` is expected only when all corresponding guards/operations have completed. |
| `schema.segmentAwareSeriesKey` | Recent raw `cost.usage` rows match segment keys (`true`), legacy keys (`false`), or are mixed/absent/unreadable (`null`). It does not prove historical materialization or rollup rebuild completion. |
| `schema.projectColumns` | Resolving `ProjectName` and `Entrypoint` on `otel_logs` succeeds (`true`); numeric server error (`false`); transport/unknown error (`null`). This is not an audit of all three raw tables. |

`dashboard/server/schema.js` owns these probes. They refresh at boot and every ten minutes;
API observations can lag direct SQL. The 002/003 ledger entries can be backfilled at a later
date, so their `applied_at` is not proof of the original cutover time. Mirrored schema-init
blocks can also create records without executing a numbered file literally.

## 2. Apply the chosen migration

Use this streaming pattern for 004 after its checks. The file remains on the workstation;
no `kubectl cp` is needed. The `ch` helper selects `otel_writer` explicitly and streams SQL
with `--multiquery`:

```bash
CH_USER=otel_writer CH_SECRET=clickhouse-writer ch < clickhouse-migration-004.sql
```

Use the same pattern for 002 only after reviewing its pending mutations and table changes.
Do not use it for 003. Before 004's backfill of version 3, verify materialization completion
across all replicas, not only the selected pod; its guard scans the oldest raw partition and
checks the live rollup's `_hourly_v2` replication path (or empty raw data).

For 005, confirm both prerequisites explicitly:

```bash
CH_USER=otel_writer CH_SECRET=clickhouse-writer ch <<'SQL'
SELECT name FROM system.tables
WHERE database = 'claude_code' AND name IN ('schema_migrations', 'otel_traces');
SQL
```

If the ledger is absent, apply 004 first. If `otel_traces` exists, stream 005:

```bash
CH_USER=otel_writer CH_SECRET=clickhouse-writer ch < clickhouse-migration-005.sql
```

If traces are absent, execute **only sections 1, 2, and 4** of 005, statement by statement.
Section 3 would fail with `UNKNOWN_TABLE` and stop `--multiquery` before recording version 5.
Its ledger guard explicitly permits a missing traces table. If traces are introduced later,
verify their promoted columns independently. Both promoted fields use a simple map lookup;
005 intentionally schedules no `MATERIALIZE COLUMN`. Older parts evaluate the expression
when read, and the migration cannot reconstruct a `project.name` tag never collected.

For 006, confirm ledger version 4 exists and that `otel_traces` from 002 is available
before enabling Codex trace collection. The migration itself creates only
`codex_metrics_sum`, `codex_metrics_gauge`, `codex_metrics_histogram` and
`codex_metrics_exponential_histogram`; it does not change `otel_traces` or usage tables.
Run through one selected replica:

```bash
CH_USER=otel_writer CH_SECRET=clickhouse-writer ch < clickhouse-migration-006.sql
```

The initial guard rejects an absent version-4 ledger before creating tables. The final
guard verifies all 102 exporter column/type pairs locally before recording version 6.
Inspect `system.columns`, engines and TTLs on every replica and read back the ledger;
an existing incompatible table is not repaired by `CREATE IF NOT EXISTS`. See the
[collection interface](codex-telemetry.md#storage-interface) and run the optional
Collector/ClickHouse tests before enabling the new exporter. The standalone 006 file
creates no mutations and avoids schema-init's older materialization statements.

## 3. Bootstrap and existing-installation verification

[schema.tf](../../infra/schema.tf) freezes the replicated SQL, generated metadata contract
and runner in a hash-named immutable ConfigMap. Their combined hash also names the Job.
Terraform waits for completion. The Job has no automatic restart or retry after failure;
connection and replication waits are bounded inside the runner.

Before executing SQL, the runner verifies the contract's source hash and reads the expected
distinct replica endpoints from `system.clusters`. Every endpoint must be reachable.
The service and discovered endpoints share the configured connection-wait deadline;
failed connection probes retry within it, each bounded by the process timeout.
This tolerates replicas becoming ready after the service first answers. Exhaustion
fails before bootstrap, naming the unavailable endpoint.
Bootstrap is permitted only if `claude_code` contains no objects on any expected replica.
Keep collectors and other writers off until the Job completes, and serialize installers
through the Terraform state lock. Fresh bootstrap waits for materializations before ledger
guards and then allows the replicated ledger to converge.

If any replica already has an object, the runner issues only metadata/ledger SELECTs.
It checks all owned objects' column types/default expressions, engines, partition/sorting/
primary keys, TTL, view query/target, storage policies, replication paths and exact migration
version/name/checksum rows. Retained rollback objects outside that owned set are preserved.
The existing DELETE-only hourly table may use `default` or `hot_cold` storage. Codec or
physical column order differences do not affect the named-input compatibility signature.

Compatibility checks fail on drift or incomplete migration records. They neither alter
tables nor create completion records. Apply the selected numbered migrations explicitly
and verify their data/replica prerequisites before retrying compatibility verification.
In particular, schema-init cannot replace migration 003's shadow backfill and exchange.
Column/ledger compatibility does not prove historical materialization, rollup coverage,
retention completion or recovery.

Inspection/verification sessions enforce `readonly=1`, 15-second execution and bounded
memory/read/result budgets. A 25-second process timeout, with a two-second kill grace, also
bounds an unresponsive native connection; server execution settings alone do not cover it.
Only the empty-bootstrap client has write access. The existing
writer Secret reference is retained; its value is passed in the client's environment.

```bash
kube get jobs | grep clickhouse-schema-init
CH_USER=otel_writer CH_SECRET=clickhouse-writer ch <<'SQL'
SHOW CREATE TABLE claude_code.otel_metrics_sum;
SHOW CREATE TABLE claude_code.otel_metrics_sum_hourly;
SHOW CREATE TABLE claude_code.otel_logs;
SQL
```

Inspect the exact Job logs and live state after failure. A partial fresh bootstrap selects
the existing-installation path on the next run and fails compatibility until explicitly
repaired. Do not drop populated tables, erase ledger rows, or stream the entire schema file
to force another bootstrap. Earlier DDL may remain; repair only the missing/incompatible
objects after reviewing mutation/replication state and recovery evidence. Re-run the Job
only after the repair and recorded migration evidence satisfy the contract.
Confirm that the exact failed Job is terminal before deleting it to permit recreation;
review the complete Terraform plan afterward. Do not delete a running initializer or use
a targeted apply to conceal other changes.

The SQL source retains 29 `MATERIALIZE COLUMN` statements for empty bootstrap. Streaming
it directly into a populated installation bypasses the lifecycle guard and can reschedule
large historical mutations. Existing installations must use numbered migrations instead.
Verify actual TTLs and data lifecycle independently of compatibility or apply success.

After an intentional schema change, regenerate the contract in an isolated fixture and
review the corresponding migration:

```bash
python3 scripts/build-schema-contract.py
python3 scripts/build-schema-contract.py --check
python3 scripts/test-schema-lifecycle.py
```

These use synthetic credentials and an embedded Keeper. Single-server fixtures have no
network; the three-server fixture uses an internal-only Docker network with no published
ports. They access no AWS resources or customer data. CI requires source/contract equivalence
and exercises bootstrap, populated no-write reruns, drift, missing ledger, partial installation,
failure retries, one-replica drift/unavailability and inconsistent cluster topology.

The replicated schema declares these TTLs; compare each actual table with its declaration:

| Tables | Move to cold volume | Delete |
|---|---|---|
| `otel_metrics_sum`, `otel_metrics_gauge` | 90 days | 180 days |
| `codex_metrics_sum`, `codex_metrics_gauge`, `codex_metrics_histogram`, `codex_metrics_exponential_histogram` | 90 days | 180 days |
| `otel_logs`, `otel_traces` | 45 days | 90 days |
| `codex_cost_events_v1`, `codex_cost_scope_v1` | 45 days | 90 days |
| `otel_metrics_sum_hourly` | No move TTL | 180 days |

These table TTLs are separate from the S3 `backup/` lifecycle. Never apply a bucket expiry
to `cold/`, which contains live table data.

## 4. Verification and future migration rules

Verify every affected table/replica and the intended query behavior, then recheck the ledger
and API. A guarded ledger insert avoids duplicate sequential records; it does not make an
entire migration safe to rerun. Migration 003 deliberately rejects an existing shadow table
and has a manual exchange. Do not rerun it as a no-op test.

New migrations must declare their **actual** dependency, not an assumed `NNN-1`, and record
their version after the required evidence passes. Mirror the guarded insert and checksum in
both schema copies. Compute the numbered file's checksum by excluding all lines containing
the ledger insert keyword:

```bash
: "${MIGRATION_FILE:?Set the numbered SQL file path}"
grep -v 'INSERT INTO claude_code.schema_migrations' "$MIGRATION_FILE" \
  | sha256sum | cut -c1-64
```

Keep the version, name, and checksum literals on the same physical line as `INSERT INTO
claude_code.schema_migrations`, so the checksum does not include itself. Schema copies use
that same numbered-file checksum even though their surrounding text differs.

## Session turns (migration 010)

Migration 010 adds `session_turns_v1` and its ingestion view `session_turns_v1_mv`. Per
`(Client, SessionId, hour, Kind, Model, UserIdentity)` the table keeps an exact `uniqExact`
state of 64-bit key hashes, so turns and API requests are counted per session and hour without
scanning `otel_logs`. States union: repeated delivery, repeated backfill or overlap with the
live view cannot change a count. Merge hourly states (`uniqExactMerge(Keys)`) over the window;
never sum counts across hours.

| Client | Source events | `SessionId` | `Kind` | `Model` | Key |
|---|---|---|---|---|---|
| `claude` | `user_prompt`, `claude_code.user_prompt` | `SessionId` | `turn` | empty | prompt id, else sequence plus timestamp, else timestamp plus attribute hash |
| `claude` | `api_request`, `claude_code.api_request` | `SessionId` | `request` | `model` | sequence plus timestamp, else timestamp plus attribute hash |
| `codex` | `codex.user_prompt` | `conversation.id` | `turn` | empty | timestamp plus resource and log attributes |

Claude keys match `sessionTurns`; both come from
[sessionTurnsSchema.js](../../dashboard/server/sessionTurnsSchema.js), so the live query and the
table cannot drift. Rows without a session are excluded. `UserIdentity` is `user.email`, else
`enduser.id`, else empty. Retention is 90 days (`DELETE`), with a 45-day move to `cold` when
replicated. Codex rows are a diagnostic feed and never feed completion-log usage or cost
([interpretation](../reference/codex-observability.md)). Installing the schema changes no query;
a transform change requires a new table version and migration.

Install and backfill, following the snapshot, replica and privilege checks in the
[cost schema runbook](codex-cost-schema.md#1-install-without-activating-reads) with the stable
migration identity rather than the collector identity:

1. Require ledger 004. Execute `clickhouse-migration-010.sql` once through the selected writer
   connection, then verify the table and view on every replica.
2. Confirm the view uses explicit `SQL SECURITY DEFINER`, its creator still exists, and collector
   inserts into `otel_logs` continue without new grants.
3. Run `clickhouse-backfill-010.sql` serially on one replica per shard with bound UTC
   `backfillFrom`/`backfillTo` (positive, at most one day each), from the oldest retained log
   hour through installation plus one settled hour. `insert_deduplicate=0` is safe because
   states union.
4. Compare the table with the raw logs; any difference blocks activation. Run
   `clickhouse-verify-010.sql` (generated with the transform, read-only) on each shard for one
   or more bounded, hour-aligned UTC windows inside the backfilled range. It returns per
   `Client`/`Kind` the merged table keys (`uniqExactMerge(Keys)`) beside
   `uniqExact(cityHash64(key))` over `otel_logs` for the same events, non-empty session and
   key expressions as the transform; any row with `differs = 1` blocks activation. Expired raw
   rows cannot be reconstructed, so hours before the first backfilled hour are a coverage gap,
   not an error.

   ```bash
   clickhouse-client --multiquery --param_verifyFrom='2026-11-01 00:00:00' \
     --param_verifyTo='2026-11-02 00:00:00' < clickhouse-verify-010.sql
   ```

5. Measure latency before activating; this step is required. Keep the serving
   `SESSION_TURNS_READ_FROM` empty and run a dashboard server that serves no users (for example
   a local server against the deployed ClickHouse) with the candidate boundary. Time uncached
   `GET /api/clients/token-economics` requests (a new filter set or after cache expiry) for
   2-day and 30-day ranges whose previous windows are also backfilled (so both windows are
   queried), with the clients the deployment enables; `system.query_log`
   durations show the slowest of its queries. Activate only if both are within the page's
   ~2 s p95. Otherwise leave `SESSION_TURNS_READ_FROM` unset, so the sections stay
   unavailable, and record the timings for a query-shape fix.

Activate by setting `SESSION_TURNS_READ_FROM` (Terraform `session_turns_read_from`, compose and
`.env` `SESSION_TURNS_READ_FROM`) to the verified UTC start of the backfill and deploying. There
is no raw-log fallback. Each window is gated on its own: a current window starting before the
boundary, any window while it is unset or empty, or a window older than the 90-day log retention
reports its values as unavailable (`not_backfilled` or `retention`), never zero; when only the
previous window is gated, only the comparison and decomposition are unavailable. To roll back,
set it empty and redeploy; this disables token-economics reads. Retain the table and view.

## Rollback

These files contain no automatic down migrations. Image rollback does not undo schema, and
deleting a ledger row does not undo DDL or restore data. Use the migration-specific cutover
rollback or [backup recovery](backup-and-restore.md). Only correct a ledger entry after
independently proving the corresponding schema/data operation was reverted, and keep the
correction in the operational record. Never delete or insert a ledger row merely to make
the API report an expected version list.
