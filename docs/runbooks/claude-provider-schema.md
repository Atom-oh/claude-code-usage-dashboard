# Runbook: Claude session providers

## Contract

Claude Code v2.1.317+ attaches `anthropic.provider` to every metric, event and span.
Migration 009 adds `claude_session_providers_v1` and its ingestion view, which keep
only `(SessionId, Provider, hour)` membership from `otel_metrics_sum`. No values,
emails or other attributes are stored, and repeated delivery or backfill overlap
cannot change results (ReplacingMergeTree keys only). Retention matches the hourly
rollup (180 days, DELETE only).

No dashboard query reads the table yet. The read path, its `CLAUDE_PROVIDER_GROUPS`
flag and Terraform variable ship in the companion grouping release; until then channels
use the model/organization heuristic in
[Claude channels](../reference/data.md#claude-channels-users-and-projects), and schema
installation changes no query.

Observed values on 2026-11-04 were `bedrock` and `firstParty`. Other values (for
example Vertex or gateway routes) fall back to the heuristic until they are observed
and classified explicitly.

## Install and backfill

Follow the snapshot, replica and privilege checks in the
[cost schema runbook](codex-cost-schema.md#1-install-without-activating-reads), using the
stable migration identity rather than the collector identity.

1. Require ledger 004. Execute `clickhouse-migration-009.sql` once through the selected
   writer connection, then verify the table and view on every replica.
2. Confirm the view uses explicit `SQL SECURITY DEFINER`, its creator still exists, and
   collector inserts into `otel_metrics_sum` continue without new grants.
3. Run `clickhouse-backfill-009.sql` serially on one replica per shard with bound UTC
   `backfillFrom`/`backfillTo` (positive, at most one day each). Only rows carrying the
   attribute qualify, so start at the first v2.1.317 data (2026-11-03 for the reference
   deployment) and continue through installation plus one settled hour.
4. Compare `SELECT SessionId, Provider, hour` from the table (with `FINAL`) against the
   same distinct triples from raw `otel_metrics_sum` for the backfilled window. Any
   difference blocks activation.

Sessions outside the backfilled window keep the heuristic; that is a coverage gap, not an
error. Expired raw rows cannot be reconstructed.

## Activation

Activation requires the companion grouping release; this release has no flag to set.
Install and backfill may run first, and the retained table/view is unaffected by later
activation. A transform change requires a new table version and migration.
