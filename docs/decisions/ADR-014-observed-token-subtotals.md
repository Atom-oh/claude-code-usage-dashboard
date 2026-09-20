# ADR-014: Display observed token subtotals with coverage status

Status: accepted, 2026-09-19.

## Context

The user still sees token gaps: one missing usage scope makes canonical `tokens`
null even alongside valid completions. Display known counts with coverage status.

## Decision

Add `observed_tokens`/`tokens_partial` to shared rollups and Codex summary/Effort rows
for displays, charts and exports. Canonical `tokens`/components stay strict for analysis.

- A Codex observation counts a safe, nonnegative integer input/output pair from the
  same usage-bearing completion. Input already contains cache subsets; output already
  contains reasoning. Neither subset is added again. Pricing availability and cache
  metadata do not erase a usable pair.
- Claude observations reuse existing counter-derived token totals. Counter SQL,
  temporality, identity, deduplication and range rules are unchanged.
- Sum usable pairs. All-unknown remains null; measured zero remains zero alongside
  exclusions. Unsafe individual or aggregate counts are unavailable, not rounded
  or replaced with a partial prefix of an overflowing sum.
- `tokens_partial` discloses unknown pairs, missing usage scopes, incomplete canonical
  token validation or overflow. A false flag does not prove collection completeness.
  Missing model prices alone do not imply missing tokens.
- Separate pair-valid and pair-unknown Codex usage before SQL sums, including within
  malformed full-usage groups, so one unknown input cannot erase another known pair.
  Preserve overflow of individually safe pairs inside a SQL group through every
  affected rollup; it must not become an ordinary excluded unknown pair.
- Token-derived rates and composition ratios retain their existing canonical
  completeness checks. They are not recomputed from partial display subtotals.
- Detail counts and coverage derive from the same detail snapshot. Unattributed
  missing scopes affect summary coverage; Effort rows describe their observed
  completions and do not assign missing activity to an invented effort.

This supplements [ADR-013](ADR-013-known-cost-subtotals.md). Its cost policy and the
canonical token missingness contract remain intact. Legacy Claude detail/LOC/commit
endpoints are outside this change.

## Consequences

Tables/CSV retain numeric counts and separate coverage status. Legacy fallback to
`tokens` applies only when `observed_tokens` is absent, never when explicitly null.
Missing telemetry is not recovered. [ADR-015](ADR-015-idle-chart-buckets.md)
subsequently changes empty-period chart display while retaining explicit unknowns.

See [API](../api-reference.md#coding-client-views),
[data](../reference/data.md) and [Codex detail](../reference/codex-observability.md).
