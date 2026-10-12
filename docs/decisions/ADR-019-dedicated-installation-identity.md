# ADR-019: Identity for dedicated customer installations

- Status: Accepted
- Date: 2026-10-12
- Amends: [ADR-004](ADR-004-basic-auth-baseline-and-sso-upgrade-path.md)

## Decision

The commercial target is one customer AWS account per installation, with customer-owned
infrastructure, telemetry and credentials. This is not a shared SaaS authorization
boundary. Authorized viewers read the installation's entire dataset; roles additionally
control SQL chat and installation diagnostics.

Add application OIDC authorization-code login using `openid-client`, PKCE S256, state,
nonce, issuer/audience checks and explicit ID-token signature validation. The configured
HTTPS public origin fixes callback URLs; proxy headers cannot select an origin.
IdP groups must match an explicit mapping. There is no email-domain allowlist, implicit
viewer admission or app-managed self-registration.

`viewer` reads telemetry. `analyst` also queries chat. `admin` has those permissions and
the reserved `installation:read` permission for diagnostics. This reservation does not
establish that a diagnostics endpoint exists. Roles do not restrict employee rows;
installations needing that boundary require a separately reviewed data model.

Store a minimal principal in an authenticated, encrypted, host-only,
Secure/HttpOnly/SameSite=Lax cookie. Retain no IdP access, refresh or ID tokens.
Sessions default to 15 minutes and cannot outlive the ID token; configured durations
range from five minutes to one hour. A shared 32-byte key lets multiple replicas
validate sessions without another state service.

Unsafe session-authenticated requests require the exact configured Origin.
Login endpoints have bounded per-process admission control. Authentication audit events
omit credentials, raw subjects, display names, claims, callback parameters and query text.
The actor identifier is installation-keyed HMAC, not anonymous telemetry.

## Consequences and limits

Basic Auth remains the explicit default for existing installations. Invalid OIDC
configuration fails closed and never falls back to Basic or local development bypass.
Probes keep their unauthenticated contract. Only OIDC login, callback and origin-checked
local logout protocol routes precede the global gate.

Logout clears browser cookies; it does not end IdP SSO or revoke a copied stateless cookie.
Provider account/group changes take effect at next login; current sessions can remain
usable until expiry. Rotating the shared key invalidates sessions after every replica
has received it. Immediate targeted revocation needs a shared revocation/session service.

MFA, invitation and account lifecycle belong to customer IdP configuration and are not
proved by enabling OIDC. Fleet limits and durable audit retention require customer
edge/logging configuration. Customer integration and deployment need evidence separate
from synthetic protocol tests.

See [SSO operations](../runbooks/organization-sso.md) and
[security reference](../reference/security.md).
