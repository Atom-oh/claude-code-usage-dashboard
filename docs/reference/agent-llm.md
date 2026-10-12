# Chat Assistant

Analytics and the floating chat widget call `POST /api/chat`, implemented in
[chat.js](../../dashboard/server/chat.js). The server uses Bedrock `ConverseStreamCommand`
with one `run_sql` tool. It does not ingest client telemetry through this endpoint.
See the [API contract](../api-reference.md) and [SQL security boundary](security.md).

## Model and tool loop

`CHAT_MODEL_ID` defaults to the literal configured in `MODEL_ID`
(`global.anthropic.claude-sonnet-5`). Region precedence is `BEDROCK_REGION`, `AWS_REGION`,
then `us-east-1`. These are source defaults, not proof of model access in a deployed account.
The UI and system prompt currently request Korean answers.

| Control | Actual behavior |
|---|---|
| Input history | Last 30 nonempty user/assistant messages; each content string truncated to 8,000 characters |
| Rate | At most 10 requests per IP in a rolling minute, per server process; excess returns 429 |
| `MAX_HOPS` | Four tool-enabled model rounds; if the fourth still requests tools, one final tool-disabled summary round |
| `MAX_SQL_CALLS` | Eight tool executions per turn, counted independently of rounds; invalid SQL also consumes a slot |
| Model output | `maxTokens: 8000` for each model call |
| Retry | Initial Bedrock throttling failures retried twice with abort-aware 300/600 ms waits |
| SQL output | At most 200 rows, plus a truncation flag; 30-second query abort timer |
| Tool context | At most 20,000 serialized JSON characters per SQL result, preserving row boundaries and `truncated` |
| Turn deadline | 180 seconds for model/tool work; expiry aborts the shared signal and returns a timeout error |

The active handler passes SQL results through `capToolResultJson`, after applying the
configured masking policy. Oversized results lose whole rows and set `truncated`; one
oversized row can produce an empty truncated result, which is not an empty query result.
The size limit controls model context, not query-response allocation or token/invoice size.
Database-side result limits still apply.

Disconnect and the turn deadline propagate the same abort signal to Bedrock, retry waits
and `queryReadonly`. Aborted SQL is not converted into tool feedback or followed by another
model round. Timers/listeners are removed at completion; a deadline reports timeout rather
than `done`, including clean provider completion after abort. A timeout is logged using
only model/hop/deadline metadata. The timeout response follows settlement of the
abort-aware operation; this is not a hard process kill or a guarantee of zero billed work.
SQL HTTP cancellation releases the application request; server-side query termination
depends on deployed ClickHouse settings, which the readonly session cannot override.

The UI consumes SSE in [FloatingChat.jsx](../../dashboard/web/src/components/FloatingChat.jsx)
and [Analytics.jsx](../../dashboard/web/src/pages/Analytics.jsx); trace display is handled by
[ChatTrace.jsx](../../dashboard/web/src/components/ChatTrace.jsx). Status events carry query
progress and masked SQL; thinking events carry summarized reasoning, text events carry
answer deltas, and done/error events terminate the turn. The server keeps Bedrock reasoning
blocks and signatures across tool rounds within one request, without exposing signatures.
Follow-up requests send text-only conversation history.

## Prompt maintenance and data meaning

`SCHEMA_CONTEXT` manually lists table/column domains and counter rules.
`SYSTEM` interpolates `GROUP_CTE` from [grouping.js](../../dashboard/server/grouping.js),
`PRICING_PROMPT_TABLE` from [pricing.js](../../dashboard/server/pricing.js), and `normModel`
from [queries.js](../../dashboard/server/queries.js). The interpolated fragments track code;
the hardcoded schema prose does not.

The prompt keeps Anthropic Claude reported spend primary and computed token-price costs
diagnostic; it describes the counter raw/rollup branch and rejects unconditional parity.
Non-Anthropic Claude spend needs [ADR-017](../decisions/ADR-017-backend-cost-fallback.md)'s
log-derived AWS rescaling, which SQL chat does not automatically apply. Raw reports must
be labelled unadjusted, not dashboard spend. Missing rates/logs remain unavailable.
The prompt describes Claude analysis and omits automatic Codex deduplication/token/pricing
adapters; it is not a table allowlist. SQL authorization remains the `claude_code` database
with existing sanitizer/readonly gates. `otel_logs`/`otel_traces` are shared with Codex:
the prompt requires client/event/span predicates before attributing shared rows to Claude.
Claude `SpanType` values are unprefixed; `claude_code.` belongs to `SpanName`. Interaction
duration uses the span's nanoseconds rather than a potentially absent `duration_ms` attribute.
Codex diagnostic metrics live in separate `codex_metrics_*` tables and never augment
completion-log usage/cost. Empty client tags are not validated client identities.
Model names do not supply Codex usage. The prompt
also distinguishes unknown/partial observation from zero and rejects productivity/causal
ROI claims. Use [spend definitions](../metrics.md) and [aggregation rules](data.md);
prompt wording and offline checks do not guarantee generated-SQL or answer correctness.

The prompt includes cautions about `internal_error` availability and version-dependent MCP
attribution. Treat these as collection-coverage cautions to check against the selected
client versions, not as live fleet assertions. Unsupported trace results, missing identity,
channel heuristics and historical rollup limits also apply to assistant analysis.

`classifyChatError` distinguishes throttling, access denial, validation/input errors and
other failures, returning a user-facing message and an AWS request ID when available.
Chat logs retain diagnostic fields with email masking. SQL errors become tool feedback;
top-level failures become SSE errors. See [chat troubleshooting](../runbooks/ask-claude-chat-troubleshooting.md).
