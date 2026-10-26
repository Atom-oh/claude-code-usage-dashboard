# Codex cost storage

## Intent and constraints

Accelerate the Codex cost-view overview on existing ClickHouse 24.8 hardware.
Monthly queries currently parse and deduplicate large attribute maps and scan
streaming diagnostics to determine missing usage. Preserve the exact response
contract, filter semantics, missing/invalid token distinctions, pricing tiers,
and completion-log authority. Metrics and traces remain diagnostic.

The user authorized implementation and new regression tests. Implementation
choices below are the builder's, based on the preceding read-only investigation.
No DuckDB migration, hardware increase, or production activation is implied by
creating tables. Existing unrelated work must remain untouched.

## Storage

Introduce additive versioned tables and incremental materialized views:

- `codex_cost_events_v1`: meaningful cost-view events, including usage-bearing
  completions, completion-without-usage, failed streams, requests, tools,
  approvals, and TTFT records. Promote timestamp, emitting user (email then
  enduser.id), conversation, model, resolved backend, project, event name/kind,
  request rejection status, five numeric token values and validity bits.
  Retain exact canonical full resource/log identity as a String for deduplication
  across insert blocks and backfill/live overlap. Do not replace identity with a
  probabilistic hash or depend on background merges for correctness.
- `codex_cost_scope_v1`: all remaining `scope_evidence` records. Store minute,
  user, conversation, model, backend, project, event name, and the distinct
  seconds-within-minute as `AggregateFunction(groupUniqArray, UInt8)`.
  The original query uses second-resolution bounds; selecting seconds within
  the requested half-open interval preserves boundary presence exactly.
  No raw identities or event counts are required for this boolean evidence.

Sort by user then time/model/session. Partition monthly and match raw-log
retention: delete after 90 days, with a replicated cold move after 45 days.
No dollars are persisted: runtime pricing remains authoritative and can change
without rewriting storage. Parsing/classification SQL has one generator shared
by standalone, replicated-bootstrap, and numbered-migration artifacts.

## Query integration and activation

Only `clientOverview` with `client=codex` and `view=cost` selects the new source.
Reuse existing grouping, coverage windows, pricing, fold, response limits and
time rebucketing. Raw queries remain the default, and unchanged for Claude,
non-cost views, and Codex insights/Effort.

An explicit `CODEX_COST_READ_FROM` UTC timestamp selects facts only when the
whole requested range starts at or after that verified coverage boundary.
Malformed configuration fails clearly. Earlier/cross-boundary requests use raw
logs. Missing tables or query errors after activation must surface; never hide
errors with an expensive automatic retry against raw logs.

The operator sets the boundary only after creating both views on every replica,
performing bounded backfill from the same transformations, and checking equality
against raw queries. Table existence and migration ledger records alone do not
prove data coverage. Paused/failed ingestion and manual mutations require
reverification. Disabling the boundary restores the previous query source.

## Migration

Migration 007 is additive, requires the migration ledger, and records schema
completion separately from data readiness. Bootstrap schemas and their generated
metadata contract must agree. Backfill emits explicit bounded INSERT SELECT
statements using the same transformation as the live MVs; repeated ranges and
live overlap are safe because facts deduplicate at read and scope sets merge.
No unbounded backfill, POPULATE, old-table removal, or production DDL is automatic.

## Validation and scope limits

Use an isolated local ClickHouse 24.8 container, synthetic identities only.
Compare raw and fact SQL results and folded cost responses for duplicate inserts,
missing/invalid/zero tokens, fractional/negative/overflow inputs, cache/reasoning
subset errors, pricing thresholds, rejected requests, model-less evidence,
unknown events/setup records, user/model/backend filters, sub-minute boundaries,
and backfill/live overlap. Preserve the existing server suite.

Measure repeated synthetic raw versus fact queries separately from production
latency; report fixture size, settings and limitations. The Effort endpoint still
uses its existing raw-log contract. This change does not establish an end-to-end
monthly-page latency or 140-user capacity target.
