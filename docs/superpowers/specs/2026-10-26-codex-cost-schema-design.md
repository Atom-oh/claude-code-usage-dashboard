# Codex cost storage design — 2026-10-26

Approved scope: accelerate the Codex cost overview on existing ClickHouse 24.8
hardware and add regression tests. No DuckDB migration or hardware expansion.

- Versioned events promote dimensions, token values and validity. Timestamp plus
  canonical full original maps identify every event exactly; no hash/merge-based
  correctness. Scope sets retain observed seconds within each minute.
- Shared transforms drive live views and bounded backfill. User/time ordering,
  monthly partitions and raw-log retention apply. Prices stay runtime estimates.
- Companion application reads facts only for whole ranges within an explicitly
  verified UTC coverage boundary; errors surface and earlier ranges retain raw
  reads. Schema installation alone proves no historical coverage.

Current contracts: [data](../../reference/data.md) and
[runbook](../../runbooks/codex-cost-schema.md). Verify duplicate/overlap, invalid and
missing tokens, pricing tiers, filters and boundaries against raw SQL/folded APIs.
Synthetic query timings establish neither 140-user capacity nor monthly whole-page
latency; Insights/Effort retain their existing sources.
