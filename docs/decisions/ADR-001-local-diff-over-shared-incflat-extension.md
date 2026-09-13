# ADR-001: Keep new counter dimensions local to their queries

- Status: Accepted
- Date: 2026-08-11
- Reconciled: 2026-09-13

## Context

The 2026-08-11 telemetry sync added version-cohort integrity endpoints to compare sessions
and cost/token ratios across client versions. A suspected pre-2.1.214 counting problem was
a reason to inspect cohorts, not a finding that every older session was incorrect.

The shared `incFlat()`/`incBucketed()` helpers in
[queries.js](../../dashboard/server/queries.js) already supported cumulative differencing
and delta summation for many consumers. Adding `AppVersion` to their grouping keys could
split rows used by downstream joins and change existing KPI behavior. Their boundary,
lookback, and raw/rollup behavior made that a broad change for a narrow diagnostic need.

## Decision and rationale

Keep new dimensions in self-contained raw-table queries unless a separately reviewed design
justifies extending the shared helpers. Reuse the established counter-difference formula and
`LOOKBACK_DAYS` policy locally rather than silently changing the shared result grain.

In current code, `versionCohortCost()` performs the local cumulative/delta calculation with
`AppVersion`; `versionCohortSessions()` counts distinct `SessionId` values directly and does
**not** need a counter-difference formula. Both read raw metrics rather than relying on an
hourly rollup whose historical version fields may be incomplete.

## Alternatives and consequences

Widening the shared `GROUP BY` was rejected for this change because a consumer expecting one
row per existing key could receive split/duplicate join inputs. The original decision accepted
extra raw scans for infrequently used integrity checks instead of optimizing every query
through the rollup. Its historical estimate of roughly 40 consumers and an 86-fold rollup
row reduction described that code/data snapshot, not a current performance guarantee.

Local formulas can drift: a change to counter semantics must inspect these copies as well
as the shared helpers. The original suggestion to reconsider after a third consumer was a
review trigger, not a hard prohibition. Current effort, language, agent, and project queries
also use justified local calculations; their existence does not authorize a mechanical
shared-helper rewrite. Evaluate reuse against actual dimensions, joins, and query cost.

Follow [server guidance](../../dashboard/server/AGENTS.md) and the
[data reference](../reference/data.md) for the maintained contract. Tests in
[queries.test.js](../../dashboard/server/queries.test.js) cover SQL/boundary contracts;
source structure alone does not establish live query equality or performance.
