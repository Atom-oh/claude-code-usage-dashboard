# Infrastructure as Code

`infra/` is one Terraform root module for workloads and supporting resources on an
**existing** EKS cluster. It looks up the VPC, subnets, OIDC provider, node role, public
hosted zone and wildcard certificate. It does not create a new EKS cluster or VPC.
See [infra/AGENTS.md](../../infra/AGENTS.md) before changing it.

## Existing environment inputs

[installation.tf](../../infra/installation.tf) accepts `node_role_name` and
`private_subnet_ids`. An explicit role is read by name, bypassing the legacy `eksctl`
pattern; its cluster admission and Karpenter permissions remain operator prerequisites.
The planning identity needs IAM read access including `iam:GetRole` for explicit roles.
The default lookup must return exactly one role instead of choosing an arbitrary match.

`cloudfront_certificate_arn` pins an existing certificate for both public distributions,
skipping wildcard discovery. Terraform checks ARN syntax, `us-east-1` and the installation
account. The operator must independently verify `ISSUED` status, expiry and coverage of
both hostnames. Null retains the most recent issued wildcard lookup; a newer matching
certificate can therefore change the next plan. Pin the verified installed ARN when
retaining an existing certificate, then inspect the complete plan. This input does not
create, renew or validate a certificate.

Explicit subnets must all exist in the cluster VPC and are used by both EC2NodeClass and
the internal NLB services. The NodeClass selector depends on the validated lookup, including
targeted operations. Empty input retains discovery tags. Empty/mismatched results
fail the data-source postcondition. Verify private routing, available addresses and
required service reachability independently: names, tags and a successful lookup are not
network validation. Security-group discovery still requires the existing Karpenter tag.
After `terraform -chdir=infra init -backend=false`, run
`bash scripts/test-installation-terraform.sh` to exercise the actual lookup/NodeClass files
with mocked providers and the committed provider versions. These tests make no AWS calls
and do not verify an installation.

## Resource ownership

| Source | Responsibility |
|---|---|
| [providers.tf](../../infra/providers.tf) | Terraform >=1.9; AWS, Kubernetes, kubectl and time providers; local state |
| [data.tf](../../infra/data.tf) | Existing cluster/network/IAM/DNS/certificate lookups |
| [nodepool.tf](../../infra/nodepool.tf) | Dedicated Karpenter `NodePool` and `EC2NodeClass`, arm64/on-demand, tainted for this workload |
| [clickhouse.tf](../../infra/clickhouse.tf) | Namespace, credentials, Keeper and ClickHouse custom resources and backup jobs |
| [schema.tf](../../infra/schema.tf) | Immutable schema inputs; empty bootstrap and existing-installation compatibility Job |
| [dashboard.tf](../../infra/dashboard.tf) | Dashboard deployment, service account, Secrets, NLB services, security groups and runtime settings |
| [ecr.tf](../../infra/ecr.tf) | Dashboard image repository |
| [s3.tf](../../infra/s3.tf) | Cold/backup bucket, public-access block, IRSA and backup-prefix expiration |
| [dns_cdn.tf](../../infra/dns_cdn.tf) | Two CloudFront VPC origins/distributions and Route53 aliases |
| [alerting.tf](../../infra/alerting.tf) | Optional CloudFront 5xx alarm and SNS email subscription |
| [backup-monitor.tf](../../infra/backup-monitor.tf) | Independent bounded backup observer, restricted IRSA/RBAC, regional health alarm and SNS topic |
| [variables.tf](../../infra/variables.tf), [outputs.tf](../../infra/outputs.tf) | Deployment inputs and resource outputs |

Karpenter and the ClickHouse/Keeper operators must already be available to reconcile the
custom resources. The module defines a one-shard, three-replica ClickHouse installation and
three Keeper replicas. The NodePool is not an EKS managed node group.
Participant EC2 machines and their collectors are configured separately by
[user-data.sh](../../user-data.sh); they are not Terraform resources in this module.

## State, schema and rollout

State is local in the current provider configuration. Protect state and untracked tfvars
because sensitive values can still be stored there. Use
[terraform.tfvars.example](../../infra/terraform.tfvars.example) and
[backend.hcl.example](../../infra/backend.hcl.example) as inputs, not evidence that a remote
backend or deployment exists. A shared operator workflow needs explicit state coordination.

The schema-init Job and immutable ConfigMap names include a hash of the replicated SQL,
metadata contract and runner. On every expected replica, an empty database permits
bootstrap; any existing object selects read-only compatibility verification. Existing
tables are not altered, materialized or repaired by this Job. Its contract checks named
column types/default expressions, engines, keys, TTL, view query/target, storage policy,
replication path and migration checksums. It does not verify historical data or backfills.
The [migration procedure](../runbooks/schema-migrations.md) owns upgrades and partial repair.
Codex's four metric tables are mirrored in schema-init. Standalone migration 006 is
additive and requires ledger 004; it does not run migration 005 or rebuild rollups.
The full installation compatibility check also requires completed migrations 003 and
005, including their schema and ledger evidence.
The [collection contract](../runbooks/codex-telemetry.md#storage-interface) owns their
exporter columns and retention. Generate and check the metadata contract using the
network-isolated ClickHouse 24.8 fixture; CI rejects a stale contract. Code changes do not
establish that the existing target has the required schema.

The dashboard image is separately deployed: Terraform ignores later changes to its image
field. See [runtime](infrastructure.md) for probes and draining, and
[deployment](../runbooks/deploy-production.md) for operational verification.

[identity.tf](../../infra/identity.tf) supports organization OIDC with an external Kubernetes
Secret reference. Only `OIDC_CLIENT_SECRET` and `SESSION_SECRET` keys are read by the pod;
Terraform does not read their values. Group mapping and public origin remain explicit
non-secret configuration. Basic keeps its resource address/default; mode changes require
the controlled [SSO rollout](../runbooks/organization-sso.md).
`scripts/test-identity-terraform.sh` validates the actual identity/variable files in a
provider-free fixture; it is not a plan or deployment of the complete stack.

The S3 lifecycle expires `backup/` objects after 30 days; table TTL owns cold-data deletion.
Backup Jobs have a configurable deadline (default two hours) and two-retry backoff limit.
The independent backup observer defaults on, reuses the released dashboard image and
publishes one metric per installation every five minutes. Terraform seeds its initial
image; [deployment](../runbooks/deploy-production.md#refresh-the-backup-observer) owns later
image updates and its separate rollback record. A regional alarm treats
missing metrics as breaching. Configure and confirm a recipient or attach an authorized
subscriber; a topic alone is not delivery coverage. The observer does not inspect S3
objects or establish restore usability. Its runtime, IAM and delivery checks are owned by
[alerting](../runbooks/alerting.md#backup-observation).
The optional `alert_email` creates a CloudFront alarm/SNS path. The application webhook
setting is a separate freshness-alert path, described in [alerting](../runbooks/alerting.md).

For exports outside this stack, [archive-clickhouse.sh](../../scripts/archive-clickhouse.sh)
requires a workshop source profile and accepts optional `ARCHIVE_PROFILE` for the destination;
otherwise the destination uses ambient credentials. See the [archive runbook](../runbooks/archive-clickhouse.md).
Do not infer live resource or migration state from these declarations.
