# Runbook: Ask Claude Chat Troubleshooting

## Triage and evidence

Use this for `POST /api/chat` failures or answers that disagree with verified dashboard
queries. The UI remains Korean; this runbook refers to HTTP status, API fields, and error
classes in English. Use `kube` from [incident response](incident-response.md)
and capture logs before a pod is replaced:

```bash
kube logs -l app=dashboard --tail=200 --prefix | grep -A12 '/api/chat'
```

The server logs `{hop, modelId, name, status, requestId, message, stack}`. Correlate the
provider `requestId` with the user's error where present; the browser gets a classified
message, not the complete exception. Preserve only the required redacted excerpt. Streaming
errors can arrive as SSE `error` events after HTTP 200, so status alone does not prove success.

## 1. Chat returns 503

Chat has independent authentication and ClickHouse-readonly gates in
`dashboard/server/index.js`. Basic Auth must be configured; `AUTH_ALLOW_INSECURE` and
`CHAT_ALLOW_INSECURE` are separate local-development exceptions, not production recovery
switches. Docker Compose intentionally does not satisfy the chat gates by default.

The server probes `getSetting('readonly')` at boot and every ten minutes. Inspect:

```bash
kube logs -l app=dashboard --tail=100 --prefix | grep 'chat disabled:'
```

`probe=false` means the measured session is writable; `probe=null` means the probe failed.
Both disable chat. Check the actual `CH_USER`, Secret reference, connectivity, and effective
readonly profile. Use `otel_reader`/`clickhouse-reader`; resolve a transport or privilege
failure instead of assuming a different username alone fixes it. A brief startup interval
before the first successful probe also returns 503. Do not add client session settings to
force readonly: the deployed readonly profile can reject setting changes.

## 2. Provider access or throttling

For `AccessDeniedException`, inspect the deployed `CHAT_MODEL_ID`, effective
`BEDROCK_REGION` (falling back to `AWS_REGION`, then `us-east-1`), account/model availability,
and the dashboard ServiceAccount's IRSA policy. `infra/dashboard.tf` derives model/profile
ARNs and the env value from `chat_model_id`, but verify the running pod and applied policy.
The Workshop Studio region exception is documented in
[Workshop Studio notes](../workshop-studio-notes.md).
Do not switch model IDs based only on a familiar name from a different provider catalog.

`sendConverseWithRetry()` retries `ThrottlingException` at most twice before a stream starts.
It does not retry a partly delivered stream. Diagnose provider quota/rate state and request
load before retrying; no routine model call is required just to inspect configuration.

A dashboard-originated 429 is a different limiter: `chat.js` allows ten requests per IP in
60 seconds per process. Shared NAT/VPN traffic can exhaust it. Confirm origin and legitimate
traffic before changing the limit; do not label every 429 a Bedrock quota failure.

## 3. Long conversations or validation errors

The browser retains conversation history and resends it. The server selects the latest 30
user/assistant messages and limits each content string to 8,000 characters. Within a turn,
there are up to four tool-enabled model hops, eight SQL executions total, and a final
no-tools wrap-up call if the hop budget is exhausted. `maxTokens: 8000` caps output, not
input. `hop` resets every request; a value of 4 identifies the wrap-up failure, not history
length.

`capToolResultJson()` is defined in `chat.js`, but the current handler appends tool-result
JSON directly instead of calling it. Do **not** assume its 20,000-character cap limits the
live request. The SQL row limit still applies, but wide cells and repeated results can grow
context. Inspect the actual `ValidationException` details and request size; the generic
classified message does not prove conversation length was the only cause.

Reload the page to clear a problematic conversation. Closing the floating chat stops the
stream but retains messages. A prospective context-cap fix requires code/test work; this
runbook does not declare it implemented.

## 4. Incorrect schema, group, or cost answers

Compare the assistant's SQL with `dashboard/server/chat.js` (`SYSTEM`/`SCHEMA_CONTEXT`),
`queries.js`, and `grouping.js`. The system prompt already describes the hourly rollup and
session grouping. Verify with the dashboard's query before deciding the prompt or schema
is missing. Grouping is inferred per `SessionId`: any nonempty model not starting with
`claude-` gives Bedrock evidence, then `has_org` gives Enterprise, otherwise unknown.
It does not identify the emitting client or enforce a static experiment group.

Cost-page spend and ordinary chat cost answers use client-reported `cost.usage`. Align the
window, filters, unknown-session inclusion, and report coverage before comparing them.
Positive reports can still be incomplete; absent/zero reports with tokens are not confirmed
free use. Token-price computed cost and cache-write TTL assumptions remain diagnostics.
The current `SCHEMA_CONTEXT` still contains a legacy instruction describing the Cost card
as computed cost; treat that as prompt drift, not the current UI contract. The generated
pricing table remains useful for explicitly requested computed-cost diagnostics.

Check `schema.projectColumns` before expecting project/entrypoint fields and use
[schema migrations](schema-migrations.md) to inspect actual tables. Do not reconstruct
missing data from a model's plausible answer or infer applied 003/005 from source code.

## Verification and recovery

Resolve configuration/data causes first and preserve the readonly/auth gates. For a bad
application revision, use [deployment rollback](deploy-production.md). Offline
chat/SQL tests validate code paths without establishing live Bedrock access. If live chat
verification is authorized, use one small aggregate question and inspect SQL/results with
the same cost basis and range; do not include personal data or credential values in prompts.

Chat grants every authenticated administrator the permitted `claude_code` read surface.
Email masking reduces display/model exposure but does not enforce per-user authorization
or remove all identifiers. Sharing participant chat access requires reviewing that trust
model, not just enabling a UI flag.
