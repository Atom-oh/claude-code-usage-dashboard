# Cost query performance

The implementation owner is [clientMetrics.js](../../dashboard/server/clientMetrics.js);
the public contract is [Coding-client views](../api-reference.md#coding-client-views).

## Current query path

`view=cost` uses the existing counter, pricing and event-deduplication paths. It keeps
all evidence needed to distinguish known amounts, incomplete usage and explicit
rejections. It does not discard model-less operational records. Full diagnostic
views remain available through the default profile.

Cost SQL skips diagnostic durations/errors and tool-name grouping.
The fold skips project/tool breakdowns and omits uncomputed diagnostics.
Observed request counts remain available for Trends tables and exports.
Both profiles compact stream deltas into their original session/user/model/backend/
project/event scope. A fixed delta marker replaces arbitrary representative maps;
full sorted-map identity remains mandatory for completion deduplication.

For Codex ranges covered by the verified `CODEX_COST_READ_FROM` boundary, both
cost and full overview profiles read the typed event and compact scope tables.
Full views recover diagnostic log attributes from the retained identity tuple
after explicit event deduplication; cost views skip this decoding. Tools, errors,
valid durations and non-usage context tiers retain their previous semantics.
Older ranges and unconfigured installations use raw logs. Claude retains its
counter and operational-log sources.
See the [cutover runbook](../runbooks/codex-cost-schema.md).

These changes do not eliminate every raw scan or establish capacity for 140 distinct
viewers. Requests sharing a cache key can reuse work; independent filters may miss.
Existing admission, query, result and cache limits remain.

## Avoiding unused work and collection

The Effort detail panel on cost/productivity views requests `profile=effort`,
reducing its database round trips from six to one. Its log query omits diagnostic
families/quantiles but preserves original event deduplication, usage tiers and
scope coverage. Full diagnostics remain available on their relevant views.
See [observability](codex-observability.md#effort-profile).

The Usage tools panel requests `profile=tools` (one log query); the Reliability
performance panel requests `profile=performance` (logs and four metric storage
types). Neither requests traces. Performance metric selection retains displayed
turn duration, TTFT, tool-call and token-usage families, including cumulative
baselines. Profile identity separates cached responses. Unqueried coverage is
`not_requested`; it is not zero or absent collection.

Covered tools/performance ranges can read migration 008's exact diagnostic
identity states instead of raw maps, after `CODEX_DIAGNOSTIC_READ_FROM` is
verified. `FINAL` merges repeated insertion/backfill states before finalizing
weights. All stream durations, event counts and filter semantics remain.
Unconfigured or earlier ranges retain a compact raw fallback; removing hidden
breakdowns alone does not eliminate its scanned bytes. Default insights remain raw.
Covered Effort ranges combine exact diagnostic weights for intermediate stream
events with a raw branch excluding those events before full-identity deduplication.
The raw branch preserves prompt lengths, completion token encodings and exact
anonymous timestamps. Both sources share the existing aggregate/fold contract;
diagnostic model-session presence is selected before backend filtering. User
selection precedes diagnostic state payload reads. Tools/performance operational
families aggregate only decisions or request/failure outcomes respectively,
while event coverage still includes every selected identity.
No schema, collection, storage or deadline changes are required. This reduces
deduplication work; raw attribute filtering and state merges can still be expensive.
See the [diagnostic cutover](../runbooks/codex-diagnostic-schema.md).

Codex log pricing uses an ordered, bound rate catalog and one token arithmetic
expression. Backend-specific entries precede generic entries, short/long tiers
retain the inclusive short-context limit, and Codex entries still prevent an
unpriced scope from falling through to Claude fallback rates. The Claude regional
premium applies only to fallback rates. Missing or invalid usage remains unpriced.
This reduces expression expansion during query planning; it does not eliminate
the retained raw-map scan or establish a monthly latency/capacity target.

High-volume intermediate stream events also carry counts, latency and scope
coverage. Repeated cumulative exports preserve observation/baseline evidence.
Do not indiscriminately drop these, sum cumulative samples as usage, or infer
missing telemetry as zero. Separate verified aggregation from collection reduction;
preserve raw boundary fallback and disclose sampling/coverage if introduced.

Codex user filters use existing promoted email/end-user identity in `PREWHERE` to
reject unrelated wide maps early. The original map-derived filter, completion
deduplication, scope evidence and pricing remain. Queries without a user selector
retain their previous source path. Verify promoted definitions/history on the target;
source schema alone does not establish runtime state.

An additive user/event/time log projection remains a synthetic accelerator proposal.
The private benchmark can materialize it without changing production sorting keys,
data, ingestion or Keeper. Live rollout needs reviewed schema/history, retention,
storage, backup/restore and parity evidence.

A single-table synthetic lifecycle trial on ClickHouse 24.8.14.39 restored all
1,008,000 logs and the projection from a local Native backup, retaining 144-row
query parity. Late duplicate completions, heavy `ALTER ... DELETE`, table TTL
expiry and dropping the projection retained the expected raw/projected results.
Lightweight `DELETE FROM` was rejected while the projection existed. Operator
deletion procedures must account for that restriction before live adoption.
This is not a customer S3/Keeper/full-database restore or RTO measurement.

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

## Typed storage and subsequent schema design

Migration 007 supplies typed usage/operational events and compact scope states.
Activation requires verified history and parity; source files alone do not prove
deployment. Full original identity and nanosecond timestamps remain in event
facts. Scope states retain exact second membership for whole-second query bounds.
The [schema owner](../../dashboard/server/codexCostSchema.js) and
[cutover runbook](../runbooks/codex-cost-schema.md) define their lifecycle.

Ten-minute metric states remain a proposal. They must retain stored `SeriesKey`, helper dimensions and
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
An overview starts at most two private query tasks concurrently. The next task
waits without reserving a DB slot; failure stops unstarted tasks, cancels started
siblings and preserves the first error/result ordering.
The Claude query wrapper forwards the batch signal through both its non-Anthropic
factor lookup and final counter query. The
[HTTP regression](../../dashboard/server/clientCancellation.test.js) holds each
response open and verifies that a sibling failure aborts it while retaining the
original capacity error.

Equal factor windows share one lookup through the
[factor cache](../../dashboard/server/factorCache.js), isolated by runner identity.
Each caller can cancel its subscription; the database lookup aborts only after
its last subscriber leaves. Successful values expire sixty seconds after completion.
Pending and settled keys are each bounded at 64 per runner. Settled serialized
values have a 4 MiB total and 1 MiB per-entry admission quota; larger values are
returned intact but not cached. This is not a heap or in-flight allocation bound.
Failures/aborts are not cached and late abandoned results cannot replace a newer lookup. Factor SQL, pricing
tiers, unknown values and final counter cancellation remain unchanged. This reduces
duplicate queries, not collection or guaranteed ClickHouse execution time.

For `N` independent viewers requesting every `T` seconds, the cold request rate is
`N / T` only when every request misses. Database CPU demand is that rate multiplied
by measured CPU-seconds per request. Query CPU budget must leave ingestion/merge
headroom. Concurrent HTTP sessions alone do not define database demand.

Measure shared and distinct cache keys separately, cold/warm results, admission
failures, query CPU/memory, API serialization and ingestion/merge interference.
The API cache runs at most 64 distinct loads per process. It can hold another 64
distinct keys in a FIFO queue for at most 30 seconds, sharing each queued key's
promise and starting no loader until a slot is free. Database/request budgets,
active-load slots and result byte quotas are unchanged. Queue saturation or expiry
still returns coded overload; waiting does not guarantee a later database slot.
With two processes, 140 arrivals sharing one key coalesce into at most two
computations. Under ideal balancing, 140 distinct keys occupy 64 active and six
waiting slots per process rather than immediately exceeding the former 128-load
fleet bound. Unit tests verify admission, single-flight and result semantics;
they are not database load tests, heap bounds or latency guarantees.
Large immutable results also share their serialized/gzip representations while
responses are active, preventing per-viewer copies of an identical result. The
representation disappears after the last response and compression settle. Numeric
fields, scopes, coverage and client payloads are unchanged; browser/network work
and the decoded result's own memory remain.
Any ClickHouse/DuckDB comparison needs equivalent data, semantics, CPU/memory and
ingestion conditions. DuckDB replacement remains a review proposal; this query
optimization does not change the database engine or hardware allocation.
