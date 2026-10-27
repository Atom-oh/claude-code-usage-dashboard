# Runbook: Codex diagnostic states

## Contract

Migration 008 adds `codex_diagnostic_events_v1` and its ingestion view. Tools and
performance profiles can read these states after verified backfill. Covered
effort profiles use states for intermediate stream events and raw logs for every
other event. Default insights retain raw logs. Cost overview activation is independent.

Activation and configuration validation require the companion application that
imports `codexDiagnosticSource.js` from `codexLogAggregates.js`. Schema installation
alone neither changes queries nor validates the application's read boundary.

The table retains exact identity sets at second grain, filter dimensions, compact
diagnostic attributes and first/last timestamps. Identity uses the same full
timestamp and sorted resource/log maps as the raw query. Reads merge aggregate
states with `FINAL` before finalizing weights. Repeated delivery and backfill/live
overlap do not multiply logical counts. Weighted latency includes intermediate
stream events; no sampling or completion-only substitution is permitted.

State bytes represent sensitive identities and must have the same access,
retention and backup protections as raw telemetry. They are not public report
artifacts. No new collector permission is required.
The ingestion view adds work from installation onward, including while reads use
raw logs. Monitor insert failures, latency, parts, merges, replication and free
disk during installation and normal operation, as well as backfill.

## Install and backfill

Follow the snapshot, replica, privilege and ingestion checks in the
[cost schema runbook](codex-cost-schema.md#1-install-without-activating-reads).
Use the stable migration identity, not the collector-facing identity. Keep
`CODEX_DIAGNOSTIC_READ_FROM` empty during installation.

1. Require ledger 004. Execute `clickhouse-migration-008.sql` once through the
   selected writer connection. Cluster DDL creates the table/view on every
   replica; verify every replica before continuing.
2. Confirm the view uses explicit `SQL SECURITY DEFINER`, its creator still
   exists, and collector inserts continue without granting raw-log SELECT.
3. Run `clickhouse-backfill-008.sql` serially on one replica per shard with bound
   `backfillFrom`/`backfillTo` UTC seconds. Each interval must be positive and at
   most one day. Start with one hour, using the credential-safe helper and
   resource limits from the cost runbook, substituting this backfill filename.
4. Record successful intervals privately. Monitor parts, merges, replication,
   free disk and ingestion errors between intervals. Reduce batch duration if
   pressure increases. Retry interrupted intervals in full; do not force merges
   or raise server limits to hide pressure.
5. Compare raw and state SQL/folded results for every closed interval through
   view installation and a settled post-install interval. Include all users,
   user/model/backend filters, model-less records within matching sessions,
   duplicates and exact range boundaries. Query errors or differences block
   activation.

Table existence, ledger 008 and a few samples do not establish historical
coverage. Dependent-view failures require backfilling affected raw intervals.
Expired raw records cannot be reconstructed.

## Activate and operate

Set Terraform `codex_diagnostic_read_from` or application
`CODEX_DIAGNOSTIC_READ_FROM` to the earliest verified UTC second, then deploy the
companion application. Whole tools/performance ranges beginning at or after
that boundary use states; covered effort ranges use the hybrid source described
above. Earlier ranges keep raw queries. Invalid configuration
fails startup; query failures surface instead of silently retrying raw logs.

Measure the deployed query and page within the unchanged reader limits. Schema
creation and synthetic tests do not demonstrate production latency.

Unset the boundary and redeploy to roll back reads. Retain tables/views for
investigation. Image rollback does not undo schema changes. A stored transform
change requires a new table version and migration; do not mutate activated v1
semantics. Verify the generated compatibility contract before applying a new
schema initializer.

Read rollback does not remove ingestion overhead. If the view degrades ingestion,
use the [dependent-view incident procedure](codex-cost-schema.md#rollback-and-maintenance):
save its exact definition, coordinate ingress, and detach only the affected view.
Detachment creates a coverage gap and fails schema verification. Keep state reads
disabled until the view is restored, the gap is backfilled and parity is verified.

## Development checks

```bash
node scripts/generate-codex-diagnostic-schema.mjs
python3 scripts/build-schema-contract.py
node scripts/generate-codex-diagnostic-schema.mjs --check
python3 scripts/test-codex-diagnostic-schema.py
python3 scripts/test-schema-lifecycle.py
```
