# ADR-017: Model-prefix backend resolution and a computed-cost fallback for missing reports

Status: accepted, 2026-09-25, following the user's explicit request. Amended 2026-10-07 for
non-Anthropic models used through Claude Code (see the amendment below).

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

## Amendment (2026-10-07): non-Anthropic models used through Claude Code

Accepted 2026-10-07, following the user's explicit request. Narrows
[ADR-009](ADR-009-reported-spend-with-computed-diagnostics.md) and the Claude fallback above
for non-Anthropic models only.

### Context

Claude Code can call non-Anthropic Bedrock models (OpenAI, xAI, Z.ai and others, for
example through an inferplane gateway). It prices models it does not know with its default
Opus rates (opus-5 or opus-5-5, depending on the client version), so its `cost.usage`
counter and `api_request` `cost_usd` are not usable reports for them. On 2026-10-07, one
`us.openai.gpt-6-luna` request (361,675 cache-write and 558 output tokens) reported $1.8195.
The gateway priced the same request at the AWS long-context list rate: $0.0999, about 18x
lower. Over 30 days, Claude Code reported about $775 for these models. Recomputed at AWS
list rates, gpt-6-luna fell from $106 to $4, grok-4.6 from $197 to $80, and gpt-6-sol from
$448 to $368. For Anthropic models, reports stayed between the five-minute and one-hour
cache-write recomputations; that comparison is ADR-009's evidence and is unchanged.

### Decision

For Claude rows whose normalized model does not start with `claude-`, spend is the AWS
list-price estimate from the Codex price table (`codexPricing.js`), not Claude Code's report:

- Per (session, normalized model), `factor = Σ AWS estimate / Σ reported cost_usd` over
  `api_request` logs in the query window. Each request is priced with its own context tier,
  using inclusive input (input + cache read + cache write) against the model's limit. The
  window is `[prevFrom ?? from, to)` (`nonAnthropicCost.js`).
- Counter `cost.usage` increments for those rows are multiplied by the factor in SQL
  (`nacCostSql()`), wherever `queries.js` sums them: `TOKEN_SUMS`, the period comparison,
  effort, agent, version-cohort and project views. The `queries.js` query wrapper adds the
  factor parameters to any query that references them.
- No logs, any unpriced or invalid request, or a zero report gives factor 0. The existing
  zero-report-with-tokens rule then shows the cost as unavailable, never as $0 and never at
  the inflated report.
- `/api/clients/overview` labels these rows `aws_list_estimate`. A client total that combines
  them with Anthropic reports is `mixed`.

Anthropic models keep Claude Code's report unchanged.

### Consequences

- Non-Anthropic Claude spend becomes a labelled AWS list estimate, like Codex. It is not an
  invoice: no Flex/Priority tier, discounts or gateway-side routing are visible.
- The factor is exact per request because Claude Code's report is a fixed rate times tokens.
  It assumes the counters' requests have the same mix as the logged ones. Missing logs make
  the cost unavailable rather than wrong. A sub-split (user or day) of one session-model
  inherits that session's ratio.
- Models with no Codex-table rate (for example `zai.glm-5`) are unavailable until a rate is
  added. Self-hosted models stay unpriced.
- Each view that prices Claude counters adds one `api_request` log scan for its window,
  memoized for 60 seconds per window.
- Out of scope: the Bedrock regional premium for Anthropic models (Claude Code reports global
  rates; this needs session routing evidence), the diagnostic
  `/api/reliability/reported-vs-computed` (it keeps raw reports to compare them), and SQL chat
  answers, which still read raw counters.

### Verification

`nonAnthropicCost.test.js` covers the tier, duplicate deliveries, unpriced inputs and
parameter binding. `clientSql.test.js` (isolated ClickHouse) inserts counters and logs and
checks: a luna session prices at $0.0999 in `/api/clients/overview`, `costByModel` and
`costByModelCompare`; a session without logs is unavailable; Claude Sonnet keeps its $0.50
report. A read-only run against production reproduced the gateway's per-request luna cost
and the per-model totals above.
