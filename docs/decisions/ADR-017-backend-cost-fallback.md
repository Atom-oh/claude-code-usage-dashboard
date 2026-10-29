# ADR-017: Model-prefix backend resolution and a computed-cost fallback for missing reports

Status: accepted, 2026-09-25, following the user's explicit request. Amended 2026-10-07 for
non-Anthropic models used through Claude Code, and 2026-10-28 for the AWS Price List rate source
(see the amendments below).

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
(`us.`/`us-gov.`/`eu.`/`apac.`/`jp.`/`au.`/`in.`/`global.`) → `bedrock-runtime`; else a bare
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
- A bedrock-channel Claude row with a bare model reports `unknown` — the 2026-10-18
  channel fallback (organization-less, model-bearing sessions are `bedrock`) now makes such
  rows possible; their spend stays reported and their backend stays `unknown`.
- Collection, the raw tag, and the legacy cost-basis contract are unchanged.

### India routing coverage correction (2026-10-18)

Recognize the `in.` geography prefix in backend inference, Claude/Codex price lookup,
SQL normalization, Grafana queries and model labels. The
[AWS Claude Opus 5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html)
lists the India inference ID. India profiles use the existing
commercial regional rate policy; global and unsupported GovCloud scope rules remain.
Codex request tiers still take precedence over the flat Claude fallback. Chat IAM
removes every supported commercial geography prefix from the foundation-model ARN
while retaining it in the inference-profile ARN.

Backend labels remain inference. A bare vendor ID can also be invoked through
Bedrock Runtime; the prefix alone does not prove the API endpoint. This correction
preserves the existing bare-vendor rule and does not add endpoint telemetry.

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
- No logs, any unpriced or invalid request, or a missing or zero report makes the factor
  unknown. A nonzero increment with an unknown factor is NaN, which survives every enclosing
  sum and renders as `null`: any total that includes unknown spend is unavailable, never $0
  and never the inflated report.
- `/api/clients/overview` labels these rows `aws_list_estimate`. A client total that combines
  them with Anthropic reports is `mixed`.

Anthropic models keep Claude Code's report unchanged.

### Consequences

- Non-Anthropic Claude spend becomes a labelled AWS list estimate, like Codex. It is not an
  invoice: no Flex/Priority tier, discounts or gateway-side routing are visible.
