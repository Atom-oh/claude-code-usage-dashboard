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
then passes parsed filters to the handler. Validation failures return 400; capacity
exhaustion returns 503 with `Retry-After: 1`; other failures return 500 with an opaque
error ID. Config, health and chat handlers bypass this wrapper.

The process-local cache deduplicates pending work until settlement and stores successful
results for 320 seconds from completion. Pending entries do not expire or get evicted.
Keys contain the route path plus `from`, `to`, `group`, `user`, `model`, `project`,
`intervalHours`, `email` and `includeUnknown`, sorted by parameter name. Failed promises are removed. The 2,000-entry
cap evicts settled entries by insertion order, not by last read. At most 64 distinct
cache loads execute concurrently; excess misses return 503 while existing-key requests
can still share work.
Settled entries have a 16 MiB serialized-JSON byte quota and a 1 MiB per-entry quota.
Oversized results are returned intact but not cached; byte eviction never removes pending
work. Serialized size is an estimate for cache admission, not a heap/response-allocation bound.

[capacity.js](../../dashboard/server/capacity.js) bounds admitted `/api` requests at 200,
database queries at 24 (including result consumption), and chat turns at two per process.
Overload JSON has `code: capacity_exhausted` and a localized retry message.
HTTP admission follows authentication and releases on response finish/close; work budgets
release on settlement. Probes and OIDC protocol routes remain outside HTTP admission;
`ping` has a separate four-call budget. Busy/failed ping keeps liveness HTTP 200 with
`ok: false` and makes readiness 503; it must not restart the process. The ClickHouse
connection pool remains 30.
These bounds do not reserve sockets, measure latency or establish a fleet SLO.

Chat limits admit ten requests per IP/minute, storing at most 4,096 live keys and ten
timestamps per key. Denied attempts do not extend the admitted-hit window. A full key map
rejects new keys until expired entries can be removed; live limits are never evicted.
Limits/cache are independent in each replica: they are neither a fleet-wide quota nor a
billing bound. Shared proxy/NAT addresses can exhaust the IP limit. The existing
[chat limits](agent-llm.md) and DB timeout/readonly gates still apply.

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
