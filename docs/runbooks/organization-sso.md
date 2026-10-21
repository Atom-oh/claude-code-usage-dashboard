# Organization SSO

This configures identity for a dedicated customer installation. Read
[ADR-019](../decisions/ADR-019-dedicated-installation-identity.md) for the trust boundary
and [ADR-021](../decisions/ADR-021-refresh-token-sessions.md) for optional persistent
sessions. OIDC does not isolate individual employees' rows.

## Prerequisites

Use an HTTPS dashboard origin and a confidential OIDC client supporting authorization
code, PKCE S256, signed ID tokens, discovery and JWKS. The client uses
`client_secret_post` for short sessions and `client_secret_basic` when persistent
sessions are enabled (including Cognito's revocation endpoint). Register the exact callback:

```text
https://dashboard.example.com/auth/callback
```

Configure invitation/admin-managed access and MFA in the customer's IdP. Configure groups
in signed ID-token claims; no app-created accounts are available. Cognito's top-level group
claim is `cognito:groups`; for other providers verify emitted claims/group identifiers
rather than assuming display names.

## Runtime configuration

Supply configuration and secret references to the container:

| Variable | Value |
|---|---|
| `AUTH_MODE` | `oidc` |
| `APP_PUBLIC_URL` | Exact HTTPS origin, without path/query/fragment |
| `OIDC_ISSUER` | Exact HTTPS issuer identifier; trailing paths/slashes matter |
| `OIDC_CLIENT_ID` | Registered client identifier |
| `OIDC_CLIENT_SECRET` | Secret reference, never an image layer/checked-in tfvars |
| `OIDC_GROUPS_CLAIM` | Top-level group claim, default `groups` |
| `OIDC_ROLE_GROUPS` | JSON mapping roles to explicit group arrays |
| `SESSION_SECRET` | Secret reference: random base64url 32-byte key |
| `SESSION_MAX_AGE_SECONDS` | Optional integer 300–3600, default 900 |
| `SESSION_REFRESH_MAX_AGE_SECONDS` | Default 0 (off); 3600–2592000 enables a fixed login lifetime |

Replace example groups with exact customer identifiers:

```json
{
  "viewer": ["YOUR_VIEWER_GROUP"],
  "analyst": ["YOUR_ANALYST_GROUP"],
  "admin": ["YOUR_ADMIN_GROUP"]
}
```

Only listed groups grant access; highest matching role wins. Missing/malformed/unrelated
group claims deny login. Replicas must share issuer, client, origin, mapping and key.
Generate/store secrets through the approved secret manager, not command history, PRs
or support bundles.

Terraform supports explicit `auth_mode=oidc`, `oidc_issuer`, `oidc_client_id`,
`oidc_groups_claim`, `oidc_role_groups`, `session_max_age_seconds`,
`session_refresh_max_age_seconds` and `oidc_secret_name`.
The latter references an existing namespace Secret containing `OIDC_CLIENT_SECRET` and
`SESSION_SECRET`; Terraform neither reads those values nor puts them in state or inline env.
Provision the Secret through the customer-approved secret manager before rollout.
Basic mode keeps its resource address/default and requires its protected password input.
Changing modes refreshes pods and clears unused Basic Secret data; retain protected Basic
inputs when a rollback to that mode must remain available.

On a first installation the namespace does not exist until Terraform creates it. Review
and apply a bootstrap plan targeting only `kubernetes_namespace.claude_code` and
`aws_ecr_repository.dashboard`, then provision the external Secret and review/apply the
complete stack. Targeted bootstrap is for initial creation, not routine reconciliation.
Do not create an unmanaged same-name namespace or automatically import a shared one.
Existing managed installations already have the namespace and can provision the Secret
before the mode-change rollout.

Source support and successful Terraform validation do not prove live activation.
Verify the actual mode/secret references and use `/installation` as an authorized admin
for current connectivity and receipt diagnostics.

## Verify and roll out

1. Keep the known-good image/authentication configuration available for rollback.
2. Confirm discovery and signed group claims privately; publish no tokens/raw claims.
   Never enable insecure auth to diagnose failure.
3. Deploy configuration/secret references together following
   [the deployment runbook](deploy-production.md). Secret changes require a rollout.
4. Without cookies, config/session/data return 401; probes retain their normal behavior.
5. Sign in with invited viewer/analyst/admin fixture accounts. Deny unmapped accounts;
   a viewer's direct chat POST returns 403 before model/query execution.
6. Verify Secure/HttpOnly/host-only cookies and configured callback origin despite
   differing Host/forwarded headers.
7. With refresh enabled, confirm renewal before short principal expiry, after browser
   inactivity and across replicas. Refresh must preserve the original subject, recheck
   groups and keep the original absolute deadline. An invalid/revoked refresh token
   requires login; a temporary outage hides expired data and permits retries.
   Without refresh, expiry removes displayed data and offers login.
8. Logout clears cookies and revokes the retained refresh token. Replay of that refresh
   credential must fail. Requests without cookies return 401; copied short principal
   cookies may remain usable until expiry. Revocation failures must be visible.
9. Confirm authentication/config/data responses are not cached at edge/browser.

The edge must forward Cookie, Origin, callback query parameters and POST requests, and
must preserve Set-Cookie. The supported CloudFront configuration uses CachingDisabled
and AllViewer; verify live policies rather than assuming they are applied.
Preserve a Referrer Policy compatible with same-origin form POST Origin, such as the
application's `strict-origin`; do not override it with `no-referrer`.
Test logout in a real browser through the actual edge and directly through the test origin.

## Persistent Cognito login

Use a dedicated confidential authorization-code client with token revocation enabled,
refresh rotation disabled, 15-minute access/ID tokens and 30-day refresh validity.
Set `session_refresh_max_age_seconds=2592000` while retaining
`session_max_age_seconds=900`. Cognito returns refresh tokens for the code flow; no
`offline_access` scope is needed. Other providers must return signed ID tokens on refresh
and publish a revocation endpoint supporting `client_secret_basic`; this mode is not
supported for rotation-only clients.

Read the existing pool/client before changing it. Cognito client updates replace omitted
fields with defaults: preserve callbacks, scopes, flows, providers and other settings.
Do not replace a pool or reuse an unrelated application's client. If the configured pool
was deleted, identify the intended replacement with its owner before provisioning a
dedicated client and changing issuer/client/secret references together.

Only the first login writes the two encrypted refresh cookies. Neither sliding expiry
nor refresh-token rotation is implemented. Keep the provider's lifetime aligned; existing
cookies acquire persistence only after one new login. Account disabling and group removal
take effect on renewal, with the configured short-session delay.

Deploy source and configuration through the normal release gates. To disable persistence,
set the refresh duration to zero and roll out all replicas. Existing short principals
expire normally; retained refresh cookies stop authorizing renewal. Rotate the session key
and revoke provider refresh tokens if existing credentials must also be invalidated.

## Rotation, logs and recovery

Rotating `SESSION_SECRET` invalidates sessions after replicas refresh their environment.
A mixed-key rollout can require login retries. There is no instantaneous/per-user
revocation guarantee; choose lifetime to match account-removal policy.

JSON security events cover login/access denial, callback/provider failure, permission/
origin denial and logout. Retain them in protected logs. Actors are pseudonymous and
stable only for the issuer/key. This is neither a durable app audit database nor a
complete record of every telemetry read.

Failure events include a bounded stage/class, not raw provider messages, tokens or callback
parameters. Stages distinguish discovery, transaction, exchange and claims processing.
Discovery is deferred until login; syntactically valid settings alone do not prove IdP
availability. If OIDC settings are present, removing `AUTH_MODE` refuses startup rather
than silently using Basic credentials.

Login/callback allow 60 combined requests/IP/minute/process with at most 4,096 active
IP buckets; rejection is 429/Retry-After. Configure fleet protection separately and
account for shared corporate egress. Generic login failures disclose no provider detail;
diagnose configuration privately. Readiness measures ClickHouse/draining, not the IdP.
