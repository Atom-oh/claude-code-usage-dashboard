# Selectable Claude Code and Codex telemetry

Collection/bootstrap, the launcher, authenticated client API and SPA support client
selection. Install the same approved release and propagate matching activation
settings before enabling a client. Repository changes do not deploy EKS, update existing EC2
instances, change IAM/billing, or create credentials. These lifecycles are separate.

## Select clients consistently

| Mode | `CLAUDE_ENABLED` | `CODEX_ENABLED` |
| --- | --- | --- |
| Default / Claude only | `true` | `false` |
| Codex only | `false` | `true` |
| Both | `true` | `true` |

Flags accept case-insensitive `true/false` or `1/0`; empty/unset uses the defaults.
Both false is invalid. `CODEX_BEDROCK_ENDPOINT` accepts `mantle` (default) or `runtime`.
Client selection is independent of Claude's `EXPERIMENT_GROUP`/`GROUP_MODE` channels.

Terraform inputs `claude_enabled`, `codex_enabled`, `codex_bedrock_endpoint` and
optional `codex_pricing_json` populate the dashboard environment. They do not update
workshop instances, and an older application image does not consume these values.
Propagate matching client settings to each instance through its fleet configuration:

- `/etc/otelcol/env`: Collector flags and existing ClickHouse settings; root-only.
- `/etc/ccdash/clients.env`: nonsecret launcher defaults, parsed as `KEY=value` data.

Bootstrap writes both. Restart `otelcol.service` after configuration changes and
restart Codex through the launcher. Existing processes keep their prior settings.
Disabled feeds are rejected on ingestion; stored rows and already queued exporter
batches remain. Raw Collector execution with both flags false drops both feeds;
the service's activation preflight rejects that combination before startup.

## Bootstrap artifacts and recovery

Stage both files from the same approved release before running `user-data.sh`:

```text
/opt/ccdash-bootstrap/
  collector-config.yaml
  scripts/codex-launch.py
```

`BOOTSTRAP_ASSET_DIR` selects another directory. Both files are mandatory even for
Claude-only installs; existing configuration is not a substitute. Review the script's
ClickHouse destination, SSM parameter and AWS region for the target environment.

Bootstrap installs Python 3, `/usr/local/bin/ccdash-codex`, the enabled clients, and
Collector 0.119.0. Codex is pinned to `@openai/codex@0.154.0`; installation/version
failure stops bootstrap. Another explicit `CODEX_VERSION` needs fresh qualification.
Existing Claude installation/version behavior is retained when Claude is enabled.

Before replacement, bootstrap snapshots Collector executables, launcher defaults,
Collector config/environment, its systemd unit and enablement link, plus whether
it was running. Snapshot and candidate files live in a private temporary directory
under `TMPDIR` (default `/var/tmp`). SSM secret reads and validation suppress xtrace;
credentials are not written into the release artifacts or nonsecret defaults.

The Collector and launcher executables remain in private staging paths through
candidate validation. Only then is an existing service explicitly stopped, suppressing
automatic restarts during same-directory atomic file promotion. After restart, five
one-second active-state checks detect startup
failure. A failed bootstrap restores the snapshot and starts the prior Collector if
it was running; an unsuccessful rollback retains its private snapshot and reports
the recovery directory for the operator.
This is bounded startup recovery, not ongoing availability monitoring or rollback of
package-manager/client-install side effects. The durable exporter queue is preserved.

The service runs `ccdash-codex --check-collector` and the Collector validator before each
start. This offline check reads only activation flags from the service environment;
it never opens Codex launcher defaults or validates its model, region, version or
credentials. Stale Codex-only settings therefore cannot stop Claude collection.
`ccdash-codex --check` remains the full launcher configuration check used by bootstrap
and operators. Failed candidate validation leaves a diagnostic only in
the private temporary directory, which cleanup removes; reproduce syntax failures
with the Collector validator and nonsecret placeholder connection values.

