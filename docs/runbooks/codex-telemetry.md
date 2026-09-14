# Selectable Claude Code and Codex telemetry

This runbook describes source configuration and operator actions. Changing this
repository does not deploy the dashboard, update EC2 user-data, restart existing
clients, change IAM, or change billing. EC2 collector/bootstrap has a separate
lifecycle from `infra/`.

## Collection release scope

This change supplies collection, bootstrap and the launcher. Client-aware API and
SPA changes follow separately. Keep dashboard Terraform flags at their defaults
until that application release is installed; this commit does not add Codex views
to an older dashboard image. Collector flags can already control stored feeds.

## Select clients consistently

Prefer literal lowercase `true` or `false`:

| Installation | `CLAUDE_ENABLED` | `CODEX_ENABLED` |
| --- | --- | --- |
| Existing default | `true` | `false` |
| Codex only | `false` | `true` |
| Both | `true` | `true` |

Environment flags also accept case-insensitive `true/false` and `1/0`. Empty/unset flags use the defaults above. Bootstrap writes canonical
lowercase values. Both false is invalid. `CODEX_BEDROCK_ENDPOINT` is `mantle` by default and accepts
only `mantle` or `runtime`. These flags select emitting clients independently of
Claude's `EXPERIMENT_GROUP` and dashboard `GROUP_MODE`.

Set the corresponding Terraform inputs `claude_enabled`, `codex_enabled`, and
`codex_bedrock_endpoint`. They populate the dashboard container environment.
Terraform validates the flags but does not propagate them to workshop instances.
The client-aware application release must consume these values before dashboard
activation changes are made.

For each EC2 instance, propagate the same three settings into both:

- `/etc/otelcol/env`: collector process environment; retain its existing
  ClickHouse settings, restrictive file permissions and secret loading.
- `/etc/ccdash/clients.env`: nonsecret launcher defaults, read as `KEY=value`
  data, never evaluated as shell commands.

The bootstrap writes both files. For existing instances, use the existing fleet
configuration mechanism to distribute matching files and the new collector
configuration, then restart `otelcol.service`. Merely changing launch-template
user-data does not update an existing instance. Restart Codex using the launcher
after a setting change; an already running client retains its old settings.
Collector filters immediately reject the disabled client's new records once its
process restarts. Existing ClickHouse rows remain. Persistent exporter batches
accepted before disabling a client can still drain; a flag change does not erase
the durable queue.

The service runs `ccdash-codex --check` and the Collector's config validator before
starting. The first check validates client flags, model and region without making
an AWS or model call. The raw Collector validator checks OTTL/config syntax; it
does not enforce the cross-variable activation rule. Raw Collector execution with
both flags false drops both feeds; use the service preflight to reject that
configuration.

## Bootstrap artifacts

Stage these files from the same approved release under
`/opt/ccdash-bootstrap` before executing `user-data.sh`:

```text
/opt/ccdash-bootstrap/
  collector-config.yaml
  scripts/codex-launch.py
```

`BOOTSTRAP_ASSET_DIR` can select another artifact directory. Stage the new helper
even for Claude-only installs: the Collector service uses its offline validation.
The bootstrap installs it as `/usr/local/bin/ccdash-codex`, installs Python 3, and
retains the existing Claude version/install behavior when Claude is enabled.
It independently installs `@openai/codex@0.154.0` when Codex is enabled and fails on
installation/version mismatch. `CODEX_VERSION` permits another explicit release,
but that version requires fresh telemetry qualification.

The bootstrap uses `TMPDIR`, falling back to `/var/tmp`, and cleans its own
download directory. It retains ClickHouse SSM retrieval with xtrace disabled and
the root-only collector environment file. No credentials belong in the artifact
directory or launcher defaults. Review the configured ClickHouse destination,
SSM parameter and AWS region through the existing deployment process.

## Choose the Bedrock endpoint

Defaults verified against the
[AWS GPT-6 Astra model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html):

| Setting | Mantle | Runtime |
| --- | --- | --- |
| `CODEX_BEDROCK_ENDPOINT` | `mantle` | `runtime` |
| `CODEX_BEDROCK_REGION` default | `us-west-2` | `us-west-2` |
| `CODEX_MODEL` default | `openai.gpt-6-astra` | `us.openai.gpt-6-astra` |
| Provider | Built-in `amazon-bedrock` | Custom `ccdash-bedrock-runtime` Responses provider |
| Base URL | `https://bedrock-mantle.us-west-2.api.aws/openai/v1` | `https://bedrock-runtime.<region>.amazonaws.com/openai/v1` |
| Authentication | Native AWS credential chain/profile or Bedrock key supported by the provider | Externally supplied `AWS_BEARER_TOKEN_BEDROCK` |

