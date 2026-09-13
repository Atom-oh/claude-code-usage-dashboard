# ADR-004: Basic Auth baseline with a future edge SSO path

- Status: Accepted
- Date: 2026-09-03
- Reconciled: 2026-09-13

## Context and decision

Keep shared Basic Auth for the internal single-organization audience, under the premise
that every authenticated viewer may read the entire dataset. There is no per-viewer identity
or role separation in this baseline. A shared credential does not provide an individual
audit trail, and its disclosure grants the same read access as any authorized viewer.

[index.js](../../dashboard/server/index.js) refuses to start without both
`BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD`, except for the explicit local-development
`AUTH_ALLOW_INSECURE=1` bypass. Only `/healthz` and `/readyz` bypass the middleware;
`/api/config`, `/api/health/data`, and other API routes remain authenticated. Chat has its
own additional gates. Do not turn a deployment failure into an unauthenticated fallback.

[dashboard.tf](../../infra/dashboard.tf) supplies the credential through a Kubernetes
Secret. Rotation is manual: update the protected secret input, apply the reviewed change,
then roll pods so their environment refreshes. Follow the
[deployment runbook](../runbooks/deploy-production.md). Secret-value changes alone do not
refresh an existing process.

The declared public path in [dns_cdn.tf](../../infra/dns_cdn.tf) is CloudFront to an
internal NLB. Verify actual ingress and authentication; source declarations do not establish
that no alternate network path exists. The application's middleware also protects direct
non-probe requests when authentication is configured.

## Deferred SSO design

If the audience requires individual identity or different access rights, prefer a separately
designed edge authentication layer using the organization's OIDC provider or a Cognito user
pool. The original options were an ALB authentication listener or custom Lambda@Edge logic.
Neither is implemented by this repository's current NLB/CloudFront configuration.

Keep self-service sign-up disabled; accounts must be administrator-created or invited. The
recorded Cognito option uses `AllowAdminCreateUserOnly = true`. Any edge-to-app identity
handoff must validate its trust boundary and prevent direct/header-spoofing bypass. Keeping
Basic Auth between edge and origin is an additional origin credential, **not automatically
multi-factor authentication**. Removing it requires a reviewed replacement, not merely an
SSO screen in front of the app.

## Rationale, alternatives, and consequences

The baseline avoids IdP integration/session handling for viewers with identical permissions.
The trade-off is manual rotation, no individual attribution, and broad access from one leaked
credential. Read this with [ADR-006](ADR-006-client-side-pii-masking-baseline.md): widening
the audience can invalidate both decisions' assumptions.

Application-side OIDC and a SPA-managed hosted-login flow were deferred because they add
login/callback, session or token-management responsibilities. They do not inherently require
secrets to be baked into an image; the concern was integration scope. An IP allowlist alone
was rejected because participants move between networks. Edge SSO is a future design choice,
not a deployable feature promised by this ADR, and per-user data restrictions may require
changes beyond the authentication layer.
