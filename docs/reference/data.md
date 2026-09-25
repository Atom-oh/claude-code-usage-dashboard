# Data and Aggregation

The `claude_code` database stores Claude Code and Codex telemetry.
`CLAUDE_ENABLED` defaults to true, `CODEX_ENABLED` to false; both false is invalid.
Codex usage uses the existing log schema; migration 006 adds separate diagnostic metrics.
Client, backend and model remain distinct: model names do not identify the producer.

## Storage and source fields

| Store | Meaning | Source |
|---|---|---|
| `otel_metrics_sum` | Counter datapoints, promoted dimensions and `SeriesKey` | [local schema](../../clickhouse-schema.sql) |
| `otel_metrics_sum_hourly` | Per-series hourly max/sum states, fed by a materialized view | Same schema |
| `otel_metrics_gauge` | Exporter-compatible gauge storage; not the main KPI source | Same schema |
| `codex_metrics_{sum,gauge,histogram,exponential_histogram}` | Native Codex diagnostic observations, separate from billed usage | [migration 006](../../clickhouse-migration-006.sql) |
| `otel_logs` | Event records; `EventName` reads `event.name`: Claude normally uses `api_request`, `tool_result`, etc.; Codex uses `codex.*` | Same schema |
| `otel_traces` | Claude spans and resource-tagged Codex spans | Same schema |
| `schema_migrations` | Recorded migration versions and evidence metadata | [migration 004](../../clickhouse-migration-004.sql) |

