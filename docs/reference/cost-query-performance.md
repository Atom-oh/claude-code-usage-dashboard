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
Observed request counts remain available for Trends tables and exports.
Both profiles compact stream deltas into their original session/user/model/backend/
project/event scope. A fixed delta marker replaces arbitrary representative maps;
full sorted-map identity remains mandatory for completion deduplication.

These changes do not eliminate raw scans or establish capacity for 140 distinct
viewers. Requests sharing a cache key can reuse work; independent filters may miss.
Existing admission, query, result and cache limits remain.

## Avoiding unused work and collection

The Effort detail panel on cost/productivity views requests `profile=effort`,
reducing its database round trips from six to one. Its log query omits diagnostic
families/quantiles but preserves original event deduplication, usage tiers and
scope coverage. Full diagnostics remain available on their relevant views.
See [observability](codex-observability.md#effort-profile).

High-volume intermediate stream events also carry counts, latency and scope
coverage. Repeated cumulative exports preserve observation/baseline evidence.
Do not indiscriminately drop these, sum cumulative samples as usage, or infer
missing telemetry as zero. Separate verified aggregation from collection reduction;
preserve raw boundary fallback and disclose sampling/coverage if introduced.

## Cumulative diagnostic baselines

Codex cumulative metric queries group the latest prior export timestamp by the
complete resource/scope/attribute identity and process start. Only then do they
select and deduplicate full samples at that timestamp. Every distinct latest tie
is retained, so conflicting retries still withhold the affected aggregate.
The three-day lookback, delta handling, range semantics and result guard remain.

If distinct in-window non-DELTA points already exceed the existing 50,000-row
guard, SQL returns an explicit limit marker before baseline work and bulk payload
transfer. The fold reports unavailable diagnostic values with `status: limited`;
independent log costs and usage remain available. DELTA exports are aggregated
before that guard, so many advancing intervals can still produce usable metrics.

This replaces a window over all prior sample payloads with one timestamp state
per active series. It reads the lookback twice and adds an in-window guard probe;
those extra reads can increase elapsed time below the guard. It can hit time/result limits;
query-memory reduction alone is not a latency or concurrency guarantee.
No samples, model dimensions or diagnostic feeds are removed from collection.

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

[Synthetic capacity validation](capacity-validation.md) runs actual constrained
API/ClickHouse containers with synthetic data. It distinguishes admitted requests,
bounded rejection and numeric correctness from a production capacity guarantee.

The [warming plan](../../dashboard/server/warming.js) prioritizes shared full/cost
defaults, including the cost model-time key. Legacy routes warm only after recent
authenticated unfiltered requests matching the default window.
The [API fetcher](../../dashboard/web/src/api.js) retries only coded capacity
responses with a bounded server delay and jitter; other errors and cancellation
retain their existing behavior. Admission, cache and database limits remain.
One failed overview [query batch](../../dashboard/server/clientQueryBatch.js) cancels
its own queued/HTTP siblings instead of leaving rejected work running without a
consumer. A shared cache computation is never cancelled by one HTTP subscriber.
HTTP cancellation does not guarantee immediate ClickHouse execution termination.

For `N` independent viewers requesting every `T` seconds, the cold request rate is
`N / T` only when every request misses. Database CPU demand is that rate multiplied
by measured CPU-seconds per request. Query CPU budget must leave ingestion/merge
headroom. Concurrent HTTP sessions alone do not define database demand.

Measure shared and distinct cache keys separately, cold/warm results, admission
failures, query CPU/memory, API serialization and ingestion/merge interference.
The default cache admits 64 distinct pending loads per process. With two processes,
140 arrivals sharing the same cache key coalesce into at most two computations. If all 140
distinct loads stay pending together, at least 12 exceed the combined 128-load
bound, even with ideal balancing. Unit tests cover these admission scenarios;
they are not a database load test or latency guarantee.
Any ClickHouse/DuckDB comparison needs equivalent data, semantics, CPU/memory and
ingestion conditions. DuckDB replacement remains a review proposal; this query
optimization does not change the database engine or hardware allocation.
