# Runbook: Codex cost schema

## Contract

Read activation and the comparison command require an application release containing
`codexCostSource.js` and `compareCodexCost.js`. The additive schema can be installed
in advance while existing application releases continue using raw logs.

`codex_cost_events_v1` stores typed tokens, validity flags, dimensions and exact
original map identity for usage, request and relevant activity events.
`codex_cost_scope_v1` stores minute-level sets of observed seconds for other
activity. This preserves missing-usage evidence at the API's second-resolution
range boundaries without scanning every stream delta.

Materialized views compute these columns on insertion. Costs are still calculated
by the existing runtime price catalog and context-tier rules. Native Codex metrics
remain diagnostic; they are never added to completion usage.

The new source applies only to the Codex `clientOverview` cost view. Insights,
Effort and other queries retain their existing sources. Improving this query alone
does not establish an end-to-end page latency target.

Replicated tables move to cold storage after 45 days. Both local and replicated
tables expire after 90 days, matching raw-log retention. Full original map identity
is retained for exact deduplication, so treat cost events as sensitive telemetry.
Expired raw data cannot be reconstructed or retrospectively verified.

## 1. Install without activating reads

Use the target context, selected Ready pod and credential-safe `ch` helper from
[incident response](incident-response.md). Inspect and snapshot the existing
installation according to [schema migrations](schema-migrations.md).

Keep `CODEX_COST_READ_FROM` empty throughout migration and validation.
Migration 007 requires ledger 004. From the repository root:

```bash
CH_USER=otel_writer CH_SECRET=clickhouse-writer ch < clickhouse-migration-007.sql
```

Run once; `ON CLUSTER` creates both targets and both views on all replicas.
The ledger records local column evidence, not backfill completeness.
For an existing local, non-replicated installation, execute the generated
`BEGIN GENERATED CODEX COST V1` block in `clickhouse-schema.sql` after its
ledger prerequisite. Fresh bootstrap includes these objects automatically.

Verify every replica's columns, sorting keys, engines, storage policy and view
definitions against `infra/files/clickhouse-schema-contract.sql`. The schema
initializer verifies existing installations without repairing them. Apply 007
before deploying its updated schema contract to an existing installation.

## 2. Backfill bounded intervals

Choose a contiguous UTC coverage start still available in raw logs. Run at most
one day per invocation, serially, on one replica per shard. Start with an hour on
a busy installation and reduce the range if memory or query duration approaches
the existing hardware limits.

The following wrapper uses the same `kube`, `POD` and secret conventions as `ch`
and passes credentials through stdin. Dates are bound parameters, not SQL text.
Do not enable shell tracing:

```bash
cost_backfill() (
  set -o pipefail
  set +x
  : "${COST_FROM:?UTC start, for example 2026-10-25 00:00:00}"
  : "${COST_TO:?UTC end, for example 2026-10-25 01:00:00}"
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
```

Invoke it with the selected interval:

```bash
COST_FROM='2026-10-25 00:00:00' COST_TO='2026-10-25 01:00:00' cost_backfill
```

Record each successful interval privately. Repeat a failed or overlapping interval
in full: event queries deduplicate exact identities and scope queries merge second
sets. Repetition can add physical rows until TTL, but cannot add logical usage.
Neither a successful command nor ledger 007 activates reads.

Views capture new inserts, including late arrivals. Replica fetches do not replace
installing the views at every ingestion destination. A failed dependent view can
leave a gap despite source rows existing: reconcile the affected raw interval and
check replica queues before treating that interval as ready.

## 3. Verify and activate

Before activation:

1. Confirm the schema contract on every serving replica, healthy replication and
   both ingestion views on every writable replica.
2. Compare raw versus typed query results and folded API fields for bounded,
   closed intervals using `dashboard/server/compareCodexCost.js`. Include all
   users, user filters, models, missing usage and time boundaries.
3. Cover every historical interval from the proposed boundary through view
   installation. Reconcile any insertion failures and verify a closed interval
   ingested after installation. Sample parity alone does not prove full coverage.
4. Keep the verified boundary and evidence in the private deployment record.

The comparison command uses the normal server `CH_*` configuration and requires
a database session with readonly enabled. Supply credentials through the existing
secret environment, never command arguments. It prints counts and match status,
not identities or telemetry:

```bash
node dashboard/server/compareCodexCost.js \
  --from 2026-10-25T00:00:00Z --to 2026-10-25T01:00:00Z
```

Optional `--user-exact`, `--model-exact` and `--backend` use existing bound filter
semantics. Use closed, settled intervals: live writes between the two sequential
queries can legitimately produce a mismatch. A mismatch or query error exits
nonzero and blocks activation.

Set Terraform `codex_cost_read_from` or runtime `CODEX_COST_READ_FROM` to the
verified boundary, for example `2026-10-25T00:00:00Z`, and roll out the application.
Only ranges starting at or after it use typed data; earlier or crossing ranges
use raw logs. Invalid timestamp configuration fails startup. Query failures after
activation surface normally; there is no hidden retry against raw logs.

## Rollback and maintenance

Unset `CODEX_COST_READ_FROM` and roll out the application to restore raw reads.
Keep the new tables and views while investigating. Image rollback does not undo
DDL, and deleting a ledger record does not repair data.

Changes to stored classification, dimensions, identity or token parsing require a
new schema version and migration; changing the runtime price catalog does not.
Never change the v1 insertion transform in place on an activated installation.

Regenerate and verify declarations after development changes:

```bash
node scripts/generate-codex-cost-schema.mjs
python3 scripts/build-schema-contract.py
node scripts/generate-codex-cost-schema.mjs --check
python3 scripts/test-codex-cost-schema.py
```

`COST_BENCHMARK=1` on the last command adds a synthetic comparison. It measures a
single isolated query workload, not production concurrency or monthly capacity.
