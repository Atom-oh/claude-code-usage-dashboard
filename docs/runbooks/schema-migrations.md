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

## Rollback

These files contain no automatic down migrations. Image rollback does not undo schema, and
deleting a ledger row does not undo DDL or restore data. Use the migration-specific cutover
rollback or [backup recovery](backup-and-restore.md). Only correct a ledger entry after
independently proving the corresponding schema/data operation was reverted, and keep the
correction in the operational record. Never delete or insert a ledger row merely to make
the API report an expected version list.
