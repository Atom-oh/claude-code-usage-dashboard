# Unified cost breakdowns

## Intent

Claude Code and Codex cost views should answer the same questions in the same
order: cost summary, model/effort/input-cache composition, trends, then tables.
Retain Claude's optional channel diagnostics and existing filters and drilldowns.

## Contracts

- Reuse overview model and token rows. Keep model versions separate and use the
  existing theme-aware model-family colors.
- Render model, effort and input-cache cards with persistent headings during
  loading, failure and empty results. Unknown values differ from observed zero.
- Show known cost subtotals and exclusions. Claude effort uses observed cost
  counters (reports or rescaled non-Anthropic AWS estimates); Codex effort uses
  completion estimates. Neither is an invoice. Do not invent attribution for
  token-derived Claude fallback estimates.
- Cache composition requires canonical input/cache fields. Do not infer ratios
  from observed-token subtotals, or add reasoning to output again.
- Keep cost bases and backend/client identities distinct. Shared requests use
  user/model/backend filters, never Claude-only group/project filters.
- Codex cost pages reuse their existing effort-profile response for the charts
  and detail tables. Add only one independently cached Claude effort request.
- Preserve effective parent response bounds and do not show an old selection's
  breakdown after client/filter changes.
- No database migration, engine change, collection change or infrastructure
  resizing.

## Interfaces

`GET /api/clients/claude-effort` accepts validated shared Claude filters and
`from`/`to`. Returns `{range, effort, cost_scope}`. Effort rows carry `effort`,
`backend`, `cost_usd`, `cost_partial`, `cost_basis` and `unpriced`.

The web owns presentation and reuses the existing chart primitives. Server
queries preserve cumulative counter baselines and the in-window coverage rule.

## Verification

The user approved regression tests for this integration. Cover selected clients,
counter attribution, backend filtering, missing cache components, unknown/partial
costs, loading/errors, and unchanged filter/range behavior. Run web/server tests
and a production web build; required PR reviews must cover the latest revision.
