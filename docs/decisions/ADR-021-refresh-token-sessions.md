# ADR-021: Bounded refresh-token sessions

- Status: Accepted
- Date: 2026-10-21
- Amends: [ADR-019](ADR-019-dedicated-installation-identity.md), token retention and logout

## Decision

Dedicated installations may opt into persistent OIDC login with
`SESSION_REFRESH_MAX_AGE_SECONDS`. Zero preserves short sessions; the supported
positive range is one hour through 30 days. The clock starts at the authorization
code exchange and never slides. Configure the provider's refresh-token validity
to the same duration; a shorter provider lifetime ends login earlier.

Keep the short principal lifetime: at most `SESSION_MAX_AGE_SECONDS` and the signed
ID token's expiry. Renewal verifies the new signature, issuer, audience, expiry,
original subject and current mapped groups. Missing ID tokens or unauthorized
groups fail closed. The SPA renews before expiry and updates displayed permissions.
An expired principal hides data while a transient provider failure is retried.
Requests after an idle browser/restart can renew at the server before accessing data.

Store only the refresh credential and its subject/absolute deadline in an
AES-256-GCM envelope bound to issuer, client, origin and purpose. Split the envelope
across two Secure/HttpOnly/SameSite=Lax host cookies, each at most 3,000 characters.
Reject oversized credentials, duplicate/missing chunks and invalid envelopes.
Never expose tokens through JSON or browser storage. Access/ID tokens are discarded
after verification. Replicas continue to share the installation's existing key.

This mode uses `client_secret_basic` for token exchange and revocation. It requires
a confidential client, revocation endpoint and **non-rotating**
refresh tokens. Rotation needs shared session coordination to avoid stale-token
overwrites between tabs and replicas; this change adds no state service. Unexpected
rotated tokens fail closed. Cognito's client-secret authentication and fixed lifetime
bound this choice; encrypted-cookie theft still permits replay until revocation or
expiry. Refresh requests are deduplicated only while in flight, capped at 16 per
process, with five-second failure cooldowns and at most 1,024 cooldown entries.

Origin-checked logout clears browser credentials and revokes the refresh token.
Revocation failure returns an explicit error; it is not reported as complete.
Ordinary renewal never reissues refresh cookies, so an in-flight response cannot
restore a logged-out browser's long-lived credential.

## Limits and operations

Provider account/group changes become effective when the short principal renews.
Copied or concurrently issued short principal cookies can survive logout/revocation
until their expiry. IdP hosted-login cookies are separate; this does not promise
global sign-out or immediate targeted revocation across replicas.

Legacy cookies require one new login to acquire a refresh credential. Key/client/
issuer changes invalidate old cookies. Existing Basic installations keep their
behavior. See [SSO operations](../runbooks/organization-sso.md) for deployment,
provider configuration and rollback.

Provider behavior:
[Cognito refresh tokens](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html),
[token revocation](https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html).