[collector-config.yaml](../../collector-config.yaml) receives local OTLP on gRPC 4317
and HTTP 4318. Enabled Claude retains eight allowed metrics, its existing log scrub
and optional traces. Codex exports logs, metrics and traces through separate pipelines.
Logs remain the only Codex usage/cost source. Separate log pipelines
identify established Claude event names/service provenance and the Codex namespace,
remove Codex bodies/content fields and inherited
`experiment.group`, and preserve explicit identity/backend/project attributes.
`create_schema: false` requires schema installation before ingestion.
The bounded disk queue uses `file_storage`; supervision and rollout are separate concerns.
Metric/trace allowlists and pinned-exporter limitations are defined in the
[collection contract](../runbooks/codex-telemetry.md#collection-contract).

`ResourceAttributes` supplies `UserEmail`, `EndUserId`, `AppVersion` and `ProjectName`
from `user.email`, `enduser.id`, `service.version` and `project.name`.
Metric `Attributes` supplies dimensions such as model, type, decision, effort, agent, skill, plugin, marketplace,
MCP, speed, start type and source dimensions. Logs and traces have their own maps.
`Entrypoint` reads `app.entrypoint` from the signal's map.

For Claude logs, `McpServerName` and `McpToolName` decode JSON in `tool_parameters`;
MCP connection events instead use `LogAttributes['server_name']`.
For traces, `SpanType` is `SpanAttributes['span.type']`, such as `llm_request`,
`tool.execution` or `tool.blocked_on_user`. Interaction duration comes from `Duration`
in nanoseconds, converted to milliseconds; its `duration_ms` attribute is not the source.

`TokenType` is overloaded by metric:

| Metric suffix | `TokenType` |
|---|---|
| `token.usage` | `input`, `output`, `cacheRead`, `cacheCreation` |
| `lines_of_code.count` | `added`, `removed` |
| `active_time.total` | `user`, `cli` |

Use [metric definitions](../metrics.md) for interpretation. A promoted field's existence
does not establish that clients emit it or that a query uses it. In particular, schemas
carry `StartType` for distinguishing `agents_view`, but current session queries do not
universally exclude it. `Speed` is not used by `effortMix`.

## Codex logs and common client aggregates

[clientMetrics.js](../../dashboard/server/clientMetrics.js) reads `otel_logs.Timestamp`
in `[from,to)`. Codex 0.154's zero source timestamp is promoted from observed time by
the Collector. SQL deduplicates timestamp plus sorted resource/log maps before grouping.
Only usage-bearing SSE/WebSocket `response.completed` events supply usage; generic
completions do not establish zero. Partial/invalid components remain null.

| Attribute | Meaning |
|---|---|
| Log `conversation.id`, `model` | Session and emitted model; preserve model inference scope |
| `input_token_count` | Input total including cache subsets |
| `cached_token_count`, `cache_write_token_count` | Subtract both from input to obtain uncached input |
| `output_token_count`, `reasoning_token_count` | Output and its reasoning subset; never add twice |
| Resource `backend` | Raw tag; queries resolve backend from the model id prefix first, tag as fallback ([ADR-017](../decisions/ADR-017-backend-cost-fallback.md)) |
| Resource `user.email`, `enduser.id` | First nonempty identity; no change to Claude metric `UserEmail` |
| Resource `project.name` | Codex project grouping, not AWS billing attribution |

Counts are nonnegative integers; subsets must fit their totals. Preserve each request's
context tier before [pricing](../../dashboard/server/codexPricing.js). Unknown rates or
invalid usage make those records unpriced. Keep valid and invalid usage in separate
SQL groups so malformed peers cannot erase usable costs. Shared aggregates sum known
costs with `cost_partial`/unpriced disclosure; an all-unpriced group remains null.
Claude reports use `client_reported`; Codex uses `aws_list_estimate`. Both retain
billing/coverage limitations under [ADR-013](../decisions/ADR-013-known-cost-subtotals.md).
Two ADR-017 fallbacks: an Anthropic model absent from Codex's table prices from the Claude
table (`price_source: "claude_table"`); a Claude row with no usable report prices from
tokens (`cost_basis: "computed_estimate"`/`"mixed"`), `/api/clients/overview` only.

`observed_tokens` sums safe input/output pairs independently of pricing or incomplete
cache/reasoning metadata. Pair validity is a separate SQL grouping dimension so an
unknown pair cannot erase a usable pair in the same malformed-usage group. Canonical
`tokens` stays strict; `tokens_partial` discloses incomplete validation/coverage or
overflow. All-unknown stays null and known zero stays zero.
[ADR-014](../decisions/ADR-014-observed-token-subtotals.md) owns the display policy.

Active Codex session/user/model/backend/project combinations without usage anywhere in
the selected range null affected canonical token folds and increment `quality.missing_usage`
and `unpriced`; known cost and observed-token subtotals retain partial disclosure.
Crossing a time bucket does not create a false gap. Presence cannot
detect every dropped response within a populated combination. Explicit zero is valid.
Identified scopes containing only explicit request rejections are exempt: they record no
completion usage while retaining request/error counts. Other evidence still requires
usage; see [ADR-016](../decisions/ADR-016-rejected-codex-requests.md).
`observed_records` combines deduplicated log-event counts with active Claude usage
aggregate-row counts; it is not comparable request volume. Idle counter observations
can populate `timeseries` while that count is zero. They retain per-signal availability
and do not add active population or non-timeline rows.
[ADR-015](../decisions/ADR-015-idle-chart-buckets.md) distinguishes measured zero,
empty-bucket recorded usage and unavailable usage in charts.

All breakdowns share selected rows. User counts union nonempty emitted IDs, not employees;
sessions are namespaced by client. Up to four hours uses minute buckets, otherwise hourly.
The first partial bucket is labelled at `from`; Claude's local raw query preserves its
pre-range baseline. When Claude is selected, its resolved end applies to both sources;
Codex-only retains the requested end. `effective_range`/`bucket_hours` expose this choice.
Claude's approximations below remain. Recorded `response.failed` is an error even after
HTTP 200; a fatal CLI exit may omit unflushed logs. Timing is not necessarily generation
latency. See [API contracts](../api-reference.md) and [setup](../runbooks/codex-telemetry.md).

## Claude counter calculations

[queries.js](../../dashboard/server/queries.js) treats `AggregationTemporality=2` as
cumulative and other temporalities as interval sums. Never sum repeated cumulative
`Value` exports directly. `incFlat` computes the nonnegative difference between the
end value and the pre-start baseline per series; delta data uses an in-window sum.
The baseline lookback is three days. A needed baseline older than that can be lost.

The source schema defines metric `SeriesKey` as:

```sql
if(
    MetricName = 'claude_code.session.count',
    cityHash64(toString(Attributes)),
    cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix))
)
```

Hashing the entire attribute map preserves distinct streams beyond promoted dimensions.
Including `StartTimeUnix` separates counter resets in resumed processes sharing a session.
The session counter keeps the label-only key so process restarts do not redefine the
session unit. This is source intent; deployment requires migration and rebuild evidence
([ADR-003](../decisions/ADR-003-fold-start-time-into-series-key.md)).

| Query path | Source and boundary behavior |
|---|---|
| `incFlat(metricFilter, spanMs)` | Raw table for spans **at most four hours**; rollup otherwise |
| Rollup `incFlat` | Retains rollup current values and corrects the start-hour baseline from raw rows; delta start-hour values are replaced with the in-window raw sum |
| `incBucketed` | Hour/day rollups plus raw correction for the first bucket; aggregate, then window difference, then outer range filter |
| `incBucketedRaw` | Minute buckets from raw rows; outer `t >= from` filters by bucket start, so an unaligned first bucket is not guaranteed to be retained |
| `activeUsers` | Raw existence query at most four hours; hourly existence query otherwise |
| Version, effort, agent, language and project breakdowns | Local raw-table queries preserving dimensions outside the shared helper |

`range(from, to, raw)` binds UTC timestamps at second precision. Raw paths keep the supplied
boundaries. Rollup paths floor historical `to` to an hour unless that would make the range
empty; an end within ten minutes of now is kept. The current rollup hour can include data
newer than the requested end. Existence/day queries also retain hourly approximations.
`costByModelCompare` has its own aligned comparison logic for longer windows.
Do not claim exact equality between all snapshots, charts, previous periods or arbitrary
windows. Inspect the specific helper and consumer.

## Claude channels, users and projects

[grouping.js](../../dashboard/server/grouping.js) infers a channel per session over retained
rollup rows, without a request-time restriction on that classification:

1. Any nonempty model that does not start with `claude-` selects `bedrock`.
2. Otherwise `has_org=1` selects `enterprise`.
3. Otherwise the channel is `unknown`.

These are access-channel heuristics, not coding-client identities or randomized experiment
assignments. The broad model rule is not a client detector; Codex uses its log namespace
and explicit backend instead. One user can have sessions in both channels; channel
headcounts overlap.
The stored `ExperimentGroup` resource attribute is not the dashboard classifier.

Channel and `backend` are separate: `enterprise` still maps to `anthropic`, but elsewhere
`backend` is resolved per row from the model id prefix, same as Codex ([ADR-017](../decisions/ADR-017-backend-cost-fallback.md)) —
a `bedrock` channel row with a bare, unrecognized model is now `unknown`, not `bedrock-runtime`.

For Claude model breakdowns and diagnostic pricing, SQL `normModel` and JavaScript
`normalizeModelId` strip the context-window suffix, routing prefix (`us`, `us-gov`, `eu`, `apac`, `jp`, `au`,
`global`), `anthropic.` prefix, Bedrock version suffix, then date suffix, in that order.
Keep the two implementations aligned so display rows and price keys describe the same model.

Most user queries still require nonempty `UserEmail`. `projectBreakdown` and the user count
in `entrypointBreakdown` use `coalesce(nullIf(UserEmail,''), nullIf(EndUserId,''))`.
The latter's user filter still matches `UserEmail`. The fallback is not universal:
[ADR-002](../decisions/ADR-002-bedrock-identity-fallback.md).
[user-data.sh](../../user-data.sh) supplies an operator identity through resource attributes;
historical missing identities cannot be reconstructed from that setting.

[Migration 005](../../clickhouse-migration-005.sql) adds project and entrypoint columns to
metrics, logs and traces, leaving the rollup unchanged. It intentionally does not run
`MATERIALIZE COLUMN`: the fields are simple map lookups, with old-part read behavior
documented in the migration. Project tags require operator configuration. Check the active
ownership of `OTEL_RESOURCE_ATTRIBUTES` before assuming per-repository settings take effect.

The 2026-09-09 local-receiver test recorded whole-string replacement: a project-level
`env.OTEL_RESOURCE_ATTRIBUTES` replaced the shell/user value rather than merging keys.
Repeat existing attribution keys (`experiment.group`, `team`, `enduser.id`, `user.email`)
when configuring a project value, then verify the emitted attributes in a new session.
Dropping those keys can remove channel or user attribution without an ingestion error.

The checked-in `user-data.sh` gives managed settings ownership of this variable; those
settings take precedence over project settings. Operators must either include the project
tag in the managed value or deliberately transfer ownership to project settings. The
second option makes each repository responsible for retaining all required attribution
keys. A fixed instance tag is unsuitable when one instance serves multiple repositories.
When project configuration contains user identity, generate it per user in untracked local
settings. Never commit shared project settings containing a fixed user identity.

Project labels can appear in tables, CSV and shared filter URLs. Use an approved opaque
identifier for sensitive repository names; user-email display masking does not protect
project labels. Untagged sessions fold into `(untagged)`.

`probeProjectColumns` in [schema.js](../../dashboard/server/schema.js) checks **only**
`ProjectName` and `Entrypoint` on `otel_logs`. A true result is not proof that metric or
trace columns, backfills or all migration steps exist. It gates project filtering and
`projectBreakdown`; see [API scope](../api-reference.md).

## Migration and retention evidence

The [replicated schema](../../infra/files/clickhouse-schema-replicated.sql) is applied by
the Terraform schema-init Job; the root schema is for local single-node ClickHouse.
Migration 002 adds telemetry dimensions and traces; 003 changes keys and rebuilds rollups;
004 records migrations; 005 adds project/entrypoint fields; 006 adds four Codex metric
tables after 004, independently of 005. Existing tables and materialized
views are not automatically replaced by `CREATE ... IF NOT EXISTS`.
Operators run the numbered migration scripts through the schema runbook; the Terraform
Job executes the replicated schema file, not those numbered scripts.

The configured retention is:

| Store | Replicated cold move | Delete age in both schema copies |
|---|---|---|
| Raw sum/gauge metrics | 90 days | 180 days |
| Codex native metrics | 90 days | 180 days |
| Hourly rollup | None; delete-only TTL | 180 days |
| Logs/traces | 45 days | 90 days |

The rollup has a delete-only TTL because an existing table may use a storage policy without
a cold volume. It still contains user identities and must not outlive raw retention.
Moving to cold storage is not deletion.

Use [schema migrations](../runbooks/schema-migrations.md) and the
[rollup rebuild runbook](../runbooks/rollup-rebuild-segment-key.md) to verify deployment.
`/api/config` exposes sampled key status and recorded versions; neither establishes every
historical row or replica's state. This reference makes no live rollout assertion.
