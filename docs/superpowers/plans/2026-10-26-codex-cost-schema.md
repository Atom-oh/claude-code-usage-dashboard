# Codex Cost Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Read Codex cost overviews from typed events and compact scope evidence.

**Architecture:** Add two versioned tables and materialized views. Preserve
existing SQL grouping/pricing/folding and activate only for explicitly verified
coverage through `CODEX_COST_READ_FROM`.

**Tech Stack:** Node.js ESM, ClickHouse 24.8, existing Terraform schema bootstrap.

**Spec:** `docs/superpowers/specs/2026-10-26-codex-cost-schema-design.md`

## Global constraints

- Preserve completion-log accounting, exact identity deduplication and token validity.
- Raw queries remain the default; no automatic production DDL or data backfill.
- Do not alter Claude, native metric accounting, or unrelated work.
- User authorized regression test creation/execution.

## Review focus

- Model-less scope evidence must retain session/user/project matching.
- Repeated backfill/live inserts must not double usage or change coverage.
- Missing, invalid and valid-zero tokens must remain distinct.
- Second-resolution range edges must not invent activity.
- Schema existence must not silently assert historical completeness.

### 1. Storage and query source

Files: `dashboard/server/codexCostSchema.js`, `codexCostSource.js`,
`codexCostSource.test.js`, `clientMetrics.js`.

- [x] Add failing source/activation tests.
- [x] Generate fact/scope transformations and additive DDL.
- [x] Add typed-source selection to the existing Codex cost query.
- [x] Pass tests for activation boundaries, filters, and SQL source contracts.

### 2. Real SQL parity

Files: `scripts/test-codex-cost-schema.mjs`.

- [x] Add isolated ClickHouse fixture coverage for the spec's edge cases.
- [x] Verify raw versus new SQL and folded responses before and after backfill.
- [x] Run server regressions and a bounded synthetic performance comparison.

### 3. Installation and operations

Files: bootstrap SQL copies, `clickhouse-migration-007.sql`,
`scripts/generate-codex-cost-schema.mjs`, `infra/files/clickhouse-schema-contract.sql`,
activation configuration and migration runbook.

- [x] Keep fresh/bootstrap/migration definitions generated from one source.
- [x] Document bounded backfill, replica verification, activation and rollback.
- [x] Run schema structure checks and review the complete change.

## Progress

- Implemented in isolated branch `feat/codex-cost-schema-20261026`.
- Native ClickHouse 24.8.14: 105 raw/fact SQL and folded-response comparisons,
  plus operator comparison checks, passed.
- Server suite: 672 passed, five explicitly skipped, no failures.
- Schema lifecycle: 19 passed, including three-replica bootstrap and read-only
  verification of existing installations. Terraform validation passed.
- Existing native client SQL suites: 111 passed. Project harness: 124 passed,
  eight expected tooling skips. Documentation checks passed.
- Fresh independent code review approved after correcting the operator comparison
  to use the same native time resolution as the API (red/green regression).
- Deduplication uses explicit identity grouping: native tests exposed ClickHouse
  pruning an otherwise unused identity from a `DISTINCT` union input.
- Replaced map-capturing membership lambdas with `hasAny(mapKeys(...))` after a
  bulk-insert fixture exceeded its memory ceiling. The same bounded fixture passed.
- Cost tables match the raw log's 90-day retention, with replicated cold move at
  45 days. No additional full-attribute retention was introduced.
- No production DDL, historical backfill, image deployment or read activation is
  established by these local checks. See the cost-schema runbook for those steps.
- Integration is split into storage and application PRs to stay within the
  existing complete-diff AI review ceiling without omitting generated SQL.

## Synthetic performance evidence

One isolated ClickHouse 24.8 container, one CPU, 1.5 GiB container memory; query
limits: one thread and 800 MB. Added 202,000 synthetic events (200,000 deltas and
2,000 completions), 20 users, 200 sessions, approximately 34 minutes of activity,
plus the small edge-case fixture. The query range covers October 1–26, but this
does not represent a month of sustained activity. Three measured runs per source
follow one excluded warm-up; values below are medians.

| Scope | Raw duration | Typed duration | Raw logical bytes | Typed logical bytes |
|---|---:|---:|---:|---:|
| All users | 412 ms | 74 ms | 372,071,034 | 2,469,101 |
| Exact user | 303 ms | 67 ms | 383,954,164 | 2,429,623 |

Observed speedups were 5.6× and 4.5×, with about 99.3% fewer logical bytes read.
These are query measurements, not end-to-end page latency, production results,
or a 140-concurrent-user capacity claim. Insights/Effort queries are unchanged.
