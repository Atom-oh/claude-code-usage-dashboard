# Security Boundaries

The dashboard is a shared authenticated telemetry view, not a multi-tenant authorization
system. Read [server/AGENTS.md](../../dashboard/server/AGENTS.md) and
[ADR-004](../decisions/ADR-004-basic-auth-baseline-and-sso-upgrade-path.md) for the current
boundary and upgrade direction.

## Authentication and credentials

[index.js](../../dashboard/server/index.js) requires both `BASIC_AUTH_USER` and
`BASIC_AUTH_PASSWORD`, refusing startup otherwise unless `AUTH_ALLOW_INSECURE=1` explicitly
allows local unauthenticated use. Only `/healthz` and `/readyz` bypass the global gate.
`/api/health/data`, `/api/config`, chat, data routes and static files inherit it.

`POST /api/chat` additionally requires configured auth or `CHAT_ALLOW_INSECURE=1`, and a
successful readonly-session probe. The two insecure flags are independent. `trust proxy=1`
matches the intended CloudFront-to-NLB path and supplies `req.ip` to chat's per-process
10-requests-per-minute limiter. Other data routes have no application rate limiter.

[infra/dashboard.tf](../../infra/dashboard.tf) supplies credentials through Kubernetes
Secrets and uses IRSA for Bedrock. [infra/clickhouse.tf](../../infra/clickhouse.tf) separates
reader, ingest and writer credentials. The reader profile is readonly and grants SELECT on
`claude_code.*`; its configured execution, memory, result-byte and scanned-row limits are
server-side protections. Source definitions require deployment verification.
Untracked tfvars and local Terraform state can contain secrets; gitignore is not encryption.

## Chat SQL execution

[sanitizeSql](../../dashboard/server/chat.js) accepts a single SELECT/WITH statement and
rejects comments, double quotes/backticks, forbidden statement keywords, table functions,
unbalanced parentheses and explicitly qualified tables outside `claude_code`.
It is a conservative string/token guard, not a general SQL authorization engine.

[queryReadonly](../../dashboard/server/clickhouse.js) wraps results in an outer `LIMIT 201`,
returns at most 200 rows with `truncated`, and applies a 30-second abort timer. It relies
on the account's readonly profile; it does **not** set `readonly=1` per request.
`assertReadonlySession` probes the actual session at startup and every ten minutes; false
or undetermined results disable chat with HTTP 503. See [chat](agent-llm.md) for limits and
current gaps in character capping and disconnect cancellation.

## Data visibility and masking

Ordinary data APIs return raw identities. `PII_MASK_ENABLED` controls presentation masking,
not access to those payloads. The server defaults to masking off; the Terraform input
`pii_mask_enabled` defaults true. The SPA defaults to masking on unless `/api/config`
explicitly disables it. [ADR-006](../decisions/ADR-006-client-side-pii-masking-baseline.md)
records this shared-screen policy.

[fmt.js](../../dashboard/web/src/fmt.js) masks labels; [csv.js](../../dashboard/web/src/csv.js)
applies the same policy centrally to exported `user` cells. Masked labels can collide and
are not unique user IDs.

Chat's `maskEmailValues` recursively masks result values and keys when masking is enabled.
An email-derived object key becomes a masked label with a `values` array so collisions do
not discard users. Aggregate by original identity in SQL before masking; never regroup
results by masked label.

SQL status events, SQL error echoes and chat exception logs use `maskEmailText` regardless
of the display setting. Thinking summaries are masked per delta, so an email split across
deltas can escape that regex. `SessionId` is not redacted. Generated answer text is streamed
as received; this is not comprehensive response redaction. Normal data-route exception
logging is separate and does not apply chat's masking helper.

The collector removes two prompt keys from logs; that is not an all-fields PII guarantee.
Raw metrics, gauges and rollups have a configured 180-day deletion TTL; logs/traces have
90 days. Rollup TTL is delete-only. Cold moves do not satisfy deletion, and CREATE statements
do not prove a live TTL is applied. See [data retention](data.md)
and [schema migrations](../runbooks/schema-migrations.md).
