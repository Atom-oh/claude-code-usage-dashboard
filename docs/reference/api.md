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
| [queryContext.js](../../dashboard/server/queryContext.js) | Shared-load deadline and query cancellation ownership |
| [pricing.js](../../dashboard/server/pricing.js) | Computed cost diagnostics and token-tier estimates |
| [costEfficiency.js](../../dashboard/server/costEfficiency.js) | Reported-cost efficiency ratios, retaining computed diagnostics |
| [productivity.js](../../dashboard/server/productivity.js) | Activity heuristic added to leaderboard rows |
| [chat.js](../../dashboard/server/chat.js) | SSE assistant and SQL tool loop; see [chat reference](agent-llm.md) |

## Request and cache behavior

`route()` registers GET data handlers. It validates range and interval before cache lookup,
then passes parsed filters to the handler. Validation failures return 400; capacity
exhaustion returns 503 with `Retry-After: 1`; other failures return 500 with an opaque
error ID. A shared query-load deadline returns 504 with `code: query_timeout`,
an opaque error ID and `Retry-After: 5`. A warning logs only that ID, the registered
route and the timeout code; it excludes submitted filters and SQL.
Config, health and chat handlers bypass this wrapper.
[ADR-020](../decisions/ADR-020-cooperative-query-load-deadlines.md) records the shared
deadline and reader-profile decision, including repeated expensive-view timeouts.

The process-local cache deduplicates pending work until settlement and stores successful
results for 320 seconds from completion. Successful-result TTL and byte eviction do not
remove pending entries; producer deadlines below can reject pending work.
Keys contain the route path and sorted parameters. Ordinary routes use `from`, `to`,
`group`, `user`, `model`, `project`, `intervalHours`, `email` and `includeUnknown`.
Client overview and Codex insights instead use range bounds and validated client/backend/user/model
filters, including `userExact`/`modelExact`, and their applicable `view`, `modelTime`,
`timeFormat` or `profile`. Overview also keys the resolved bucket size, native query
source and effective range end. [index.js](../../dashboard/server/index.js)'s `cacheKey()`
owns this normalization. Failed promises are removed. The 2,000-entry
cap evicts settled entries by insertion order, not by last read. At most 64 distinct
cache loads execute concurrently. Up to 64 additional distinct keys wait FIFO without
starting their loaders or acquiring database slots. The cache queue's own wait limit
is 30 seconds. Existing-key requests share the same promise while waiting or executing.
A full queue returns the same coded 503; failed keys are removed.
Completion starts the successful-result TTL. Each new shared key also has a 25-second
cooperative deadline, starting before cache admission and covering its loader's DB
queue, sequential/parallel queries and result consumption together. It cancels queued
work and closes pending result bodies. Timeout results are removed, never cached as
empty/zero telemetry. An uncooperative loader remains accounted until it settles;
a timer does not free its slot while work is still active.
For data-route loads, the shared 25-second deadline expires before either queue's
30-second wait limit and returns 504. Cache/DB queues used without that deadline
retain their own 30-second expiration and coded 503 behavior.

The deadline belongs to the shared key, not one HTTP subscriber. Factor lookups retain
separate ownership: an expired caller leaves, while another subscriber's request stays
alive; the last cancellation aborts the lookup. Standalone DB helpers retain their
independent limits below. This is not a transport, response-encoding/delivery or
end-to-end fleet deadline. Synchronous work can delay cancellation; expiration checks
reject late loader/serialization results but do not preempt JavaScript.
Settled entries have a 16 MiB serialized-JSON byte quota and a 1 MiB per-entry quota.
Oversized results are returned intact but not cached; byte eviction never removes pending
work. Serialized size is an estimate for cache admission, not a heap/response-allocation bound.

[capacity.js](../../dashboard/server/capacity.js) bounds admitted `/api` requests at 200,
database queries at 24 (including result consumption), and chat turns at two per process.
Database bursts wait FIFO in a bounded 128-query queue for at most 30 seconds; only a
full/expired queue rejects work. Normal query execution retains the client 30-second timeout
after admission, with a data-route shared deadline taking precedence if it expires first.
Readonly SQL's 30-second abort covers queue and execution together;
disconnect/deadline also cancels queued readonly work. These are cooperative limits.
Ordinary and readonly helpers explicitly close result bodies on abort after headers,
preserving the originating cancellation reason. [dashboard.tf](../../infra/dashboard.tf)
declares `CH_USER=otel_reader` for the shared SDK; local Compose instead uses `default`.
The declared `otel_reader` profile enables
`cancel_http_readonly_queries_on_client_close` and retains its 60-second execution,
memory/result/read ceilings as backstops. Older installations may still disable that
setting; inspect `getSetting(...)` in the actual dashboard session using the
[reader reconciliation procedure](../runbooks/deploy-production.md#reader-profile-reconciliation).
HTTP cancellation alone does not establish server-side
termination. Cancellation and execution checks are cooperative, so a client slot can be
released before server work stops; neither setting certifies fleet capacity or a hard deadline.
Overload JSON has `code: capacity_exhausted` and a localized retry message.
HTTP admission follows authentication and releases on response finish/close; work budgets
release on settlement. Probes and OIDC protocol routes remain outside HTTP admission;
`ping` has a separate four-call budget. Busy/failed ping keeps liveness HTTP 200 with
`ok: false` and makes readiness 503; it must not restart the process. The ClickHouse
connection pool remains 30.
These bounds do not reserve sockets, measure latency or establish a fleet SLO.

Large immutable data-route values share serialized bytes and one gzip operation
among active responses. Representations are released after the last response
finishes/closes and any compression settles; no settled encoding cache or copied
source is retained. JSON policy/Express application changes do not share old bytes.
Custom replacers/boxed spacing retain per-response evaluation. Content negotiation,
JSON escaping, null/zero/tiny values, auth, status and private cache headers remain.
This reduces duplicate response work, not the size of data received by each client
or an absolute heap/socket bound.

Chat limits admit ten requests per IP/minute, storing at most 4,096 live keys and ten
timestamps per key. Denied attempts do not extend the admitted-hit window. A full key map
rejects new keys until expired entries can be removed; live limits are never evicted.
Concurrent chat overload is checked before consuming an IP rate slot.
Limits/cache are independent in each replica: they are neither a fleet-wide quota nor a
billing bound. Shared proxy/NAT addresses can exhaust the IP limit. The existing
[chat limits](agent-llm.md) and DB timeout/readonly gates still apply.

The warmer runs at startup and on 120-second boundaries, in batches of three with two-second
gaps. The [warming plan](../../dashboard/server/warming.js) prioritizes shared full and
cost/model-time profiles. Legacy views join only after recent authenticated, unfiltered
default-window demand. It requests `DEFAULT_RANGE_DAYS` with hourly resolution through
two days, otherwise daily. User drilldowns, snapshots and beta trace handlers do not warm.
Warming is per process and best effort; it does not guarantee a cache hit for every
range, filter or replica. See [query performance](cost-query-performance.md#capacity-validation).

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
