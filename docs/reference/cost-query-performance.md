# Cost query performance

The implementation owner is [clientMetrics.js](../../dashboard/server/clientMetrics.js);
the public contract is [Coding-client views](../api-reference.md#coding-client-views).

## Current query path

`view=cost` uses the existing counter, pricing and log-deduplication paths. It keeps
all evidence needed to distinguish known amounts, incomplete usage and explicit
rejections. It does not discard model-less operational records. Full diagnostic
views remain available through the default profile.

Cost SQL skips diagnostic durations/errors and tool-name grouping.
The fold skips project/tool breakdowns and omits uncomputed diagnostics.
Both profiles compact stream deltas into their original session/user/model/backend/
project/event scope. A fixed delta marker replaces arbitrary representative maps;
full sorted-map identity remains mandatory for completion deduplication.

These changes do not eliminate raw scans or establish capacity for 140 distinct
viewers. Requests sharing a cache key can reuse work; independent filters may miss.
Existing admission, query, result and cache limits remain.

## Subsequent schema design

The following accelerators are proposals, not deployed tables:

- Typed usage events retain exact timestamps, original deduplication identity,
  per-response input/context tier, token validity, pricing inputs and raw fallback.
  Diagnostic metrics/traces cannot become additional cost.
- Compact scope evidence retains identity and exact window membership. Closed
  buckets can be compacted; incomplete boundaries require raw refinement.
- Ten-minute metric states retain stored `SeriesKey`, helper dimensions and
  temporality. Cumulative samples use maxima and correct query-time baselines,
  while delta samples retain sums. Never sum cumulative exports or compute
  cross-block cumulative differences inside an incremental materialized view.

Accelerators require additive migrations, bounded parity checks, proven history
coverage and rollback/recovery. Seeding must not overlap late live inserts without
an idempotent strategy or a bounded writer pause. Unfilled history is unavailable,
not zero. Do not rebuild raw sorting keys as the first optimization.

## Capacity validation

For `N` independent viewers requesting every `T` seconds, the cold request rate is
`N / T` only when every request misses. Database CPU demand is that rate multiplied
by measured CPU-seconds per request. Query CPU budget must leave ingestion/merge
headroom. Concurrent HTTP sessions alone do not define database demand.

Measure shared and distinct cache keys separately, cold/warm results, admission
failures, query CPU/memory, API serialization and ingestion/merge interference.
The default cache admits 64 distinct pending loads per process. With two processes,
140 arrivals sharing a view coalesce into at most two computations. If all 140
distinct loads stay pending together, at least 12 exceed the combined 128-load
bound, even with ideal balancing. Unit tests cover these admission scenarios;
they are not a database load test or latency guarantee.
Any ClickHouse/DuckDB comparison needs equivalent data, semantics, CPU/memory and
ingestion conditions. DuckDB replacement remains a review proposal; this query
optimization does not change the database engine or hardware allocation.
