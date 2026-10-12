# Dedicated installation product readiness

The selected commercial target is a paid, customer-owned AWS installation. Workshop/
development capabilities are evidence inputs, not commercial-release approval.
Preserve the [measurement contracts](../AGENTS.md#contracts): activity is not employee
productivity, costs are not invoices, and unknown coverage is not zero.

## Release acceptance

| Requirement | Acceptance evidence |
|---|---|
| Customer boundary | Customer AWS resources/DB credentials/ingress/secrets; no maintainer-account or telemetry dependency |
| Identity and permissions | Invited OIDC, explicit groups, enforced roles/expiry/logout and actual customer-IdP integration |
| Reproducible installation | Versioned distribution, supported prerequisites, validated inputs and complete install path |
| Onboarding | Diagnostics distinguish DB/schema/auth/client configuration, no/stale data and unavailable probes; setup produces verified signals |
| Reliable measurements | Tested cost basis, model coverage, temporality, unknown values and source/observation limits |
| Product experience | Coherent navigation/account controls, actionable states and accessible desktop/mobile screens |
| Safe assistant | Role/auth/readonly gates, bounded request/model/query output, cancellation and honest limits |
| Capacity protection | Bounded caches/in-flight work, request admission, DB budgets and documented fleet limits |
| Recovery and lifecycle | Version-bound migrations/upgrades/rollback, backup configuration and isolated restore rehearsal |
| Secure distribution | Supported runtime, reviewed dependencies, immutable provenance, third-party notices and no secrets/customer data |
| Operations and support | Health/freshness/alerts, release identity, redacted diagnostics and incident/rotation procedures |
| Commercial handoff | Install/support scope, operating-cost assumptions, license/notices and customer acceptance checklist |
| Release verification | Latest-HEAD CI/required review, content score >=85, actual image/runtime/edge and customer-style end-to-end installation |

## Implementation order

1. Individual identity/roles:
   [ADR-019](decisions/ADR-019-dedicated-installation-identity.md),
   [SSO operations](runbooks/organization-sso.md).
2. Infrastructure inputs and installation diagnostics/onboarding.
3. Capacity protection, assistant boundaries and accessibility.
4. Versioned distribution, lifecycle/recovery, support and commercial handoff.
5. Verify every acceptance row on an isolated customer-style installation and inspect
   distribution/runtime before declaring release readiness.

Failing/missing review or integration evidence remains an unresolved release gate.
A compatible default or successful application deploy does not close the product goal.