- The factor is exact per request because Claude Code's report is a fixed rate times tokens.
  It assumes the counters' requests have the same mix as the logged ones; duplicate log
  deliveries cancel only when every request is duplicated alike (otherwise the error is
  bounded by the model's short/long rate ratio). A sub-split (user or day) of one
  session-model inherits that session's ratio.
- Logs are retained 90 days and counters 180 days, so non-Anthropic Claude spend older than
  90 days is unavailable. A group mixing a priced and a factor-less session is unavailable.
- The scan is widened two hours before the window start because rollup branches align their
  starts down to the hour.
- Non-Anthropic models reached under ARN or alias ids, or a configured Claude-table entry for
  a non-Anthropic key, are outside this rule; the default table has only `claude-*` keys.
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

## Amendment (2026-10-28): AWS Price List as a rate source

Accepted 2026-10-28 at the user's request
([design](../superpowers/specs/2026-10-28-aws-price-list-pricing-design.md)). It changes where
rates come from. The cost bases, both fallbacks above, the 2026-10-07 factor and the
[ADR-009](ADR-009-reported-spend-with-computed-diagnostics.md)/[ADR-013](ADR-013-known-cost-subtotals.md)
contracts are unchanged.

### Context

Rates lived only in hand-maintained tables (`pricing.js` `BASE_PRICING`, `codexPricing.js`
`DEFAULT_CODEX_PRICING`). A model in neither table is unpriced, which makes a non-Anthropic
Claude session factor unknown and its totals unavailable. On 2026-10-28 that applied to Claude
Code sessions reporting `kimi-k3`, `zai.glm-5.3` and `openai.gpt-6.1-terra`. Every new model or
price change needed a code change and a release.

### Decision

- **Layers**, highest first, per model: `PRICING_JSON`/`CODEX_PRICING_JSON` (operator rates,
  whole-model replacement as before); the latest successful runtime Price List refresh (in
  memory); the build snapshot `dashboard/server/awsPriceSnapshot.json`; the code tables.
  `priceCatalog.js` owns the merged view; pricing paths read it at call time.
- **Source**: `pricing:GetProducts` against `us-east-1` for `AmazonBedrockFoundationModels`
  (Anthropic and OpenAI display names, e.g. `Claude Fable 5.1` → `claude-fable-5-1`,
  `OpenAI GPT-6 Astra` → `openai.gpt-6-astra`) and `AmazonBedrock` (Bedrock-hosted model ids from
  runtime and `-mantle` usage types). Only On-Demand USD `standard`/`global-standard` rows count;
  flex, priority, batch, latency-optimized and reserved rows are ignored. Per-1K prices become
  per-1M prices by decimal shift (`awsPriceList.js`).
- **Shapes**: a Claude entry is the global row set and needs input, output, cache read, 5-minute
  and 1-hour cache write; the regional multiplier still applies to regional ids. A Codex entry is
  per scope: global from `global_standard` rows, regional from the other `standard` rows, `long`
  from `long_ctx` rows. Cache write is the only write bucket present (30 minutes for OpenAI and
  Kimi K3), otherwise 5 minutes.
- **Completeness**: entries missing a required bucket, with conflicting duplicate prices or with
  a non-token unit are skipped and logged, never partially merged. One clarification of the
  design: a model that publishes no cache rows prices cache reads and writes as ordinary input,
  and a model with cache reads but no cache-write row prices writes as input. That is the code
  tables' existing convention (`grok-4.6`, `glm-4.7`), and on 2026-10-28 it reproduces every
  such code entry exactly. A cache-write row without a cache-read row is still incomplete.
- **Merge**: a Price List scope replaces the code scope; the code entry keeps its
  `short_context_limit` and any scope the Price List lacks. When the code entry has distinct
  long-context rates and the Price List has no long-context rows for that scope, the code scope
  is kept. A model new to the code tables has no published context limit: it prices flat at its
  short rates (`short_context_limit` = `Number.MAX_SAFE_INTEGER`), so long requests are
  underestimated; ignored long-context rows are logged.
- **Bare ids**: a non-Anthropic model id without a vendor namespace (e.g. `kimi-k3`) prices as
  the table's unique `<vendor>.<id>` entry (`moonshotai.kimi-k3`), with that id's inferred mantle
  backend and the regional scope unless routed; ambiguous ids stay unpriced. Only the
  non-Anthropic factor (`nonAnthropicCost.js`) applies this; Codex rows still need a namespaced
  id or a matching table key. The factor key keeps the reported id.
- **Context-window suffix**: the non-Anthropic factor prices `<id>[1m]` as `<id>` (the suffix
  names no separate rate; the context tier still comes from request size). Before this, priced
  models such as `global.zai.glm-5.3[1m]` and `global.openai.gpt-6.1-sol[1m]` had unknown factors.
- **Runtime**: the snapshot loads at startup. After `listen()` the first refresh runs in the
  background and then every `AWS_PRICE_REFRESH_HOURS` (default 12, 1-168). A failure or an empty
  response keeps the last good layer; logs carry error names and status codes, not provider
  messages. `AWS_PRICE_LIST=off` disables the fetch (`npm test` sets it). Response caches keep
  their entries until their TTL. No rates are persisted to ClickHouse.
- **Disclosure**: `/api/config` `pricing.priceList` is `{source: "runtime"|"snapshot"|"code",
  fetchedAt, models}`, metadata only. The Cost page computed-cost help names that source and
  time. `priceCodexUsage()` marks records priced from a Price List rate
  `price_source: "aws_price_list"` (the Claude-table fallback keeps `claude_table`); no current
  endpoint serializes that record field. A rate more than 2x from the code table is applied and
  logged.
- **Build and IAM**: `npm run prices:snapshot` regenerates the snapshot before an image build;
  an unchanged rate set leaves the file untouched. The dashboard IRSA role gains
  `pricing:GetProducts` on `*` (the action has no resource-level scoping).

### Consequences

- In the 2026-10-28 snapshot every model already in a code table parses to the same rates
  (15 Claude and 26 Codex entries), and 19 Codex-shape models become priced (for example
  `nvidia.nemotron-super-3-120b`, `mistral.mistral-large-3-675b-instruct`, `deepseek.v3.1`).
  Code entries absent from the us-east-1 Price List (for example GPT-6.1 Sol, GPT-6 Sol/Luna,
  the GPT-5.x entries, `zai.glm-5.3`, `zai.glm-5`) keep code rates; `openai.gpt-6.1-terra` is in
  neither source and stays unpriced.
  The Price List id `zai.glm5` does not match the code-table id `zai.glm-5`, so it adds a separate key.
- Bare `kimi-k3` sessions now get a known factor from the existing `moonshotai.kimi-k3` rate.
- Live prices can change computed diagnostics, Codex estimates and non-Anthropic Claude
  estimates without a release. Reported Claude spend is unchanged. Neither basis is an invoice:
  no Flex/Priority/Batch tiers, discounts or Savings Plans.
- The release helper builds committed files only, so a changed snapshot must be committed and
  reviewed before the image build.
- The Codex SQL rate catalog grows with the Price List. Context-limit parameters are shared per
  value; tests keep both Codex queries' URL parameters below 8 KiB with the snapshot loaded.
- The chat prompt's rate table is rendered per request from the current Claude table.

### Verification

`awsPriceList.test.js` parses trimmed real responses (Fable 5.1, GPT-6 Astra, Kimi K3, GLM 4.7)
to the hand-table rates and covers skipped entries. `priceCatalog.test.js` covers precedence,
incomplete entries, failed refreshes and logging. `codexLogPricing.test.js`
(`CODEX_PRICING_SQL_TEST=1`) checks SQL/JavaScript parity for every catalog entry in ClickHouse.
`nonAnthropicCost.test.js` covers the bare-id factor. A full parse of the 2026-10-28 us-east-1
responses matched an independent reference parser.
