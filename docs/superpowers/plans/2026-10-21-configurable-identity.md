# Configurable Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore shared-pool login, automate Cognito group membership from private
configuration, and ship tested provider-compatible refresh sessions.

**Architecture:** Keep email/domain policy in a separate Cognito administration
integration. The dashboard consumes signed OIDC group claims and configurable scopes.
Restore current-image login independently from new code releases.

**Tech Stack:** Python/boto3 Lambda, standalone Terraform, Express/openid-client,
React/Vitest, Node tests and the existing shell harness.

**Spec:** [Configurable identity operations](../specs/2026-10-21-configurable-identity.md)

## Global constraints

- No real identities, domains, pool/client identifiers or secrets in public source.
- No email/domain authorization logic or Cognito administration permissions in the app.
- Preserve existing users, unrelated groups, pool triggers and other app clients.
- Retain current application resource limits.
- Tests are authorized; deployment requires current review and artifact evidence.

## Review focus

- Unverified, disabled, renamed and lookalike-domain accounts must not retain grants.
- Pagination or policy failures must not turn a partial snapshot into removals.
- Repeated executions must make no writes for unchanged membership.
- Refresh-disabled rollback and unchanged-expiry responses must not leave a stalled UI.
- Customer scopes and group claims must remain configurable without deployment identities
  becoming source defaults.

## Task 1: Cognito group reconciliation

**Files:** `integrations/cognito-group-sync/` for policy/handler, tests, standalone
Terraform and README; `tests/test-cognito-group-sync.sh` for harness discovery.

**Interfaces:** `parse_policy(value)` validates a JSON object containing `managedGroups`,
`emailGroups`, `domainGroups`, `requireVerifiedEmail=true`, `requireEnabledUser=true`,
and `exactEmailOverridesDomain=true`. `desired_groups(user, policy)` returns a set of
managed group names. `reconcile(client, pool_id, policy, dry_run=True)` returns only
aggregate counts. Lambda reads `USER_POOL_ID`, `POLICY_PARAMETER_NAME` and `DRY_RUN`.

- [x] Write and run failing unit cases for exact-email precedence, exact domain matching,
  disabled/unverified exclusion and invalid configuration.
- [x] Implement pure policy evaluation with no provider/application identities.
- [x] Write and run failing fake-client cases for pagination failure before writes,
  stale eligibility reread, removal-before-add, unrelated membership preservation,
  dry-run and repeat-run idempotency.
- [x] Implement bounded paginated reconciliation with sanitized failure output.
- [x] Add optional standalone Terraform for Lambda, encrypted policy parameter,
  pool/parameter-scoped IAM, logs and minute schedule. Existing groups are inputs.
  Default dry-run is true; no public function URL or pool trigger is created.
- [x] Add unit harness, operator instructions and generic policy examples.
- [x] Run tests and Terraform formatting/validation; record results for review.

## Task 2: Refresh regressions and OIDC scopes

**Files:** `dashboard/server/auth.js`, `auth.test.js`,
`dashboard/web/src/SessionBoundary.jsx`, adjacent tests, `infra/identity.tf`,
`infra/terraform.tfvars.example`, identity fixtures and SSO/API documentation.

**Interfaces:** `OIDC_SCOPES` is a validated space-delimited OIDC scope set, default
`openid profile`, always requiring `openid`; Terraform `oidc_scopes` propagates it.
`refreshExpiresAt` remains available only for a current matching refresh credential.

- [x] Add failing regressions for refresh renewal, absolute deadline, invalid/revoked
  refresh, subject/group changes, logout revocation and cross-origin rejection.
- [x] Cover concurrent refresh deduplication, failure bounds, disabled persistence,
  and browser responses whose expiry does not advance.
- [x] Preserve and refine existing local timer/metadata fixes according to failures.
- [x] Add scope validation and authorization-URL tests, then implement configurable
  scopes without customer/provider-specific defaults.
- [x] Document Cognito/Okta/Keycloak group and offline-scope configuration requirements,
  without claiming unperformed provider acceptance tests.
- [x] Run server/web tests/build and relevant Terraform/harness checks.

## Task 3: Release and operational proof

**Owner:** coordinating agent.

- [x] Apply the separately reviewed current-image recovery proposal.
- [x] Verify provider/group readback, rollout readiness and public login reachability.
- [ ] Review task changes, fix substantive findings, push and wait for required
  latest-HEAD specialist review and CI before merging.
- [ ] Build and inspect immutable artifacts; obtain content score >=85.
- [ ] Review complete Terraform plans, apply and verify drift/resource identity.
- [ ] Activate reconciler after a dry-run and verify an unchanged follow-up.
- [ ] Deploy new application code with persistence disabled to all replicas, then
  enable the configured 30-day lifetime and verify the final runtime settings.

## Release organization

The refresh-session change and optional Cognito administration integration are
independent PRs. Each receives the unchanged full-diff review gates; neither requires
the other to function. Operational evidence and installation-specific values remain
in private release records. Login-page reachability does not establish password-based
end-to-end authentication.
