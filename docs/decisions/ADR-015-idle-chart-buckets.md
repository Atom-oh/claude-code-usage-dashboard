# ADR-015: Keep idle buckets and unknown usage distinct

Status: accepted, 2026-09-20.

## Context

Hourly charts appeared disconnected. Claude's client query discarded unchanged
counters; the shared chart treated absent buckets as missing measurements.
The user wants hourly usage with zero during inactivity, not a cumulative chart.

## Decision

- Preserve Claude timeline observations with zero counter increments. Check token
  and cost presence independently per session/user/model/backend scope. Missing
  signals remain null; mixed scopes retain known zero subtotals with partial flags.
- Verify actual in-window samples in the first partial rollup hour. A baseline
  stitch alone is not observation evidence. Counter differences, temporality,
  active populations, totals and non-timeline breakdowns retain their semantics.
- Compact idle observations into one row per bucket. They do not increment
  `observed_records` or active users/sessions. A timeline containing only observed
  zeros still renders.
- Within bounded shared charts, an absent bucket for a client observed elsewhere
  in the range displays zero **recorded usage**, with that qualifier in its tooltip.
  This includes Codex's event-derived usage. Existing null token/cost values remain
  gaps with an unavailable tooltip; explicit measured zero remains zero.
- Do not create a series for a client with no rows, fabricate cumulative Codex
  counters, add diagnostic metrics/traces to usage, or replace API totals.
  Bound grid expansion to 5,000 intervals; unbounded/invalid ranges retain sparse
  behavior. UTC bucket positions and browser-local labels remain.

## Limits

Zero recorded usage does not prove actual inactivity or complete collection.
Entirely dropped events cannot be distinguished from no activity by completion
logs alone. This display change neither recovers those events nor repairs historic
totals. The UI help states this limit.

This supersedes only the empty-period chart behavior in
[ADR-014](ADR-014-observed-token-subtotals.md). Its observed-subtotal, canonical-token
and cost contracts remain. No storage, schema or Collector migration is required.
