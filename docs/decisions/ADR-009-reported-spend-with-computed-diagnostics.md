# ADR-009: Client-reported spend with opt-in computed diagnostics

- Status: Accepted
- Date: 2026-09-10
- Reconciled: 2026-09-13

## Context

The September 7 workshop analysis compared a $7,817.28 estimate under one-hour cache-write
pricing with a $6,640.33 recalculation under five-minute pricing; the client reported
$6,647.79. These were telemetry-based comparisons, not independently verified invoice
amounts. The [September 10 review](../cost-accuracy-review-2026-09-10.md) records their
provenance and limits.

Stored token types do not separate five-minute and one-hour writes. Replacing one global
TTL assumption with another cannot price mixed traffic exactly. Earlier client-version
under-reporting also means reported cost is not a billing source of truth or a guaranteed
lower bound. The number 009 was reserved to avoid a parallel cache-policy decision's number;
that historical reservation does not imply ADR-008 is present in this checkout.

## Decision and current contract

Make reported spend primary in consumers while retaining token-priced diagnostics. The
original correction scope was `costEfficiency.js` and frontend consumption, leaving SQL,
`pricing.js`, and rollups unchanged. `TOKEN_SUMS` already provides `reported_cost`, and
`rollupComputedCost()` preserves its sum. No new server display/status protocol is required.

[spend.js](../../dashboard/web/src/spend.js) selects `reported_cost` into frontend view rows
and preserves original `cost`/`computed_cost` and previous-period values for comparison.
API `cost` and summary `computed_cost` keep their token-price meaning. Do not overwrite
those API fields with reports or make the reported/computed ratio trivially equal to one.

[Cost.jsx](../../dashboard/web/src/pages/Cost.jsx) starts with `showComputed=false`.
Computed columns and their CSV columns, effort annotations, computed totals, and token-tier
charts are opt-in diagnostics. Toggling the mode remounts affected tables and resets their
sort state, including hidden computed-column sorting. CSV follows the visible table's
columns/order. Reliability diagnostics retain both cost bases independently.

[costEfficiency.js](../../dashboard/server/costEfficiency.js) joins by user plus channel,
keeps computed `cost`/`unpriced`, and calculates `cost_per_loc`/`cost_per_commit` from the
report. `reported_unpriced` is distinct from missing model prices. Productivity scoring is
unchanged; neither score nor cost ratios establish causal productivity or ROI.

## Missingness and limits

Missing, invalid, or negative reports are unavailable. A zero report with positive token
usage is also treated as unavailable because it can mean the client lacks a model price;
zero without token usage is valid. Consumer folds preserve detected missing components
instead of presenting a partial subtotal as complete. Legitimate free usage with tokens
may therefore require operator verification.

A valid report remains usable when the local diagnostic price table lacks that model.
Conversely, a positive aggregate can conceal missing requests, sessions, or users: this
change does not add per-request coverage detection. Neither report nor computed value
promises invoice equality or a billing lower bound.

The existing `agentCost()` aggregation sorts by computed cost and returns only 30 agents.
The UI ranks reports within that returned subset; it is not a global reported-cost top 30.
Cache-tier breakdowns remain computed estimates with a visible TTL assumption, not a
reconstruction of reported spend by tier. The checked-in bootstrap does not enable raw
API body logging; verify the actual client configuration independently. Collector,
provider TTL, schema, and infrastructure changes are separate work, and deployed state
must be verified independently.
