# Infrastructure as Code

`infra/` is one Terraform root module for workloads and supporting resources on an
**existing** EKS cluster. It looks up the VPC, subnets, OIDC provider, node role, public
hosted zone and wildcard certificate. It does not create a new EKS cluster or VPC.
See [infra/AGENTS.md](../../infra/AGENTS.md) before changing it.

## Resource ownership

| Source | Responsibility |
|---|---|
| [providers.tf](../../infra/providers.tf) | Terraform >=1.9; AWS, Kubernetes, kubectl and time providers; local state |
| [data.tf](../../infra/data.tf) | Existing cluster/network/IAM/DNS/certificate lookups |
| [nodepool.tf](../../infra/nodepool.tf) | Dedicated Karpenter `NodePool` and `EC2NodeClass`, arm64/on-demand, tainted for this workload |
| [clickhouse.tf](../../infra/clickhouse.tf) | Namespace, credentials, Keeper and ClickHouse custom resources, schema-init and backup jobs |
| [dashboard.tf](../../infra/dashboard.tf) | Dashboard deployment, service account, Secrets, NLB services, security groups and runtime settings |
| [ecr.tf](../../infra/ecr.tf) | Dashboard image repository |
| [s3.tf](../../infra/s3.tf) | Cold/backup bucket, public-access block, IRSA and backup-prefix expiration |
| [dns_cdn.tf](../../infra/dns_cdn.tf) | Two CloudFront VPC origins/distributions and Route53 aliases |
| [alerting.tf](../../infra/alerting.tf) | Optional CloudFront 5xx alarm and SNS email subscription |
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

The schema-init Job name includes a hash of
[clickhouse-schema-replicated.sql](../../infra/files/clickhouse-schema-replicated.sql), so a
schema edit changes the Job identity on apply. This gives executable ALTER statements a
rerun path; it does not make every existing table/view match a CREATE definition.
The segment-key cutover and rollup rebuild require the
[migration procedure](../runbooks/schema-migrations.md).

The dashboard image is separately deployed: Terraform ignores later changes to its image
field. See [runtime](infrastructure.md) for probes and draining, and
[deployment](../runbooks/deploy-production.md) for operational verification.

The S3 lifecycle expires `backup/` objects after 30 days; table TTL owns cold-data deletion.
The optional `alert_email` creates a CloudFront alarm/SNS path. The application webhook
setting is a separate freshness-alert path, described in [alerting](../runbooks/alerting.md).

For exports outside this stack, [archive-clickhouse.sh](../../scripts/archive-clickhouse.sh)
requires a workshop source profile and accepts optional `ARCHIVE_PROFILE` for the destination;
otherwise the destination uses ambient credentials. See the [archive runbook](../runbooks/archive-clickhouse.md).
Do not infer live resource or migration state from these declarations.
