# API Implementation

The Express application serves the SPA, JSON data routes and `POST /api/chat`.
The complete route and response contract is in [API Reference](../api-reference.md).
Developer instructions live in [server/AGENTS.md](../../dashboard/server/AGENTS.md).

## Ownership

| Source | Responsibility |
|---|---|
| [index.js](../../dashboard/server/index.js) | Route registration, auth, probes, cache, warmer and shutdown |
| [http.js](../../dashboard/server/http.js) | `parseRange`, `parseIntervalHours`, `parseFilters` and configuration validation |
| [queries.js](../../dashboard/server/queries.js) | SQL builders and endpoint queries |
| [clickhouse.js](../../dashboard/server/clickhouse.js) | JSON queries, time conversion, ping and readonly-session probe |
| [pricing.js](../../dashboard/server/pricing.js) | Computed cost diagnostics and token-tier estimates |
| [costEfficiency.js](../../dashboard/server/costEfficiency.js) | Reported-cost efficiency ratios, retaining computed diagnostics |
| [productivity.js](../../dashboard/server/productivity.js) | Activity heuristic added to leaderboard rows |
| [chat.js](../../dashboard/server/chat.js) | SSE assistant and SQL tool loop; see [chat reference](agent-llm.md) |

## Request and cache behavior

`route()` registers GET data handlers. It validates range and interval before cache lookup,
then passes parsed filters to the handler. Validation failures return 400; other failures
return 500 with an opaque error ID. Config, health and chat handlers bypass this wrapper.

The process-local cache stores promises for 320 seconds, deduplicating concurrent misses.
Keys contain the route path plus `from`, `to`, `group`, `user`, `model`, `project`,
`intervalHours`, `email` and `includeUnknown`, sorted by parameter name. Failed promises are removed. The 2,000-entry
cap evicts by insertion order, not by last read.

The warmer runs at startup and on 120-second boundaries, in batches of three with two-second
gaps. It requests an unfiltered `DEFAULT_RANGE_DAYS` window with `intervalHours=1`.
User drilldowns and beta trace handlers have `warm: false`. Warming is per process and
best effort; it does not guarantee a cache hit for every range, filter or replica.

JSON API responses use `Cache-Control: no-store`. The successful chat SSE handler overrides
this with `no-cache`. Keep frontend quantization in [useApi.js](../../dashboard/web/src/useApi.js)
consistent with the server constants.

## Query boundaries

Filters are applied only where each query supplies a corresponding expression to
`filterCond()`. Model matching can be row-level, mixed metric matching, or a session
semi-join; these have different populations. Project matching covers four Usage endpoints
and requires the project-column gate. See the [filter contract](../api-reference.md).

`incFlat` and `incBucketed` handle shared counter aggregation. Queries needing additional
dimensions such as effort, agent, language, version or project use local raw-table
aggregations. Do not widen the shared grouping merely to simplify one endpoint:
[ADR-001](../decisions/ADR-001-local-diff-over-shared-incflat-extension.md) explains the tradeoff.
See [data](data.md) for raw/rollup selection and remaining time-boundary approximations.

Keep API fields unchanged when choosing display spend. The frontend adapts `reported_cost`
through `spend.js`; server `cost` and summary `computed_cost` retain their diagnostic meaning.
Only the efficiency endpoint's `cost_per_loc` and `cost_per_commit` use reported cost.
