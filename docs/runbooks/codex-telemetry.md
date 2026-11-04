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

For developer shell hooks, source [the Collector guard](../../scripts/ensure-otelcol.sh)
before setting exporter variables. It starts only a loaded unit confirmed inactive
or failed. An inaccessible systemd bus (including a Codex sandbox), missing unit
or transitional state does not trigger `sudo` or prevent exporter configuration.
Its successful return is not a Collector-health assertion; inspect the host service
and received telemetry separately. Keep noninteractive shell startup quiet.

Host-specific wrappers can select a gateway instead of the workshop provider below.
A gateway is not proof of a particular AWS upstream, and can tag every request the same
regardless of actual model/endpoint. The dashboard no longer trusts the tag alone; see
[ADR-017](../decisions/ADR-017-backend-cost-fallback.md). Validate routing independently.

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

Codex started outside the launcher (for example `codex exec` or an app-server host
such as an editor plugin) exports only when the operator configured exporters for it,
for example an `[otel]` section in `~/.codex/config.toml`; bootstrap does not. Such
telemetry may lack user identity when `OTEL_RESOURCE_ATTRIBUTES` is absent. Bootstrap writes the launcher's effective `user.email` to
`CODEX_DEFAULT_USER_EMAIL` in `/etc/otelcol/env`, and the Codex pipelines insert it only
when a resource has neither `user.email` nor `enduser.id`. Values outside
`[A-Za-z0-9._+@-]` are dropped. Existing rows are not backfilled; hosts pick this up on
their next bootstrap.

Provider/model/profile/OTel overrides are managed by the launcher; use deployment
variables instead. User permissions, approvals and ordinary Codex arguments retain
their existing behavior. Defaults are read from `/etc/ccdash/clients.env` unless
`CCDASH_CLIENT_ENV` selects another file; its contents are never shell-evaluated.

## Collection contract

### Self-service setup for local wrappers

For an already running local Collector, configure both clients directly. Keep the
identity in the launching shell when Claude user settings do not already own the
resource-attribute string:

```bash
export OTEL_RESOURCE_ATTRIBUTES="user.email=developer@example.invalid,project.name=workshop"
python3 scripts/configure-client-telemetry.py \
  --user-id developer@example.invalid \
  --codex-config "${CODEX_HOME:-$HOME/.codex}/config.toml" \
  --claude-config "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
```

This helper configures clients only; it does not install or change the Collector.
Both intended client pipelines must already be enabled. Set the attributes in each
launching shell or its startup configuration; a new settings-owned string is not
created, so later shell project/team tags remain effective.
Run it as the client user. It writes private UTF-8 files and backups owned by that
user. Backups may contain the original provider/auth settings; retain or remove them
under the same private-file policy as the originals.

Existing Claude exporter settings that differ from the local defaults, including
signal-specific endpoints/protocols and exporter credentials, are conflicts. Setup
stops before either client is written. To deliberately move collection to loopback,
first inspect `--check --replace-claude-telemetry` with the same arguments: it lists
changed environment key names, never their values. Then repeat without `--check`.
The replacement option resets the exporter settings, removes other OTLP overrides
and clears generic/per-signal headers; it preserves model, provider, approval and
resource-attribute ownership. It is also required when re-enabling previously
disabled Claude exporters. Explicit per-signal defaults pin all three Claude feeds
to local gRPC even if the launching shell has different endpoint/protocol/header
defaults. Later explicit client/organization overrides remain outside this check.
Claude defaults enable session-id metrics and enhanced telemetry beta; Codex user
prompt logging stays disabled.

The optional installer and shell helper are distributed separately and are not
included here. Their integration tests skip in a repository-only checkout; the
checked-in helper command above is tested independently.

The separately, locally distributed `scripts/setup-test-telemetry-all.sh` uses
[configure-client-telemetry.py](../../scripts/configure-client-telemetry.py) to
configure the shared client settings. Keep both files together. Python 3.11+
provides TOML validation; older Python needs `tomli` (the pip-vendored copy is
also supported). No provider/model/credential/approval setting is replaced.

```bash
# Install/update the collector and both client configurations.
bash scripts/setup-test-telemetry-all.sh developer@example.invalid

# Repair missing client settings on a host whose collector is already enabled.
bash scripts/setup-test-telemetry-all.sh --clients-only developer@example.invalid
```

The clients-only mode does not install, restart, reconfigure or change credentials
for the collector. Its Claude/Codex pipelines and matching activation flags must
already be enabled. Both modes configure:

- `${CODEX_HOME:-$HOME/.codex}/config.toml`: a managed `[otel]` table with all
  three native OTLP/HTTP JSON exporters and `log_user_prompt=false`. Plain Codex,
  `icodex` and other wrappers that retain user configuration use the same settings.
- `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`: Claude telemetry environment
  defaults, preserving other settings/env entries. It updates resource attributes only
  when this file already owns them; otherwise identity and project/team attributes
  remain owned by the launching shell. It does not invent a team tag. This covers `claude`, `itrust`,
  `etrust` and equivalent wrappers. The wrappers keep their own routing and auth.
