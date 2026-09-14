# ADR-012: Selectable coding-client observability

Status: accepted source design. Date: 2026-09-14. Deployment is separate.

Claude and Codex have different telemetry and cost surfaces. Treating model names or
Claude's inferred enterprise/bedrock channels as client identity would mix populations
and invent a Codex enterprise comparison.

Select clients independently through activation flags and use a common client API/UI.
Retain Claude's cumulative-counter queries and [reported-spend decision](ADR-009-reported-spend-with-computed-diagnostics.md).
Use Codex structured usage-bearing completion logs in the existing schema, promoting
observed timestamps when needed and deduplicating transport delivery. Disable its
metric/trace exporters to avoid a second usage feed or new histogram schema.

Codex cost is an AWS list-price estimate with cache subsets and request context/inference
tiers preserved. Missing prices, invalid components or activity without usage make
affected folds unavailable. Explicit zero remains zero; presence cannot prove complete
billing. Neither cost basis is an invoice or a validated productivity/ROI measure.

Bootstrap, collection, API and navigation must agree on enabled clients. Backend
metadata stays process-scoped; existing rows remain. Runtime hosted search is disabled
because execution failed in bounded testing. Raw endpoint success and local native CLI
fixtures do not prove live CLI authentication or complete production ingestion.

The [data reference](../reference/data.md), [API reference](../api-reference.md) and
[runbook](../runbooks/codex-telemetry.md) own implementation and recovery details;
[validation](../superpowers/plans/2026-09-14-client-observability.md) records checks.