## Bedrock endpoint and authentication

Defaults follow the [AWS model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html).

| Setting | Mantle | Runtime |
| --- | --- | --- |
| `CODEX_BEDROCK_REGION` default | `us-west-2` | `us-west-2` |
| `CODEX_MODEL` default | `openai.gpt-6-astra` | `us.openai.gpt-6-astra` |
| Provider | Built-in `amazon-bedrock` | Custom `ccdash-bedrock-runtime` |
| Base URL | `https://bedrock-mantle.us-west-2.api.aws/openai/v1` | `https://bedrock-runtime.<region>.amazonaws.com/openai/v1` |
| Authentication | Native AWS credential chain/profile or supported Bedrock key | Externally supplied `AWS_BEARER_TOKEN_BEDROCK` |

Runtime's custom Responses provider cannot use IAM role credentials alone. Inject
an existing bearer credential through the approved credential process; the launcher
never persists it or puts it in command arguments. No token-generation helper is
configured. Mantle's native URL belongs to Codex; this integration restricts it to
`us-west-2`. See the [Codex configuration guide](https://developers.openai.com/codex/config-advanced).

Leave `CODEX_MODEL` unset for the endpoint default. When switching an existing
installation, remove or replace its explicit model together with the endpoint.
Runtime accepts `us.openai.*`/`global.openai.*` profiles; `us.` requires a US source
region. `scripts/codex-launch.py` owns the qualified region allowlist. Local checks
do not prove model access, quotas, IAM authorization or a configured model price.

Runtime forces `web_search="disabled"` and rejects `--search`/`web_search` overrides:
its hosted search execution failed in bounded testing. Client-side functions passed.
Mantle retains the user's search selection. No dashboard IAM policy is changed.

## Launch and metadata

Inspect nonsecret effective configuration without invoking a model:

```bash
ccdash-codex --check
```

Launch normally in the workshop workspace:

```bash
ccdash-codex
```

`CODEX_OTEL_RESOURCE_ATTRIBUTES` supplies Codex defaults such as
`user.email=participant@example.invalid,team=workshop,project.name=demo`.
Bootstrap uses the existing instance identity lookup to fill missing `user.email`.
Process `OTEL_RESOURCE_ATTRIBUTES` values override those defaults. The launcher then
removes `experiment.group` and fixes `client=codex` and
`backend=bedrock-mantle|bedrock-runtime` only for
the child process. Claude's global/managed resource attributes are not rewritten.
Do not put credentials or prompt content in metadata.

Provider/model/profile/OTel overrides are managed by the launcher; use deployment
variables instead. User permissions, approvals and ordinary Codex arguments retain
their existing behavior. Defaults are read from `/etc/ccdash/clients.env` unless
`CCDASH_CLIENT_ENV` selects another file; its contents are never shell-evaluated.

## Collection contract

Receivers bind only to loopback: Claude OTLP/gRPC on `127.0.0.1:4317`, Codex OTLP/HTTP
JSON on `127.0.0.1:4318/v1/{logs,metrics,traces}`. Existing ClickHouse TLS, ingest
credentials, durable queues and retry settings remain. Apply additive
[migration 006](../../clickhouse-migration-006.sql) before enabling the new pipelines.
It requires ledger 004, not migration 005; Codex traces reuse existing `otel_traces`.

```toml
[otel]
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json", headers = { x-ccdash-backend = "bedrock-mantle" } } }
metrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/metrics", protocol = "json", headers = { x-ccdash-backend = "bedrock-mantle" } } }
trace_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/traces", protocol = "json", headers = { x-ccdash-backend = "bedrock-mantle" } } }
log_user_prompt = false
```

The launcher supplies these process overrides; do not copy them into global Codex config.
Runtime substitutes `bedrock-runtime` in all three headers. Receivers expose request
metadata only to the Codex pipelines. A valid `x-ccdash-backend` overrides resource
backend; an absent/invalid header preserves a valid resource backend. Otherwise backend
stays absent. The temporary header attribute is deleted before export. Model names,
metric/span attributes and inherited client labels never establish backend or producer.

Structured logs remain the single Codex usage/cost feed. Claude retains its eight allowed
metrics, counter temporality, log scrub and experiment grouping. Claude logs accept
established unprefixed names (`api_request`, `tool_result`, etc.), `claude_code.*`
aliases, or Claude service provenance. `codex.*` is always excluded from that pipeline,
even with an inherited Claude service. Unknown events without Claude provenance are
dropped. Claude traces require enabled Claude and `service.name=claude-code`.

Separate `metrics/codex` and `traces/codex` pipelines require enabled Codex and an
explicit Codex service name, including native `codex_exec` and `codex_cli_rs`.
Metric names must be bounded `codex.*` identifiers. Sums, gauges, histograms and
exponential histograms go to dedicated tables; summary metrics are unsupported.
Span names need no `codex.*` prefix: `session_task.turn`, `run_turn` and model-less
parents/children remain usable. Invalid/free-text names become `codex.operation`.

Metric/trace allowlists in [collector-config.yaml](../../collector-config.yaml) retain
identity and structured operational dimensions. They remove unknown/content/path/URL/
header fields, scope attributes/schema URLs, descriptions, events, status messages and
trace state. `thread.id` is an OS thread ID, not conversation identity.
`sandbox_policy` can contain paths and is excluded; policy UI uses normalized log fields.

Collector 0.119 cannot scrub exemplar/link attributes: affected points/spans are rejected.
Native 0.154 replay retained all 48 metric objects (39 names) and 463 spans without
exemplars/links. This fixture is not a completeness guarantee; retest binary upgrades.

The separate Codex pipeline tags `client=codex`, strips inherited experiment groups,
clears bodies and removes known prompt/argument/output fields while retaining usage,
call IDs, tool names, status, timing and explicit identity/backend/project metadata.
This established log scrub remains separate from the stricter added metric/trace allowlists.

Codex 0.154.0 emits zero `timeUnixNano`; the Collector promotes `observedTimeUnixNano`
into `otel_logs.Timestamp` while preserving nonzero source timestamps and
`event.timestamp`. `conversation.id` remains a log attribute. A generic
`response.completed` event can precede a usage-bearing completion. Consumers must
deduplicate timestamps plus sorted resource/log maps and price only usage-bearing
SSE/WebSocket completions. Input contains cache reads/writes; output contains
reasoning. Missing/partial usage is not measured zero. HTTP 200 with `response.failed`
is an error, and a fatal CLI exit may omit unflushed telemetry entirely.

### Storage interface

Columns follow the actual pinned exporter's
[metric models](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/v0.119.0/exporter/clickhouseexporter/internal).
Migration 006 checks all 102 required column/type pairs before recording its ledger row.
The [local](../../clickhouse-schema.sql) and
[replicated](../../infra/files/clickhouse-schema-replicated.sql) copies use the same
columns and checksum. No existing tables, rollups or billing data are rewritten.

Migration 006 owns the exact columns: resource/dimension maps, scope metadata,
nanosecond start/end times, flags and exemplars. Sum/gauge tables store `Value`;
histogram tables store counts, sum, extrema and bucket arrays. Sum/histogram tables
retain aggregation temporality; sums retain monotonicity.

Series identity includes the retained resource/dimension maps, scope, unit, metric type,
temporality and start time. Keep `Flags` and nanosecond boundaries. Never sum cumulative
samples; use a prior baseline and report gaps/resets. The new tables have no rollups.
Their local delete TTL is 180 days; replicated tables move to cold at 90 and delete at 180.

Absent histogram `Sum/Min/Max` become zero; exponential `ZeroThreshold` is not stored.
The pinned
[OTTL datapoint getter](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.119.0/pkg/ottl/contexts/ottldatapoint/datapoint.go)
returns zero for absent `sum` and has no `min/max` paths, preventing presence annotation
or selective rejection. Replay proves missing and explicit-zero fields become identical.

**API requirement:** without trusted presence evidence, raw-zero `Sum/Min/Max` are
ambiguous. Preserve counts/buckets but return null and partial coverage for affected
statistics, including means. Apply this before aggregation. A derived zero difference
between known positive cumulative sums remains valid. Never infer exact percentiles
from means. Native histograms supplied all fields with delta temporality `1`; other
versions/producers need verification.
Metric costs/tokens and trace usage are diagnostics, never additional billed usage.
`otel_traces` retains normal trace/span/parent IDs and nanosecond duration with
`ResourceAttributes['client']='codex'`; its existing columns and TTL remain unchanged.

## Validation and compatibility limits

```bash
export TMPDIR="${TMPDIR:-/var/tmp}"
bash tests/run-all.sh client-collection
RUN_COLLECTOR_TESTS=1 bash tests/run-all.sh client-collection
terraform fmt -check -recursive infra/
```

Bootstrap tests stub AWS/package/service boundaries and verify filesystem writes,
secret suppression and failed-upgrade recovery. Optional Collector replay needs
Docker, PyYAML and `otel/opentelemetry-collector-contrib:0.119.0`; it validates the real
config, uses a local file exporter on an internal network, publishes no host port,
and removes only its own containers/network. The storage test also uses
`clickhouse/clickhouse-server:24.8` on an internal network. Fixtures cover activation,
privacy, timestamp promotion, header provenance, Claude counter compatibility, all four
metric insert shapes, trace ancestry, migration 004/005 independence, idempotence and
incompatible-schema ledger guards.

On 2026-09-14, seven bounded raw API requests used existing SigV4 credentials in
`us-west-2`, `max_output_tokens=256`, low reasoning, streaming and `store=false`.
Mantle `openai.gpt-6-astra` and Runtime `us.openai.gpt-6-astra` each passed streaming
function/result round trips. Three Runtime probes showed that declaring hosted
search does not establish execution support: forced search returned HTTP 400 and
automatic search ended in `response.failed`. Nonzero cache behavior was not tested.

Native Codex 0.154.0 separately produced a local synthetic tool/OTLP fixture. No live
CLI-to-AWS call was made because an enforceable output-token CLI cap was not found.
Raw SigV4 success does not verify Runtime's bearer path or a complete live
CLI-to-Collector-to-ClickHouse pipeline. The private validation workspace retains
the dated compatibility record. Qualify the live path before rollout; no invoice
reconciliation, production deployment, credential creation or billing change is claimed.

## Dashboard cost and query contract

See [API semantics](../api-reference.md#coding-client-views). Model-card estimates
retain scope/context tiers; they are not invoices.
Default rates cover GPT-6 Astra and
[GPT-5.6 Luna](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-luna.html).
Luna rates were verified on 2026-09-17, including the 272,000-input-token context
boundary, cache reads/writes, and separate commercial regional/global prices.
Unpriced models are excluded from known-cost subtotals, with `cost_partial` and
unpriced counts disclosed. An all-unpriced group remains unavailable even when
its tokens were collected correctly. Check model pricing before treating those
gaps as a Collector outage. [ADR-013](../decisions/ADR-013-known-cost-subtotals.md)
defines the shared-client and Codex detail policy.
`CODEX_PRICING_JSON` (`codex_pricing_json`) keys must omit `us.`/`global.` (lookup strips
them). Entries require positive integer `short_context_limit`, `regional` and optional
`global`, each with `short`/`long` rates: finite nonnegative USD/million `input`,
`cacheWrite`, `cacheRead`, `output`. Invalid entries fail startup; config hides rates.

With Docker/server dependencies, `bash scripts/test-client-sql.sh` owns a disposable
loopback ClickHouse using the local schema; external DB URLs are ignored.
