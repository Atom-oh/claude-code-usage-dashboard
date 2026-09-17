# ADR-013: Show known cost subtotals with missing-cost disclosure

Status: accepted, 2026-09-17, following the user's explicit request.

## Context

The shared client dashboard hid an entire cost total or time bucket when one record
had no usable cost. This discarded visible, usable reports and estimates alongside
the missing data. The user prefers the sum of available costs even when it is incomplete.

## Options considered

1. Keep withholding mixed totals. This avoids partial amounts but hides known costs.
2. Treat every missing cost as zero. This produces numbers but falsely reports unknown
   usage as free.
3. Sum available amounts and disclose exclusions. This retains useful observations
   without assigning a monetary value to unknown records.

## Decision

Use option 3 for `/api/clients/overview`, its shared pages and exports, and Codex
detail costs from `/api/codex/insights`. This supersedes only the aggregate cost
unavailability rule in [ADR-012](ADR-012-selectable-client-observability.md).

- `cost_usd` is the sum of usable costs. Claude uses client reports; Codex keeps
  AWS list-price estimates derived from valid completion usage. No source is relabelled.
- Positive Claude reports remain usable when token fields are missing. Zero reports
  still require known zero usage; a zero report with positive tokens remains unpriced.
- Groups with only unpriced evidence remain null. A measured zero remains zero, even
  alongside an excluded record. Existing empty-response behavior is retained.
- `cost_partial` and existing `unpriced`/quality counts disclose missing costs or an
  aggregate that cannot be represented safely. A false flag is not proof of complete
  telemetry or billing.
- Separate valid and invalid Codex usage before SQL token aggregation so an invalid
  response cannot erase another response's priceable components in the same group.
- Cost unit values use the known subtotal and the existing observed denominator;
  display them as partial when applicable. Zero or unavailable denominators remain
  unavailable. Codex detail session units still require usable session identity.
- Tokens, token fractions, non-cost signals, pricing, deduplication and counter
  temporality retain their existing missingness rules.

Codex detail scope markers continue to come from the same read as priced events.
Include their session IDs in observed-session counts when displaying partial unit
costs. Separate count/latency summaries cannot establish complete cost coverage.

## Consequences

Mixed totals, charts and Effort costs remain useful despite excluded records. The
UI and CSV identify partial cost values and keep unpriced counts visible. Partial
unit values describe known costs over observed activity; they are not full-cost
efficiency estimates. Neither cost basis establishes an invoice or causal productivity.

This does not change collection, model choice, rates, or the opt-in legacy Claude
detail/LOC/commit cost contracts. Those endpoints retain their separately documented
report policies.

## References

- [API contract](../api-reference.md#coding-client-views)
- [Codex detail semantics](../reference/codex-observability.md)
- [Claude reported-spend scope](ADR-009-reported-spend-with-computed-diagnostics.md)
