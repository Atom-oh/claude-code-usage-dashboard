# ADR-020: Cooperative query-load deadlines

- Status: Accepted
- Date: 2026-10-16
- Scope: Shared data-route producers and configured ClickHouse reader sessions

## Context

A cache queue wait, database queue wait and multiple queries previously had independent
budgets. Their combined duration could outlast the origin response window even when each
individual operation stayed within its limit. The pinned ClickHouse SDK also finishes
its request cancellation listener after response headers; result consumption needs its
own explicit cancellation path.

Client cancellation can leave a server query running when the reader's disconnect
cancellation setting is disabled. Releasing a client admission slot does not establish
that the corresponding server work has ended.

## Decision

Give each new shared cache key one cooperative 25-second producer deadline, including
cache/database admission, sequential and parallel queries, response consumption and
expiration checks around serialization. This leaves a margin before a 30-second origin
response window; operators must verify their installation's actual proxy settings.

All subscribers share the producer's deadline. A departing subscriber does not own
the work. Lazy shared factor lookups retain a separate producer context, remaining
alive for another subscriber and aborting when their final subscriber leaves.
Close pending SDK result bodies explicitly on abort. Failed or late results are removed
instead of becoming zero/empty telemetry or cache entries; an uncooperative loader
retains its admission slot until settlement.
An early producer failure aborts its remaining queries before deadline cleanup and
admission release. A shared factor lookup survives while another subscriber needs it.

Return a coded, uncached 504 with an opaque correlation ID and a five-second
`Retry-After` hint. Logs contain the ID, registered route and code, excluding submitted
filters and SQL. The hint does not enforce client pacing.

Enable `cancel_http_readonly_queries_on_client_close` in the configured reader profile.
Retain readonly permissions and the existing 60-second execution, memory, result and
scan ceilings. Reconcile and verify older installations explicitly; source configuration
does not prove a runtime setting changed.

## Consequences and verification

A view consistently needing more than 25 seconds can fail repeatedly, including during
warming. Observe timeout codes and optimize those queries/data paths; this decision
does not establish a successful-response SLO or 140-user capacity.

These limits are cooperative. They neither preempt synchronous JavaScript nor prove
immediate ClickHouse termination. Response encoding/delivery and the complete fleet
request lifecycle are outside the producer budget.

Regressions cover ownership, queue expiration, late result consumption, synchronous
overruns, readonly cancellation, factor peer survival and private-safe timeout responses.
Native synthetic transport/profile controls supplement those checks. Deployment requires
latest-source review/CI and actual image/session verification; customer capacity and
ingestion acceptance remain separate requirements in [product readiness](../product-readiness.md).

[API behavior](../reference/api.md) owns the current runtime contract.
[Capacity](../../dashboard/server/capacity.js), [query context](../../dashboard/server/queryContext.js),
[SDK adapter](../../dashboard/server/clickhouse.js) and
[reader profile](../../infra/clickhouse.tf) own implementation.
