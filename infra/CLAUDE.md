# Infra Module

## Role
Single Terraform root module provisioning the EKS cluster, ClickHouse (via its Kubernetes
Operator), ECR, S3, and DNS/CDN for the dashboard.

## Key Files
- `providers.tf`, `data.tf`, `variables.tf`, `outputs.tf` -- module scaffolding
- `nodepool.tf` -- Graviton (arm64) EKS managed node group
- `clickhouse.tf` -- ClickHouse Operator install, `Cluster` resource, `hot_cold` storage
  policy (local EBS `default` disk + `cold_s3` disk)
- `dashboard.tf` -- dashboard k8s Deployment/Service, env injection from k8s Secret
- `ecr.tf` -- ECR repository for `cc-ab-dashboard`
- `s3.tf` -- cold-tier storage + backups
- `dns_cdn.tf` -- Route53 + CloudFront for the public dashboard endpoint
- `files/clickhouse-schema-replicated.sql` -- schema applied by the operator (kept in sync
  with the root `clickhouse-schema.sql` reference copy)
- `secrets.auto.tfvars`, `image.auto.tfvars` -- gitignored; injected at `terraform apply` time,
  never committed
- `terraform.tfstate*` -- local state (gitignored); acceptable for a single-operator workshop
  environment, would need a remote backend before multi-operator use

## Rules
- Never commit `*.tfvars`, `terraform.tfstate*`, or anything under `.terraform/` — all
  already gitignored, keep it that way.
- If `clickhouse.tf` or `files/clickhouse-schema-replicated.sql` changes a promoted/materialized
  column, mirror the change in the root `clickhouse-schema.sql` (reference copy) and check
  `grafana-ab-queries.sql` and `dashboard/server/queries.js` for the same column.
- Build images for `linux/arm64` only — the nodepool defined here is Graviton
  (`m8g.xlarge`); an `amd64` image will not run.
- Changes here that require a new dashboard rollout to take effect (e.g. `dashboard.tf` env
  vars) need a follow-up `kubectl set image` or `rollout restart` — `terraform apply` alone
  does not rebuild the app image. See `docs/runbooks/deploy-production.md`.
