# ADR-017: Model-prefix backend resolution and a computed-cost fallback for missing reports

Status: accepted, 2026-09-25, following the user's explicit request.

## Context

Multi-model Bedrock testing (calling several vendors' models through both Claude Code and
Codex on the same Bedrock account) left many rows unpriced in `/api/clients/overview` and
the per-family model cost trend panels. A live, read-only check against the running
ClickHouse cluster found the cause: every Codex row observed in the last 14 days carried
the resource-attribute tag `backend=bedrock-mantle`, inherited from a gateway process in
front of Codex, even for `global.`-prefixed models that only exist on Bedrock Runtime.
`global.openai.gpt-6-astra` (224k+ log rows) was unpriced as a scope mismatch; Anthropic
models routed through Codex (e.g. `global.anthropic.claude-fable-5-1`, 20k+ rows) were
unpriced as an unknown model, since Codex's own price table only covers OpenAI-family
models. Separately, Claude's backend was never derived per row at all: a bedrock-channel
session was always labelled `bedrock-runtime`, regardless of which model it actually called.

This reverses two documented invariants: "model names never establish backend"
(`docs/runbooks/codex-telemetry.md`, `collector-config.yaml`) and Claude's channel-only
backend inference (`queries.js`, `clientMetrics.js`). It also adds a new cost basis that
[ADR-009](ADR-009-reported-spend-with-computed-diagnostics.md) did not contemplate: a
token-priced estimate that fills in only where no client report exists at all, never in
place of a usable one.

## Decision

### Backend resolution (supersedes the model-name rule above)

Resolve `backend` from the model id prefix first, before consulting any resource-attribute
tag (`backend.js`, `resolveBackend`/`backendSql`):

1. A cross-region routing prefix (`us.`/`us-gov.`/`eu.`/`apac.`/`jp.`/`au.`/`global.`) means
   the request went through Bedrock Runtime's inference-profile routing → `bedrock-runtime`.
2. Otherwise, a bare vendor namespace (`anthropic.`, `openai.`, `xai.`, ...) → `bedrock-mantle`.
3. Otherwise (no dot-prefixed namespace — a bare `claude-*` model, or a short third-party
   id with no vendor prefix) fall back to the resource-attribute tag, when it is one of the
   two known values. Only Codex carries this tag; Claude has none.
4. Otherwise: `unknown`.

This applies uniformly to Codex (`clientMetrics.js`, `codexInsightsLogs.js`,
`codexLogAggregates.js`, `codexSignals.js`) and to Claude (`queries.js`, `clientMetrics.js`),
replacing Claude's old "bedrock channel is always `bedrock-runtime`" assumption — a
bedrock-channel Claude row with a bare, unrecognized model now reports `unknown` rather than
guessing `bedrock-runtime`. Claude's enterprise-channel short-circuit to `anthropic` is
unchanged: an enterprise session can only ever emit bare `claude-*` models, so there is no
prefix to resolve there. The raw resource tag is still stored unmodified; this changes only
how queries interpret it, and applies retroactively to historical data at query time.

### A Codex-priced fallback to the Claude price table

When a Codex response's resolved backend and scope are valid but its model has no entry in
`DEFAULT_CODEX_PRICING`/`CODEX_PRICING_JSON`, and the model normalizes to a Claude table key
(an Anthropic model called through Codex), price it from the Claude table instead
(`codexPricing.js`'s `priceCodexUsage`, mirrored in SQL by `codexLogAggregates.js`'s
`priceExpression`). The row is tagged `price_source: "claude_table"`; `cost_basis` stays
`aws_list_estimate`. A model matching neither table stays `unknown_model`. This is strictly
additive: an existing Codex-table entry always takes priority, and the existing
scope/backend/usage-validity guards are unchanged.

### A computed-cost fallback for Claude reports that are not usable

In `/api/clients/overview` only (`clientMetrics.js`'s `claudeUsage`), when a Claude row's
client-reported cost is unusable (`report_missing` or `report_zero_with_tokens`) and its
token counts are fully known, price it from the token counts instead
(`pricing.js`'s `computeCost`, the same formula `withComputedCost` uses) when a rate exists
for that model/backend. `cost_basis` becomes `computed_estimate` for that row. A model with
no rate anywhere stays unpriced with its original reason. This narrows
[ADR-009](ADR-009-reported-spend-with-computed-diagnostics.md)'s "reported spend is primary,
computed cost is diagnostic-only" rule to a strict "fallback only where no report exists",
scoped to this one endpoint; the legacy Cost/Executive pages and `spend.js` keep ADR-009's
original behavior unchanged (`cost`/`computed_cost` there remain diagnostics, never
substituted for a report). This does not amend [ADR-013](ADR-013-known-cost-subtotals.md)'s
"no source is relabelled" rule — an existing report is never overwritten or relabelled;
`computed_estimate` and `mixed` (a group holding both reported and estimated rows) are new,
separately disclosed bases, not a relabelling of `client_reported`.

### Per-backend rate overrides

`PRICING_JSON` (Claude) and `CODEX_PRICING_JSON` (Codex) entries accept an optional
`backends` map (`{"bedrock-mantle": {...}, "bedrock-runtime": {...}}`) for models whose
mantle and runtime rates genuinely differ. Unset fields fall back to the entry's base rate.
No default entry sets this; the defaults are unaffected until an operator supplies one.

## Consequences

- Codex rows for a `global.`/region-prefixed model are priced at the runtime rate that
  matches their resolved backend, not rejected as a mantle/prefix mismatch.
- Anthropic models called through Codex are priced from the Claude table instead of showing
  as an unknown model, as long as the underlying model is in that table.
- A Claude row whose report is missing or an unusable zero, but whose tokens and model rate
  are known, now shows a disclosed estimate instead of `—`. `cost_estimated` counts these
  rows per group; `cost_basis_label` always names the estimated count separately from the
  unpriced count, even when the group's basis is `mixed`.
- A bedrock-channel Claude row with a bare, unrecognized model now reports `unknown` backend
  instead of an assumed `bedrock-runtime` — a narrower, more honest default, not a regression:
  live verification against the last 14 days of production data found zero such rows.
- None of this changes collection, the raw stored resource tag, or the legacy Cost/Executive/
  `spend.js` cost-basis contract.

## Verification

Read-only queries against the live cluster (via the `clickhouse-investigate` skill)
confirmed, before and after this change: `global.openai.gpt-6-astra` and
`global.anthropic.claude-fable-5-1` moved from unpriced to priced at the runtime rate; models
with no rate in either table (`openai.gpt-5.6-terra`, `global.xai.grok-4.6`, `kimi-k3`)
remained `unknown_model`; and no Claude row in the same window moved to `unknown` backend.
The Codex log-compaction integration test (`codexLogCompaction.test.js`, real ClickHouse via
Docker) passed unchanged, confirming the raw-fold/compacted-fold parity holds with the new
backend and pricing SQL.

## References

- [API contract](../api-reference.md#coding-client-views)
- [Codex telemetry runbook](../runbooks/codex-telemetry.md)
- [Data reference](../reference/data.md)
