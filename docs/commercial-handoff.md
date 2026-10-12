# Dedicated installation handoff

This is the technical handoff for the [customer-owned AWS product](product-readiness.md).
It accompanies a versioned release and the customer's written license/support agreement.
The repository [LICENSE](../LICENSE) does not itself grant customer use or redistribution.
This document sets no sale price, service credit, legal warranty or response-time promise.

## Supported scope

- One customer's AWS account, existing EKS/VPC, ClickHouse dataset, credentials and ingress.
  Supported prerequisites and installation steps are owned by
  [organization deployment](deploying-for-your-org.md) and [IaC](reference/iac.md).
- A single application image serves the React UI and Express API. Read-only refers to
  telemetry database access; chat and logout also expose POST operations. Deployment
  images target ARM64; the [runtime owner](reference/infrastructure.md) defines versions,
  probes, resource declarations and graceful draining.
- Selectable Claude Code/Codex collection and views. The collector/client setup, schema,
  optional signals and measurement limits remain the
  [onboarding](onboarding.md), [metrics](metrics.md) and
  [Codex observability](reference/codex-observability.md) contracts.
- Organization OIDC with explicitly admitted groups, including Cognito. Verify the actual
  pool/client and accounts before cutover. A shared email or a related pool name is not
  evidence that an existing account belongs to that pool.
  [SSO operations](runbooks/organization-sso.md) owns protocol, roles, expiry and logout.
  [ADR-019](decisions/ADR-019-dedicated-installation-identity.md) retains Basic compatibility
  for existing installations; record that baseline explicitly and verify OIDC before
  accepting a dedicated commercial identity cutover.

Admitted viewers read the installation dataset. This is not employee-row isolation or a
shared SaaS tenant boundary. Display masking does not restrict raw API access. Observed
activity is not validated employee productivity or causal ROI; spend is not an invoice.

## Responsibilities and support intake

| Party | Responsibility |
|---|---|
| Customer operator | AWS account/billing, IAM role/S3/KMS permissions, approved secrets/state storage, EKS/controllers/network/capacity, IdP membership/MFA, collector deployment, data retention and access |
| Release maintainer | Reviewed application/IaC distribution, compatibility notes, measurement contracts, reproducible build instructions and agreed product defect handling |
| Joint acceptance | Verify the intended account/domain, real login/roles/data path, applied settings, usable backups and rollback before accepting the installation |

Record a customer owner and escalation contact in the private handoff. Agree maintenance
windows, supported-version windows/end-of-support notice, support hours, severity definitions
and response targets in the support contract;
none are established by this repository.

For a support request provide the release revision/image digest, component and UTC
incident window, reproducible steps, HTTP status/opaque error ID, readiness/freshness state,
and redacted diagnostic observations. Never attach passwords, tokens, cookies, secret
values, Terraform state/plans, raw user lists or customer telemetry.
Use [incident response](runbooks/incident-response.md), [chat troubleshooting](runbooks/ask-claude-chat-troubleshooting.md)
and [SSO operations](runbooks/organization-sso.md); retain sensitive evidence privately.

## Operating-cost assumptions

Application license/support charges and AWS operating charges are separate. Estimate AWS
costs in the customer account using current regional tariffs and the reviewed plan, then
compare actual resource billing after installation. Telemetry spend cards cannot estimate
the installation's infrastructure bill.

| Component | Quantity/unit to record |
|---|---|
| Existing EKS and controllers | Customer's cluster, compute/control-plane/support and shared-service allocation |
| Karpenter workload compute | Actual instance types, node-hours and scaling; the declared NodePool limit is capacity, not a reservation or cost bound |
| ClickHouse/Keeper storage | Provisioned volume GB, IOPS/throughput and snapshots; declarations are three 100 GiB ClickHouse and three 10 GiB Keeper claims |
| Node root storage | Actual nodes and encrypted 50 GiB gp3 mappings |
| S3 | Hot/cold/backup/archive bytes, retention, transition/request counts, retrieval, minimum-duration conditions and transfer; source TTL and archive retention differ |
| Public delivery | NLB/CloudFront resources, requests, transferred bytes, DNS and any logging |
| VPC connectivity | NAT/VPC endpoint resources, processed/transfer bytes and cross-zone paths in the actual installation |
| Identity and assistant | Customer IdP usage and actual model requests/tokens/routing/tier; per-process admission is not a billing bound |
| Operations | Monitoring/alerts, backup/restore drills, maintenance and agreed support effort |

The [IaC owner](reference/iac.md) defines these resource sizes. They describe source declarations, not verified deployed quantities or a
recommended fleet size. Establish capacity and restore timing with customer-style workload
evidence; do not promise a throughput/SLO, full-database RTO or RPO from defaults.

## Private acceptance packet

Keep a private, customer-approved record containing:

1. Written license/support scope, owner/contact, target AWS account/region/context/domain,
   supported prerequisites and approved secret/state-storage workflow.
2. Reviewed source revision, release tag, image digest/platform, runtime revision and
   packaged third-party notices; keep the known-good image/environment for rollback.
3. Complete reviewed Terraform plan, operator approvals, applied resource observations
   and any declared-versus-live differences; verify target-region service availability,
   account quotas and actual network/identity permissions.
4. Actual existing-account login, group/role permissions, expiry/logout, anonymous API
   denial, safe cookie/origin handling and edge non-caching. Do not preserve raw tokens.
5. Verified collector/client flags, receipt/schema/readonly evidence and an authorized
   data-path check with explicit partial/unknown limitations.
6. Backup inventory/lifecycle, last verified recovery point, isolated restore results and
   measured scope/time; alert delivery and incident/rotation procedures.
7. Supported-version/support windows, upgrade/migration and version-bound rollback
   instructions, operating-cost assumptions,
   remaining issues, and customer acceptance or rejection.

All [release acceptance rows](product-readiness.md#release-acceptance) must have evidence
at their stated scope. A healthy application, green CI or completed UI review alone does
not approve commercial release.
