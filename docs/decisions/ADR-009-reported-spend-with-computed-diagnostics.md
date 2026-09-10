# ADR-009: Client-reported spend with computed diagnostics

Date: 2026-09-10
Status: Accepted for the requested cost correction

## Context

The dashboard applies one cache-write TTL assumption to all token usage. The September 7
workshop analysis found that pricing five-minute writes at the one-hour rate increased its
estimate from $6,640.33 to $7,817.28; the client reported $6,647.79. These are estimates,
not independently verified invoice amounts.

The stored token types do not split five-minute and one-hour writes. Replacing one global
TTL with another, or a channel default, cannot price mixed TTL traffic exactly. Conversely,
the September 3 investigation documented client-version-dependent under-reporting, so a
reported amount is not a billing source of truth either.

## Decision

Use client-reported spend for expenditure views, sorting, exports and unit-cost metrics.
Keep the existing API `cost` and summary `computed_cost` as token-priced diagnostics.
An additive `display_cost` carries the selected reported amount and `reported_cost_status`
explains unavailable, ambiguous-zero or partial results.

Absent, invalid or negative reports are unavailable. A zero report with positive token usage
is ambiguous and is not displayed as a confirmed free request. Zero with no usage is valid.
A fold with an unavailable cost component has a null display total; no computed fallback is
substituted silently. Positive reported amounts are still not proof of complete ingestion.

Unknown-price models with valid reported amounts remain in spend views. Cache-tier
decomposition and version diagnostics retain their computed basis and show the TTL assumption.
Productivity scores remain unchanged.

## Consequences

No provider TTL, Collector, ClickHouse schema or deployment infrastructure change is needed.
Existing API consumers retain their computed fields. Display consumers adopt the additive
contract together so totals, rankings, previous-period comparisons and CSVs agree.

Legitimate free usage with positive tokens may require operator verification because the
existing aggregate cannot distinguish it from missing cost telemetry. Full per-request
coverage and invoice reconciliation remain separate work; raw API body logging stays disabled.
