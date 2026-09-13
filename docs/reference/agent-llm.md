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
| Retry | Initial Bedrock throttling failures retried twice with 300/600 ms waits |
| SQL output | At most 200 rows, plus a truncation flag; 30-second query abort timer |

`capToolResultJson` defines a 20,000-character cap but is not called by `handleChat`.
The active tool-result path passes rows directly, optionally masked. Do not claim a
character cap on tool context. Likewise, `queryReadonly` accepts an external abort signal,
but this handler does not pass it: disconnect cancellation reaches Bedrock, while SQL is
bounded by its own timeout. These are implementation limits, not completed fixes.

The UI consumes SSE in [FloatingChat.jsx](../../dashboard/web/src/components/FloatingChat.jsx)
and [Analytics.jsx](../../dashboard/web/src/pages/Analytics.jsx); trace display is handled by
[ChatTrace.jsx](../../dashboard/web/src/components/ChatTrace.jsx). Status events carry query
progress and masked SQL; thinking events carry summarized reasoning, text events carry
answer deltas, and done/error events terminate the turn. The server keeps Bedrock reasoning
blocks and signatures in subsequent conversation turns, but does not expose signatures.

## Prompt maintenance and data meaning

`SCHEMA_CONTEXT` manually lists table/column domains and counter rules.
`SYSTEM` interpolates `GROUP_CTE` from [grouping.js](../../dashboard/server/grouping.js),
`PRICING_PROMPT_TABLE` from [pricing.js](../../dashboard/server/pricing.js), and `normModel`
from [queries.js](../../dashboard/server/queries.js). The interpolated fragments track code;
the hardcoded schema prose does not.

The current prompt still says dashboard costs are computed and all dashboard queries use
rollups. Those statements lag the actual spend adapter and raw-query paths. It defaults a
general cost answer to client-reported `cost.usage`, but its dashboard-comparison guidance
can disagree with the UI. Use [spend definitions](../metrics.md)
and [aggregation rules](data.md) as the documented contract; this documentation change does
not modify the prompt or guarantee assistant parity.

The prompt includes cautions about `internal_error` availability and version-dependent MCP
attribution. Treat these as collection-coverage cautions to check against the selected
client versions, not as live fleet assertions. Unsupported trace results, missing identity,
channel heuristics and historical rollup limits also apply to assistant analysis.

`classifyChatError` distinguishes throttling, access denial, validation/input errors and
other failures, returning a user-facing message and an AWS request ID when available.
Chat logs retain diagnostic fields with email masking. SQL errors become tool feedback;
top-level failures become SSE errors. See [chat troubleshooting](../runbooks/ask-claude-chat-troubleshooting.md).
