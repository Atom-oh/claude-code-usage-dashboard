# ADR-012: Selectable coding-client observability

Status: accepted source design, amended 2026-09-15, 2026-09-16 and 2026-09-17. Initial date: 2026-09-14.
Deployment is separate.

The 2026-09-16 layout amendment replaces Claude-default detail and All/Codex single-page
navigation: all clients share nine routes and metrics. Claude `view=detail` retains
advanced/A/B pages. [Frontend](../reference/frontend.md) owns route/filter compatibility.
That layout amendment changed no cost semantics, collection, user-selected models or effort.

Claude and Codex have different telemetry and cost surfaces. Treating model names or
Claude's inferred enterprise/bedrock channels as client identity would mix populations
and invent a Codex enterprise comparison.

Select clients independently through activation flags and use a common client API/UI.
Retain Claude's cumulative-counter queries and [reported-spend decision](ADR-009-reported-spend-with-computed-diagnostics.md).
Use Codex structured usage-bearing completion logs in the existing schema, promoting
observed timestamps when needed and deduplicating transport delivery.

The 2026-09-15 amendment replaces the initial logs-only collection scope: enable
native metrics and traces as separate diagnostics, with four dedicated metric tables
and existing trace storage. They never become a second usage/cost feed. Native
runtime verification supports the expansion; pinned-exporter privacy and field-presence
limits remain explicit in the collection runbook.

Codex cost is an AWS list-price estimate with cache subsets and request context/inference
tiers preserved. The initial design withheld affected folds for missing prices, invalid
components or activity without usage. The 2026-09-17
[known-cost subtotal decision](ADR-013-known-cost-subtotals.md) supersedes that aggregate
cost rule: sum usable amounts and disclose partial costs, while preserving token
missingness and all-unknown costs. Explicit zero remains zero; presence cannot prove
complete billing. Neither cost basis is an invoice or a validated productivity/ROI measure.

Bootstrap, collection, API and navigation must agree on enabled clients. Backend
metadata stays process-scoped; existing rows remain. Runtime hosted search is disabled
because execution failed in bounded testing. Raw endpoint success and local native CLI
fixtures do not prove live CLI authentication or complete production ingestion.

The [data reference](../reference/data.md), [API reference](../api-reference.md) and
[runbook](../runbooks/codex-telemetry.md) own implementation and recovery details;
[validation](../superpowers/plans/2026-09-14-client-observability.md) records checks.
