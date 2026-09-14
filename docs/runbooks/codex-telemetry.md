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
the service's launcher preflight rejects that combination before startup.

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

The candidate is validated with the loaded environment before same-directory atomic
file replacement. After restart, five one-second active-state checks detect startup
failure. A failed bootstrap restores the snapshot and starts the prior Collector if
it was running; an unsuccessful rollback retains its private snapshot and reports
the recovery directory for the operator.
This is bounded startup recovery, not ongoing availability monitoring or rollback of
package-manager/client-install side effects. The durable exporter queue is preserved.

The service also runs `ccdash-codex --check` and the Collector validator before each
start. The launcher check is offline. Failed validation leaves a diagnostic only in
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
removes `experiment.group` and fixes `backend=bedrock-mantle|bedrock-runtime` only for
the child process. Claude's global/managed resource attributes are not rewritten.
Do not put credentials or prompt content in metadata.

Provider/model/profile/OTel overrides are managed by the launcher; use deployment
variables instead. User permissions, approvals and ordinary Codex arguments retain
their existing behavior. Defaults are read from `/etc/ccdash/clients.env` unless
`CCDASH_CLIENT_ENV` selects another file; its contents are never shell-evaluated.

## Collection contract

Receivers bind only to loopback: Claude OTLP/gRPC on `127.0.0.1:4317`, Codex OTLP/HTTP
JSON on `127.0.0.1:4318/v1/logs`. Existing ClickHouse TLS, ingest credentials, durable
queue and retry settings remain. No schema/migration or histogram tables are added.

```toml
[otel]
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }
metrics_exporter = "none"
trace_exporter = "none"
log_user_prompt = false
```

Structured logs are the single Codex usage feed. Claude retains its eight allowed
metrics, counter temporality, log scrub and experiment grouping. Claude logs accept
established unprefixed names (`api_request`, `tool_result`, etc.), `claude_code.*`
aliases, or Claude service provenance. `codex.*` is always excluded from that pipeline,
even with an inherited Claude service. Unknown events without Claude provenance are
dropped. Traces require enabled Claude and `service.name=claude-code`.

The separate Codex pipeline tags `client=codex`, strips inherited experiment groups,
clears bodies and removes known prompt/argument/output fields while retaining usage,
call IDs, tool names, status, timing and explicit identity/backend/project metadata.
Model names and inherited client labels do not establish producer identity.

Codex 0.154.0 emits zero `timeUnixNano`; the Collector promotes `observedTimeUnixNano`
into `otel_logs.Timestamp` while preserving nonzero source timestamps and
`event.timestamp`. `conversation.id` remains a log attribute. A generic
`response.completed` event can precede a usage-bearing completion. Consumers must
deduplicate timestamps plus sorted resource/log maps and price only usage-bearing
SSE/WebSocket completions. Input contains cache reads/writes; output contains
reasoning. Missing/partial usage is not measured zero. HTTP 200 with `response.failed`
is an error, and a fatal CLI exit may omit unflushed logs entirely.

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
and removes only its own containers/network. Fixtures cover activation, privacy,
timestamp promotion, metadata and Claude counter compatibility.

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

The common UI consumes authenticated `/api/clients/overview` results with cost basis
`client_reported` for Claude and `aws_list_estimate` for Codex. Unknown prices or
invalid/missing token buckets make cost unavailable rather than zero. All returned
folds use the same selected rows; reasoning is already part of output tokens.
Codex project breakdowns use the emitted `project.name`, not an AWS billing project.

`totals.users` unions distinct emitted user ID strings across clients; it is not
a verified employee directory or a sum of per-client counts. Ranges through four
hours use minute buckets; longer ranges use hourly buckets. When Claude is selected,
both sources use its resolved end, returned in `effective_range` alongside
`requested_to`. Long historical mixed ranges therefore align Codex to Claude;
Codex-only queries retain the requested end. `bucket_hours` reports `1/60` or `1`.
Shared boundaries retain Claude's historical and live-hour approximations.

The built-in GPT-6 Astra prices are taken from the model card linked above. Price
selection retains regional/Global inference scope and the request's short/long
context tier before summing. `CODEX_PRICING_JSON` (Terraform `codex_pricing_json`)
can override or add model entries. Every entry requires a positive integer
`short_context_limit` and a `regional` object with `short` and `long` rate objects.
An optional `global` object has the same shape. Each rate object contains finite,
nonnegative USD-per-million `input`, `cacheWrite`, `cacheRead` and `output` values.
No configured price is exposed by `/api/config`. Invalid configuration fails startup.

The rate calculation is an estimate from emitted usage, not a guarantee of complete
telemetry, contractual discounts or invoice equality. This feature does not fetch
Cost Explorer/CUR or change AWS billing settings. Codex follows the existing 90-day
log retention. Claude retains its counter lookback and historical-boundary rules.

Run the real SQL check from a machine with Docker and installed server dependencies:

```bash
bash scripts/test-client-sql.sh
```

The script owns a new loopback-only ClickHouse container, applies the checked-in
local schema, verifies deduplication, counter boundaries, price tiers and filters,
and removes that container on exit. It does not accept a production database URL.

`observed_records` is an empty-result signal: deduplicated log-event counts plus
Claude usage aggregate-row counts. `quality.missing_usage` counts active Codex
session/user/model/backend/project combinations with no usage-bearing records.
Affected token/cost folds are null and contribute to `unpriced`; explicitly
reported zero remains zero. Availability spans the selected range, so a normal
request/completion bucket crossing does not become a false gap. This cannot detect
every dropped response in a combination that already has usage.
