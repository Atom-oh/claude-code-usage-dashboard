# Security Boundaries

The dashboard is a shared authenticated telemetry view, not a multi-tenant authorization
system. Each dedicated customer installation has one shared dataset; roles do not filter
employee rows. Read [server/AGENTS.md](../../dashboard/server/AGENTS.md),
[ADR-004](../decisions/ADR-004-basic-auth-baseline-and-sso-upgrade-path.md) and
[ADR-019](../decisions/ADR-019-dedicated-installation-identity.md).

## Authentication and credentials

[auth.js](../../dashboard/server/auth.js) defaults `AUTH_MODE` to `basic`, requiring `BASIC_AUTH_USER` and
`BASIC_AUTH_PASSWORD`, refusing startup otherwise unless `AUTH_ALLOW_INSECURE=1` explicitly
allows local unauthenticated use. In Basic mode only `/healthz` and `/readyz` bypass the gate.
`/api/health/data`, `/api/config`, chat, data routes and static files inherit it.

Explicit `AUTH_MODE=oidc` uses authorization code/PKCE, state/nonce, signed ID tokens,
configured issuer/audience and group-based roles. Invalid OIDC configuration refuses
startup even when Basic/development credentials are present. Login/callback/local logout
are protocol exceptions; telemetry/config/static routes remain protected.
Principal cookies are encrypted, host-only, Secure/HttpOnly and default to 15 minutes.
Optional [refresh sessions](../decisions/ADR-021-refresh-token-sessions.md) retain an
encrypted refresh credential for an absolute maximum of 30 days and recheck signed
identity/group claims at renewal. Unsafe requests require the exact configured Origin.
Logout clears cookies and revokes retained refresh credentials; copied short principal
cookies and hosted IdP SSO remain separate. See [SSO operations](../runbooks/organization-sso.md).
Startup validation checks syntax/required inputs; discovery happens at login.
The application uses `strict-origin` referrers and `no-store` for authenticated static
bundles as well as JSON, trading repeat-download caching for a uniform auth-response policy.

`POST /api/chat` additionally requires configured auth or `CHAT_ALLOW_INSECURE=1`, and a
successful readonly-session probe. The two insecure flags are independent. `trust proxy=1`
matches the intended CloudFront-to-NLB path and supplies `req.ip` to chat's per-process
10-requests-per-minute limiter. OIDC additionally requires `chat:query`; viewers cannot
enter the model/query handler. OIDC login/callback have bounded per-process admission
control. Other data routes have no application rate limiter.

[infra/dashboard.tf](../../infra/dashboard.tf) supplies credentials through Kubernetes
Secrets and uses IRSA for Bedrock and the read-only AWS Price List (`pricing:GetProducts`). [infra/clickhouse.tf](../../infra/clickhouse.tf) separates
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
the active tool-context cap and disconnect/deadline cancellation limits.

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