The launcher uses CLI `-c` overrides, so provider/OTel settings do not depend on
project-local configuration. The native provider accepts only its nested AWS
profile/region overrides; its URL is owned by Codex. See the
[official Codex configuration guide](https://developers.openai.com/codex/config-advanced).

Runtime requires a Bedrock bearer token. Supplying IAM role credentials alone to
this custom provider is insufficient. Obtain/refresh that token using your
approved credential process and inject it into the launch environment. The
launcher never writes a token into config or command arguments. No dynamic token
helper is configured or claimed to be verified here.

`CODEX_MODEL` is optional: omit it to derive the endpoint's default. When switching
an existing installation, remove the old explicit model or replace it in
`/etc/ccdash/clients.env` together with the endpoint. Runtime accepts `us.openai.*`
or `global.openai.*` profile IDs; a `us.` profile requires a US source region.
`global.openai.gpt-6-astra` enables global inference scope explicitly. The region
allowlist follows the documented Runtime source regions for this integration.
Mantle is restricted to `us-west-2`. Validation is local syntax/compatibility
validation, not proof of model access, quotas, regional availability, IAM
authorization or a configured price for an overridden model.

Existing dashboard IAM is unchanged. Account/model access and any necessary
client-side permissions remain operator responsibilities.

Runtime overrides inherited search settings with `web_search="disabled"` and
rejects `--search` and `web_search` CLI config overrides. The bounded Runtime
tests below confirmed that declaring a search tool does not establish search
execution support. Mantle retains its existing search selection.

## Launch and resource metadata

After the operator has propagated the settings, inspect the nonsecret effective
configuration without invoking a model:

```bash
ccdash-codex --check
codex --version
```

Launch an enabled Codex session with `ccdash-codex`, passing the usual Codex
arguments. From a source checkout, use `python3 scripts/codex-launch.py`.
`CCDASH_CLIENT_ENV` selects an alternate defaults file; process environment
settings take precedence over that file.

The launcher merges `CODEX_OTEL_RESOURCE_ATTRIBUTES` defaults with any valid
existing `OTEL_RESOURCE_ATTRIBUTES`. Existing user/team/project/custom values
win; `backend` is always overridden to `bedrock-mantle` or `bedrock-runtime` for
the Codex child process, and inherited `experiment.group` is removed. For example:

```bash
OTEL_RESOURCE_ATTRIBUTES='user.email=participant@example.invalid,team=workshop,project.name=sample' ccdash-codex
```

Values can contain spaces and additional equals signs. Percent-encoded values
are retained as supplied; use OTel-compatible encoding for literal commas.
Malformed entries fail without echoing their contents. The bootstrap supplies
the instance identity as a Codex default when available; existing process-level
identity takes precedence.

Do not put a Codex `backend` into `/etc/profile`, a global shell export, or
Claude's managed settings. Metadata applies to the Codex child process, including
its normal descendants, and does not alter the calling shell or a separately
launched Claude process. The launcher rejects CLI overrides that would change
the selected provider/model/profile or managed OTel settings; use the documented
environment settings to change those choices.

## Collection contract

The Collector listens only on `127.0.0.1:4317` (OTLP/gRPC, existing Claude path)
and `127.0.0.1:4318` (OTLP/HTTP, Codex logs). Keep the existing ClickHouse TLS
export, least-privilege ingest credential, durable queue and retry settings.
No receiver is exposed to the network.

Codex launches with:

```toml
[otel]
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }
metrics_exporter = "none"
trace_exporter = "none"
log_user_prompt = false
```

Structured logs in the existing `otel_logs` table are the authoritative Codex usage
feed; no new schema or migration is added. The schema has no native histogram tables,
and enabling a second usage feed could double count.
Claude's eight allowed metrics, cumulative counter handling, log scrub and
experiment grouping remain in their own pipelines. Trace acceptance is restricted
to enabled Claude's `service.name=claude-code`; Codex traces are not ingested.

The Codex pipeline recognizes `event.name` beginning with `codex.`, sets the log
attribute `client=codex`, removes inherited `experiment.group` from both log and
resource attributes, and retains explicit backend/user/team/project metadata.
Claude retains its established unprefixed events (`api_request`, `tool_result`,
etc.), `claude_code.*` aliases and events carrying its `service.name=claude-code`.
Codex events are excluded from that pipeline even with an inherited Claude service.
Models and inherited client labels do not identify an emitting client. Unrecognized
events without Claude service provenance are dropped. In a mixed OTLP batch, Codex transforms do not
remove Claude's resource group.

Codex 0.154.0's zero `timeUnixNano` is replaced by `observedTimeUnixNano` before
ClickHouse export into `otel_logs.Timestamp`, for time-based queries.
Nonzero source timestamps, `event.timestamp` and event identity
attributes are retained for deduplication. `conversation.id` remains a **log**
attribute. The Collector clears Codex bodies and strips prompt, argument and tool
output fields, while preserving token counts, call IDs, tool names, durations,
status and other metadata.

`codex.sse_event` with `event.kind=response.completed` can occur first without
tokens and then with usage. Consumers must also handle usage-bearing `codex.websocket_event` completions,
deduplicate identical timestamps and sorted resource/log attribute maps before
grouping or pricing, and use only usage-bearing records as cost inputs.
`input_token_count` and `output_token_count` can be strings; cached, cache-write
and reasoning counts can be integers. Cache buckets are subsets of input;
reasoning is a subset of output. The Collector preserves these types/values for
the dashboard parser. It does not turn a generic completion into zero usage.

Recorded `response.failed` stream events indicate API errors, including after an
HTTP 200 response. A local fatal-response fixture showed that the CLI may exit
without flushing OTel. Missing failure/usage logs are therefore not measured zero,
and the Collector's durable queue cannot recover records it never received.

## Local checks and rollout evidence

From the repository root:

```bash
export TMPDIR="${TMPDIR:-/var/tmp}"
bash tests/run-all.sh client-collection
RUN_COLLECTOR_TESTS=1 bash tests/run-all.sh client-collection
terraform fmt -check -recursive infra/
```

The first command exercises launcher configuration and bootstrap writes with
package, AWS and service operations replaced at the test boundary. It also checks
Terraform variable validation when Terraform is installed. The Collector test
requires Docker, PyYAML and `otel/opentelemetry-collector-contrib:0.119.0`. It
validates the actual production config, then substitutes a local file exporter
for ClickHouse and replays synthetic logs/metrics/traces in disposable containers
on an internal Docker network. It publishes no host port and removes only the
containers/network it created.

This verifies activation modes, privacy filtering, timestamp promotion, metadata
preservation and Claude counter compatibility. These local checks do not verify
AWS authentication, production ClickHouse insertion or rollout. The dated raw API
checks below provide separate endpoint evidence. Before rollout, qualify a bounded
live CLI/streaming/tool/usage path, review pricing support, and confirm accepted
telemetry and authenticated dashboard results. A config check alone is not
deployment evidence.

## Bounded compatibility evidence: 2026-09-14

The operator record `2026-09-14-bedrock-live-compatibility.md` in the validation
workspace reports seven raw API requests within an eight-request cap in
`us-west-2`. Each used existing SigV4 authentication with signing service
`bedrock`, `max_output_tokens=256`, low reasoning, streaming and `store=false`.

| Endpoint/model | Bounded raw API result |
| --- | --- |
| Mantle / `openai.gpt-6-astra` | Streaming function request and function-result round trip passed |
| Runtime / `us.openai.gpt-6-astra` | Streaming function request and function-result round trip passed |

All four baseline requests ended in `response.completed`. The local caller
validated synthetic function arguments and returned a fixed result; this was not
a Codex CLI tool execution. Cache-write/read and reasoning usage fields were
present with zero values; nonzero cache behavior was not exercised.

Three additional Runtime probes separated tool declaration from execution:
declaration with `tool_choice=none` completed, forced `web_search` returned HTTP
400, and automatic search returned HTTP 200 followed by `response.failed`
(`invalid_prompt`). Inspect the terminal SSE event, not HTTP status alone.
The Runtime launcher now disables hosted search. A local CLI fixture with an
inherited live-search setting confirmed that the outgoing request omitted that
tool after the fix.

No live native CLI-to-AWS call was run: an enforceable output-token CLI knob was
not established, and local request captures contained no `max_output_tokens`.
Raw SigV4 success also does not verify the Runtime launcher's externally supplied
bearer authentication path. Local CLI/OTLP fixtures verified token export,
including `cache_write_tokens` to `cache_write_token_count`; combining those
fixtures with raw AWS success is not a live CLI-to-Collector-to-ClickHouse test.
No billing reconciliation was performed, and these estimates cannot establish
invoice completeness.

## Dashboard cost and query contract

The client-aware API and UI are separate follow-up changes. This collection
release stores usage records; it does not provide Codex cost panels or invoice
reconciliation. Keep application activation defaults until those changes ship.
