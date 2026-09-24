# Codex observability support

Verified on Codex CLI **0.154.0**, 2026-09-15. A controlled native Mantle run with
one shell call exported logs, delta metrics and traces to a loopback OTLP receiver.
It exposed 39 distinct metric names and 136 distinct span operation names. These
are observations from one run, not a fixed catalog or a promise every feature emits.

Primary configuration references:

- [Advanced configuration](https://developers.openai.com/codex/config-advanced/)
- [Configuration reference](https://developers.openai.com/codex/config-reference/)

The documentation separates OTel export from product analytics. A catalog entry
alone does not establish its availability in this deployment.

## Supported surfaces

| Surface | Source | Interpretation |
|---|---|---|
| Token composition and AWS list estimate | Usage-bearing SSE/WebSocket completion logs | Input includes cache subsets; output includes reasoning. Existing overview remains the billing-estimate authority. |
| Effort usage/cost and cache/reasoning fractions | Completion `model_reasoning_effort` and token fields | Missing effort stays unknown; conversation-start settings do not replace per-response evidence. |
| Per-request/per-session units | Completion logs plus observed HTTP attempts and sessions | Retries count as attempts. Costs use known subtotals with partial disclosure; unknown token usage or denominators remain unavailable. |
| API error records per request and retry fraction | Request status, stream failures and zero-based attempt | HTTP and failed-stream records use the overview's error definition. Multiple error records per request are possible; this is not a failure probability. |
| Tool outcomes and approvals | `tool_result`, `tool_decision` | Permission decisions include automatic approvals; they are not retained-code acceptance. |
| Latency distributions | Valid per-event durations | Empirical percentiles of observations; request, SSE processing, TTFT, tools and startup stages remain distinct. |
| Runtime settings and prompt length | Conversation-start and prompt metadata | Start settings are snapshots. No prompt body is exposed. |
| Runtime/turn/tool/skill counters and histograms | Native metrics | Independently labelled diagnostics, never added to log-derived usage or cost. |
| Internal operations and parent relationships | Native spans | Observed span window, not guaranteed complete turn time. Overlapping durations are not summed. |
| LOC, commits, PR output and saved hours | Not present in this integration | Requires separate Git/CI/activity evidence; no causal ROI or work-time estimate is fabricated. |

The observed metric families included process/startup, thread skills, plugin cache,
SQLite initialization, API requests, tool calls, turn duration/token usage/memory
and conversation turn count. Which rows appear depends on exercised features.
The UI shows all collected metric names rather than populating absent catalog rows
with zeros. MCP, hooks and multi-agent observations require those paths to run.

## API and bounds

`GET /api/codex/insights` uses the existing authenticated route wrapper, date range,
refresh/cache behavior and user/model/backend selectors. Claude-only group/project
filters are rejected. It returns log-derived efficiency, effort, latency, tools,
approvals, runtime and event tables, plus separate metric and trace results.

Coverage is `observed`, `empty`, `unavailable` or `limited` for each signal. An absent optional
table is unavailable; transport, permissions and unexpected query failures are
errors. Existing logs remain usable before the additive metric migration.
In All-client views, insights use the overview's effective bounds, including historical
hour alignment. Their actual interval is also displayed. Refreshing the overview
preserves the active detail tab and search.

Metrics respect full series identity and delta/cumulative temporality. Cumulative
series require a prior baseline or an observed start inside the range; unresolved
baselines/regressions mark the aggregate partial. Histograms expose count and mean,
not invented percentiles of means. Export timestamps select metric periods, so
boundary exports can span the requested start. Gauges are not usage counters.
Collector 0.119 loses the presence bits of optional histogram Sum/Min/Max fields:
absent and present-zero fields both reach storage as zero. Such source zeros with
positive observation counts are ambiguous. Counts remain available, while affected
sum/mean/extrema are null. A derived zero increment between known positive
cumulative sums remains a measured zero.

Logs are deduplicated by timestamp and complete sorted resource/attribute maps.
One ClickHouse query first compacts intermediate stream events with full-identity
distinct counts and duration weights, then aggregates event counts, usage/Effort, operational summaries,
latency distributions, runtime settings and session-scope evidence. The server
receives aggregate dimensions instead of individual events. Exact weighted quantiles
retain empirical nearest-rank P50/P95. Pricing evaluates each completion's context
tier and routing before aggregation, using the configured `codexPricing.js` rates;
compensated summation reduces rounding error across large groups. The raw fold remains
a regression oracle, not a second production query.

Scope evidence, priced usage and request/session denominators share that query's
snapshot. Scope identities remain internal and never appear in API output. Costs
and Effort rows sum usable amounts with `cost_partial` disclosure; all-unknown costs
remain null and known zero remains zero. Cost units divide that subtotal by observed
HTTP attempts/sessions. Missing session identity withholds session units. See
[ADR-013](../decisions/ADR-013-known-cost-subtotals.md).
Summary/Effort `observed_tokens` retains known input/output pairs with `tokens_partial`,
including when unrelated usage or cache metadata is missing. Canonical token counts,
fractions and rates keep their completeness guards; observations are not a replacement
denominator. Empty/all-unknown observations stay null and measured zero stays zero.
See [ADR-014](../decisions/ADR-014-observed-token-subtotals.md).
Rejected-only request scopes retain errors and zero recorded completion usage.
Accepted/uncertain requests and other missing evidence stay partial; see
[ADR-016](../decisions/ADR-016-rejected-codex-requests.md).
Intermediate stream records contribute scope evidence, counts and latency, never
additional usage or cost. Projection and aggregation follow full-identity deduplication.
Evidence preserves emitted model identities and user/backend/project/session boundaries,
including model-less session attribution. Unrelated models cannot establish or
invalidate rejection-only scope evidence.

Log aggregates share a 50,000-row transfer budget, independent of event volume.
The query counts each family before transfer. If their combined size exceeds the
budget, each family receives an equal bounded allowance; oversized families return
only a limit marker. Total usage is independent of Effort rows. A capped family is
discarded and named in
`coverage.logs.limited_sections`, with `partial=true`; unaffected summaries remain usable.
Missing scope coverage marks known usage/cost partial and withholds strict ratios and
session units. Missing usage coverage withholds token/cost summaries. Event-count
coverage becomes `limited` only when that family itself is capped. Oversized metric
results retain their existing independent `limited` status. Transport and permission
failures remain errors. No schema or Collector migration is required. The real
ClickHouse regression in `scripts/test-client-sql.sh` compares the aggregate result
with the raw fold and exercises large stream and request/completion windows.

Trace queries select the latest 50 trace groups and retain at most the latest 200
distinct span records per group. Coverage counts and operation summaries describe
only the selected records. Truncated traces are labelled and withhold complete
wall time and error totals; their selected span timings remain diagnostic.
Conflicting span identities withhold the affected trace and mark coverage partial;
they do not suppress log or metric results.
Model filters require model evidence on metrics/spans; model-less spans can therefore
be absent from a filtered trace. Span status is not a business-success determination.

## Privacy and deployment

Structured signal allowlists retain identity, backend, model, effort and operational
dimensions. Prompts, arguments, outputs, filesystem paths, URLs and auth headers
are not additional metric/trace fields. UI masking remains separate from API auth.

Follow [collection setup](../runbooks/codex-telemetry.md) and
[schema migrations](../runbooks/schema-migrations.md). Exporter configuration and
source code do not establish deployment. Existing Codex processes must be restarted
to load changed settings. Verify actual ClickHouse rows and signal coverage afterward.
