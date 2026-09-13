# Data and Aggregation

The queries consume Claude Code telemetry in the `claude_code` database. They are not a
generic coding-client analytics layer: native Codex telemetry is not supported by the
current metric allowlist and queries. A model name, including an OpenAI model name, does
not identify the coding client that produced an event.

## Storage and source fields

| Store | Meaning | Source |
|---|---|---|
| `otel_metrics_sum` | Counter datapoints, promoted dimensions and `SeriesKey` | [local schema](../../clickhouse-schema.sql) |
| `otel_metrics_sum_hourly` | Per-series hourly max/sum states, fed by a materialized view | Same schema |
| `otel_metrics_gauge` | Exporter-compatible gauge storage; not the main KPI source | Same schema |
| `otel_logs` | Event records; `EventName` reads the bare `event.name`, such as `tool_result` | Same schema |
| `otel_traces` | Optional beta spans, including interaction, LLM and tool timing | Same schema |
| `schema_migrations` | Recorded migration versions and evidence metadata | [migration 004](../../clickhouse-migration-004.sql) |

[collector-config.yaml](../../collector-config.yaml) receives local OTLP, allows eight
`claude_code.*` metrics, scrubs `prompt` and `prompt_text` from logs, and exports all three
signal pipelines. `create_schema: false` requires schema installation before ingestion.
The bounded disk queue uses `file_storage`; supervision and rollout are separate concerns.

`ResourceAttributes` supplies `UserEmail`, `EndUserId`, `AppVersion` and `ProjectName`
from `user.email`, `enduser.id`, `service.version` and `project.name`.
Metric `Attributes` supplies model, type, effort, agent, skill, plugin, marketplace,
MCP, speed, start type and source dimensions. Logs and traces have their own maps.
`Entrypoint` reads `app.entrypoint` from the signal's map.

For logs, `McpServerName` and `McpToolName` decode JSON in `tool_parameters`;
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

## Counter calculations

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

## Channels, users and projects

[grouping.js](../../dashboard/server/grouping.js) infers a channel per session over retained
rollup rows, without a request-time restriction on that classification:

1. Any nonempty model that does not start with `claude-` selects `bedrock`.
2. Otherwise `has_org=1` selects `enterprise`.
3. Otherwise the channel is `unknown`.

These are access-channel heuristics, not coding-client identities or randomized experiment
assignments. The broad model rule must not be reused as proof that non-Claude clients are
supported. One user can have sessions in both channels; channel headcounts overlap.
The stored `ExperimentGroup` resource attribute is not the dashboard classifier.

For model breakdowns and pricing, SQL `normModel` and JavaScript `normalizeModelId`
strip the context-window suffix, routing prefix (`us`, `us-gov`, `eu`, `apac`, `jp`, `au`,
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
004 records migrations; 005 adds project/entrypoint fields. Existing tables and materialized
views are not automatically replaced by `CREATE ... IF NOT EXISTS`.

The configured retention is:

| Store | Replicated cold move | Delete age in both schema copies |
|---|---|---|
| Raw sum/gauge metrics | 90 days | 180 days |
| Hourly rollup | None; delete-only TTL | 180 days |
| Logs/traces | 45 days | 90 days |

The rollup has a delete-only TTL because an existing table may use a storage policy without
a cold volume. It still contains user identities and must not outlive raw retention.
Moving to cold storage is not deletion.

Use [schema migrations](../runbooks/schema-migrations.md) and the
[rollup rebuild runbook](../runbooks/rollup-rebuild-segment-key.md) to verify deployment.
`/api/config` exposes sampled key status and recorded versions; neither establishes every
historical row or replica's state. This reference makes no live rollout assertion.
