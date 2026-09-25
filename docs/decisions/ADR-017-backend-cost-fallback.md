# ADR-017: Model-prefix backend resolution and a computed-cost fallback for missing reports

Status: accepted, 2026-09-25, following the user's explicit request.

## Context

Multi-model Bedrock testing left many rows unpriced. Every Codex row carried the resource
tag `backend=bedrock-mantle`, inherited from a gateway, even for `global.`-prefixed models
that only exist on Bedrock Runtime — unpriced as a scope mismatch. Anthropic models routed
through Codex were unpriced as unknown (Codex's price table only covers OpenAI). Claude's
backend was never derived per row: a bedrock-channel session was always `bedrock-runtime`.

This reverses "model names never establish backend" and Claude's channel-only inference,
and adds a cost basis [ADR-009](ADR-009-reported-spend-with-computed-diagnostics.md) did
not contemplate: a token-priced estimate filling in only where no report exists.

## Decision

**Backend resolution** (`backend.js`, both clients): cross-region routing prefix
(`us.`/`us-gov.`/`eu.`/`apac.`/`jp.`/`au.`/`global.`) → `bedrock-runtime`; else a bare
vendor namespace (`anthropic.`, `openai.`, ...) ending in a letter before the dot →
`bedrock-mantle` (excludes a bare model's own versioned dot, e.g. `grok-4.6`); else the
resource tag if valid (Codex only); else `unknown`. Claude's enterprise short-circuit to
`anthropic` is unchanged; a bedrock-channel row with a bare, unrecognized model now
reports `unknown` instead of an assumed `bedrock-runtime`. The raw tag is unmodified;
only queries reinterpret it, retroactively.

**Codex fallback to the Claude price table** (`codexPricing.js`, mirrored in SQL by
`codexLogAggregates.js`): when backend/scope are valid but the model has no entry in the
Codex price table *at all*, and normalizes to a Claude key, price from the Claude table
(`price_source: "claude_table"`). A Codex entry missing rates for this scope/tier still
blocks the fallback — a scope mismatch, not a missing model.

**Computed-cost fallback for unusable Claude reports**, `/api/clients/overview` only: when
a report is `report_missing`/`report_zero_with_tokens` and tokens are known, price from
tokens (`computeCost`) when a rate exists — `cost_basis: "computed_estimate"` (or
`"mixed"`; `cost_estimated` counts these rows). Narrows ADR-009's "computed cost is
diagnostic-only" to this endpoint; legacy Cost/Executive/`spend.js` unchanged. Does not
amend [ADR-013](ADR-013-known-cost-subtotals.md)'s "no source is relabelled": an existing
report is never overwritten; the two new bases are disclosed, not a relabelling.

**Per-backend rate overrides**: `PRICING_JSON`/`CODEX_PRICING_JSON` entries accept an
optional `backends` map for models whose rates differ by backend, field-by-field, never
derived from another override field.

## Consequences

- `global.`/region-prefixed Codex models price at the runtime rate; Anthropic models
  through Codex price from the Claude table.
- A Claude row with no usable report but known tokens/rate shows a disclosed estimate
  instead of `—`; the web trend chip, status, tooltip and table all disclose it.
- A bedrock-channel Claude row with a bare model reports `unknown` — live verification
  found zero such rows, so this is not a regression.
- Collection, the raw tag, and the legacy cost-basis contract are unchanged.

## Verification

Live queries (before/after): `global.openai.gpt-6-astra` and
`global.anthropic.claude-fable-5-1` moved from unpriced to priced; models with no rate
anywhere stayed `unknown_model`; no Claude row moved to `unknown`.
`codexLogCompaction.test.js` (real ClickHouse via Docker) confirms raw/compacted parity,
including the "partial Codex entry blocks the Claude fallback" case.

## References

- [API contract](../api-reference.md#coding-client-views)
- [Codex telemetry runbook](../runbooks/codex-telemetry.md)
- [Data reference](../reference/data.md)
