# Configurable identity operations

## Intent

Restore the existing demo installation's login through an operator-selected shared
Cognito pool. Keep the application portable to confidential OIDC providers, including
Okta and Keycloak. The operator has authorized implementation, review, deployment and
regression tests.

## Boundaries

- Real pool/client identifiers, emails, domains and role-group names are private
  deployment inputs. Do not embed them in application code or public examples.
- The application authorizes signed group claims through `OIDC_ROLE_GROUPS`; it never
  derives roles from email or calls Cognito to manage users.
- An optional, separate Cognito administration component reconciles only explicitly
  managed groups. It does not change shared-pool login triggers, passwords, unrelated
  groups or other app clients.
- Only enabled users with verified email qualify. Explicit email rules override
  exact domain rules. An unrelated or unverified identity receives no managed grant.
- Preserve the three application roles: viewer, analyst and admin. Analyst means
  telemetry reading and AI querying; this task does not introduce data editing.
- Retain the current application resource limits. Restore login with its existing
  approved image before deploying the separately reviewed refresh feature.

## Automatic group management

A scheduled Lambda reads a private encrypted SSM policy and reconciles an existing
Cognito pool's designated groups. The default schedule is once per minute. Read all
paginated user/group snapshots before changing membership; incomplete reads or malformed
policy must produce no writes. Re-read changed users before granting access. Remove
obsolete managed grants before adding replacements. Preserve all unrelated groups.

The policy declares managed groups, exact-email assignments and exact-domain assignments.
No application-specific names or identities are defaults. The Lambda's IAM access is
limited to the selected pool and parameter. A dry-run reports aggregate changes without
user details. Stable inputs produce no membership writes on subsequent runs.

Membership changes have scheduling and execution delay. Already-issued authorization
tokens and dashboard principals retain their prior permissions until refresh/expiry.
Authentication does not depend on the reconciliation Lambda being available.

## OIDC persistence

Keep the optional fixed 30-day refresh lifetime and short authorization sessions.
Test renewal, expiry, logout revocation, invalid claims, concurrent requests, bounded
failure handling and unchanged-expiry browser responses. Requested OIDC scopes must be
configurable so customers can request provider-required group/offline scopes without
application source changes. Unsupported rotation-only configurations remain explicit.

## Evidence

Source tests, CI, specialist review and artifact review precede new code deployments.
Content review must score at least 85. Record actual issuer/client/group configuration,
deployment readiness and immutable image identity. Anonymous login reachability is not
proof of a successful user's password login. Reconcile imperative recovery settings
through a complete reviewed Terraform plan.
