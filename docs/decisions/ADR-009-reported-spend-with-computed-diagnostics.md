# ADR-009: Client-reported spend with computed diagnostics

Date: 2026-09-10
Status: Accepted for the requested cost correction

Numbering: ADR-008 is already used by the parallel cache-policy work at `61a903e`
(`claude/bedrock-cache-cost-error-vpjgfc`); this decision uses 009 to avoid reusing that number.

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

Apply the user's final scope: change only `costEfficiency.js` and frontend consumption.
`TOKEN_SUMS` already selects `reported_cost` and `rollupComputedCost()` already sums it.
Keep `queries.js`, SQL, `pricing.js` and its rollups unchanged, with no server display/status
protocol. Preserve existing `cost` and summary `computed_cost` as token-priced diagnostics.

`costEfficiency.js` keeps computed `cost`/`unpriced` and uses `reported_cost` for the existing
`cost_per_loc` and `cost_per_commit` fields. Its `reported_unpriced` flag is separate from
server price-table coverage. The frontend selects the existing report directly, preserving
the computed amount in view rows for comparison.

A zero report with positive token usage is treated like an unpriced report, because the
client might not know a new model's rate. Missing/invalid reports are also unavailable;
zero without token usage is valid. Consumer folds preserve detected unpriced pieces instead
of presenting a partial subtotal as a complete amount. Existing SQL aggregation can conceal
missing user/session/request reports inside a positive aggregate; this change does not add
per-request coverage detection.

Unknown-price models with valid reported amounts remain in spend views. Cache-tier
decomposition and version diagnostics retain their computed basis and show the TTL assumption.
Productivity scores remain unchanged.

## Consequences

No provider TTL, Collector, SQL, pricing/rollup, ClickHouse schema or infrastructure change
is needed. The only changed efficiency-field meanings are the two reported unit-cost ratios.
Agent sorting in SQL/aggregation is also unchanged: the frontend ranks only the subset
returned by the existing computed-cost top-30 cutoff, and labels it accordingly.

Legitimate free usage with positive tokens may require operator verification because the
existing aggregate cannot distinguish it from missing cost telemetry. Full per-request
coverage and invoice reconciliation remain separate work; raw API body logging stays disabled.
