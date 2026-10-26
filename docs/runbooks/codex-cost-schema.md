# Runbook: Codex cost schema

## Contract

See [data](../reference/data.md) for typed events, scope sets, retention and
interpretation. Costs remain runtime estimates; metrics/traces remain diagnostic.

Activation requires the **companion application release** containing
`codexCostSource.js`, `compareCodexCost.js`, `test-codex-cost-schema.py` and
`codex_cost_read_from`. Keep raw reads until that release; section 3 and application
validation below are deferred. Its reader must deduplicate
**every event kind** by timestamp plus full identity and merge scope sets; only
under that contract are repeated/backfill-live overlaps logically idempotent.

## 1. Install without activating reads

Use `kube`, selected Ready `POD` and credential-safe `ch` from
[incident response](incident-response.md). Take a verified snapshot following
[schema migrations](schema-migrations.md) and [backup/restore](backup-and-restore.md).
The declared backup covers the database; confirm actual objects include both new
tables in the next backup. Full identity maps are sensitive telemetry. Measure added storage/insert CPU on a
small trial and cold reads beyond 45 days; expired raw data cannot be reconstructed.

Keep `CODEX_COST_READ_FROM` empty. Migration 007 requires ledger 004. The migration
principal `otel_writer`/`clickhouse-writer` is **distinct from collector-facing
`otel_ingest`/`clickhouse-ingest`**. Views run as their stable creator via
`DEFINER = CURRENT_USER SQL SECURITY DEFINER`; that principal must remain available
on every writable replica. Never grant collectors raw-log SELECT.

Before attaching views, select **each writable replica** as `POD` and run this
ClickHouse 24.8 preflight (newer `CHECK GRANT` syntax is not available):

```bash
CH_USER=otel_writer CH_SECRET=clickhouse-writer ch <<'SQL'
SELECT currentUser();
SHOW GRANTS;
SELECT count() FROM claude_code.otel_logs WHERE 0;
SQL
```

Require a distinct stable migration identity and effective grants for CREATE
TABLE/VIEW on `claude_code`, CLUSTER, SELECT/INSERT on `schema_migrations`, SELECT
on `otel_logs`, and INSERT on both cost targets (database-wide INSERT includes
future tables). Inspect inherited role grants too. Stop on missing or unproven
rights; use the installation's access-management owner to provision them. Recheck
after rotations. Confirm raw-log SELECT remains denied for `otel_ingest` on every
replica. Then execute once from the repository root:

```bash
CH_USER=otel_writer CH_SECRET=clickhouse-writer ch < clickhouse-migration-007.sql
```

Verify `infra/files/clickhouse-schema-contract.sql` on every replica **before
deploying its initializer**; it never repairs drift. Local non-replicated upgrades
use the generated Codex block in `clickhouse-schema.sql`; fresh bootstrap includes it.

## 2. Backfill bounded intervals

Choose a retained UTC start. Run serially on one replica per shard, at most one
day per invocation; start with one hour. Credentials use stdin; keep tracing off.

```bash
cost_backfill() (
  set -o pipefail
  set +x
  : "${COST_FROM:?UTC start}" "${COST_TO:?UTC end}"
  cost_pw=$(kube get secret clickhouse-writer \
    -o jsonpath='{.data.CH_PASSWORD}' | base64 -d) || exit 1
  [ -n "$cost_pw" ] || exit 1
  { printf '%s\n' "$cost_pw"; cat clickhouse-backfill-007.sql; } |
    kube exec -i "$POD" -c clickhouse -- sh -c \
      'IFS= read -r CLICKHOUSE_PASSWORD; export CLICKHOUSE_PASSWORD
       exec clickhouse-client --user otel_writer --multiquery \
         --max_threads=1 --max_block_size=8192 \
         --max_insert_block_size=8192 --min_insert_block_size_rows=0 \
         --min_insert_block_size_bytes=0 --max_memory_usage=800000000 \
         --max_execution_time=120 \
         --param_backfillFrom="$1" --param_backfillTo="$2"' \
      sh "$COST_FROM" "$COST_TO"
)
COST_FROM='2026-10-25 00:00:00' COST_TO='2026-10-25 01:00:00' cost_backfill
```

Between intervals observe active parts per partition (`system.parts`), ongoing
merges (`system.merges`), replication queues/delay (`system.replicas`), disk space,
insert failures and query memory/time. Small blocks trade memory for more parts.
Pause if merge/replication backlog grows or ingestion degrades; let queues drain
and reduce the interval. Do not raise thresholds or force OPTIMIZE to hide pressure.

Record successful intervals privately. Retry a failed interval in full; this may
add physical event rows until TTL. Live views capture new inserts and late arrivals,
but replica fetches do not replace installing every view. Dependent-view failures
can leave gaps even when raw rows exist; reconcile affected intervals from raw logs.

## 3. Verify and activate — companion application required

1. Confirm all replica contracts, healthy replication and writable-view privileges.
2. Compare raw/fact SQL and folded responses for **every closed interval** from
   the boundary through view installation, then a closed post-install interval.
   Include all users, exact-user/model filters, missing usage and time boundaries.
3. Reconcile insertion failures; retain the coverage boundary and evidence privately.
   Samples, table existence and ledger 007 alone do not prove completeness.

Use normal server `CH_*` secrets and a readonly session; output contains only
counts/status:

```bash
node dashboard/server/compareCodexCost.js \
  --from 2026-10-25T00:00:00Z --to 2026-10-25T01:00:00Z
```

Optional exact-user/model/backend filters use bound parameters. Use settled
intervals; concurrent arrivals can change sequential query results.
Mismatch/query errors block activation. Then set `codex_cost_read_from` or
`CODEX_COST_READ_FROM` to the verified UTC boundary and roll out the companion app.
Only whole ranges starting there or later use typed data. Invalid configuration
fails startup; query errors surface without a hidden raw retry. Insights/Effort
retain their sources; this does not establish whole-page latency or capacity.

## Rollback and maintenance

Unset the boundary and roll out to restore raw reads. Keep tables/views for
investigation. Image rollback does not undo DDL; deleting ledger rows repairs nothing.
For a dependent-view ingestion incident, first pause the affected ingress, save
exact SHOW CREATE definitions, and follow [incident response](incident-response.md).
Detaching affected views can restore raw writes, but creates a coverage gap and
**intentionally fails schema verification**: hold schema deployment, keep raw reads,
repair privileges/targets, restore every view, backfill the gap, verify all replicas
and parity before resuming typed reads. Never bypass the compatibility gate.

Stored classification, dimensions, identity or parsing changes require a new version
and migration; never change an activated v1 transform in place. Runtime prices can
change independently. Storage development checks:

```bash
node scripts/generate-codex-cost-schema.mjs
python3 scripts/build-schema-contract.py
node scripts/generate-codex-cost-schema.mjs --check
python3 scripts/test-schema-lifecycle.py
```

With the companion application present, also run `python3 scripts/test-codex-cost-schema.py`.
`COST_BENCHMARK=1` adds a synthetic single-query comparison, not production concurrency
or monthly capacity evidence.