- `~/.otelcol/enable-test-telemetry.sh`: shared identity and Claude shell exporters,
  sourced by the selected shell and existing bash/zsh startup files. Existing
  project/team resource attributes are retained in the launching shell. An existing
  Claude settings-owned attribute string still overrides that shell string: include
  the required tags in that owner or explicitly transfer ownership to the shell.
  See [resource attribute precedence](../reference/data.md). No fixed backend/client label
  is applied globally to mixed gateway traffic.

Files to be modified are validated before either is written. Setup rechecks planned
content and symlinks before writes and each replacement, rejecting noticed edits;
this is not a transaction across both files or a lock shared with other editors.
Changes use atomic
replacement and private backups named `*.ccdash-backup-*`; repeat setup does not
rewrite unchanged settings. Conflicting unmanaged Codex OTel settings or malformed
configuration cause an error instead of a misleading success. Migrate an unmanaged
Codex table explicitly, or use the exact untagged local exporter table generated by the helper. Disabling a client
removes the managed Codex table or disables Claude exporters; manually owned Codex
settings remain manually owned, while the collector activation flag gates ingestion.

Open a new shell and restart existing clients after setup: an already running
Codex process keeps its startup exporter configuration. Explicit command/profile
overrides, ignored user settings, organization-managed settings and alternate
configuration roots may take precedence. Configure each intended root separately.
This is support for Claude Code/Codex entry points, not arbitrary application logs.
Receiver readiness still does not prove end-to-end dashboard coverage.

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

The workshop launcher supplies these process overrides. Its backend headers describe
the selected direct Bedrock deployment; self-service configuration uses the same local
endpoints without fixing a backend globally. Runtime substitutes `bedrock-runtime` in all three headers. Receivers expose request
metadata only to the Codex pipelines. A valid `x-ccdash-backend` overrides resource
backend; an absent/invalid header preserves a valid resource backend. Otherwise backend
stays absent. The temporary header attribute is deleted before export. Model names,
metric/span attributes and inherited client labels never establish backend or producer at
the Collector — unchanged; downstream queries do now ([ADR-017](../decisions/ADR-017-backend-cost-fallback.md)).

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

Claude log scrubbing also clears the body before export. Its supported queries
and deduplication use timestamps and structured resource/log attributes. This
preserves request/tool/usage metadata while preventing unconsumed free-text bodies
from reaching storage. Existing historical rows are not rewritten. Validate the
pinned Collector and restart the host service with its persistent queue retained;
source configuration alone is not evidence of a fleet rollout.

For a standalone receiver with a different pipeline configuration, prepare a private
draft using Python 3 and PyYAML:

```bash
python3 scripts/scrub-collector-log-bodies.py \
  --input "$EXISTING_CONFIG" --output "$NEW_PRIVATE_CONFIG"
```

The helper preserves receivers, authentication, exporters and non-log pipelines.
It inserts a dedicated body transform before the log batch stage, refuses a
conflicting processor definition and never overwrites the running configuration.
Validate the draft with the installed Collector version before any controlled
rollout. Retain the original configuration and wait for exporter queues to drain;
an in-memory queue is not restart persistence.

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
For token gaps, compare `observed_tokens`/`tokens_partial` with canonical `tokens` and
`quality.missing_usage`. Known pairs remain visible even when canonical coverage is
incomplete; this does not recover missing logs or treat absent usage as zero
([ADR-014](../decisions/ADR-014-observed-token-subtotals.md)).
`CODEX_PRICING_JSON` (`codex_pricing_json`) keys must omit `us.`/`eu.`/`apac.`/`jp.`/`au.`/`global.` (lookup strips
them; GovCloud remains unsupported). Entries require positive integer `short_context_limit`, `regional` and optional
`global`, each with `short`/`long` rates: finite nonnegative USD/million `input`,
`cacheWrite`, `cacheRead`, `output`. Invalid entries fail startup; config hides rates.
Before upgrading from the earlier `us.`/`global.`-only normalization, rename any existing
`eu.`/`apac.`/`jp.`/`au.` override keys to the base model id. Such keys previously worked
as routing-specific entries and now fail startup. If base and prefixed keys coexist,
choose the intended rate set explicitly; do not silently collapse different rates.
Rollback restores the prior image and its matching configuration together.
All commercial geography profiles use the one configured `regional` rate set. The
estimate does not resolve a separate rate for each billing region; a regional override
applies to every commercial geography.
An entry may add an optional per-backend `backends` rate override (`PRICING_JSON` too), and
an Anthropic model with no Codex-table entry falls back to the Claude price table
(`price_source: "claude_table"`); an unusable Claude report (`/api/clients/overview` only)
falls back to a token-computed estimate (`cost_basis: "computed_estimate"`/`"mixed"`). See
[ADR-017](../decisions/ADR-017-backend-cost-fallback.md) for the full contract.
Code-table rates sit below an AWS Price List layer (runtime refresh, then the image snapshot);
`CODEX_PRICING_JSON` entries still replace whole models above it. `/api/config`
`pricing.priceList` reports the active layer
([ADR-017 amendment](../decisions/ADR-017-backend-cost-fallback.md#amendment-2026-10-28-aws-price-list-as-a-rate-source)).

With Docker/server dependencies, `bash scripts/test-client-sql.sh` owns a disposable
loopback ClickHouse using the local schema; external DB URLs are ignored.
