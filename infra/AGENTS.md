# Infrastructure instructions

Terraform configures the dashboard and ClickHouse on an existing EKS environment.
Use Terraform 1.9 or newer, retain the provider lockfile, and follow the checked-in
variable/output definitions. This directory is separate from the Workshop Studio
EC2 collector/user-data lifecycle.

## Validation and state

```bash
terraform fmt -check -recursive .
terraform init -backend=false
terraform validate
```

Validation is not a plan or deployment. Read the relevant runbook before a plan/apply.
Do not commit credentials, real tfvars, state, plans, or backend secrets.
Do not infer live resource state from a successful static validation or a source file.

## Contracts

- The public application path uses CloudFront and an internal load-balancer origin.
  Do not create an unauthenticated alternate application entry point.
- Keep application secrets in the existing secret references, not image layers or
  public outputs. Client-side PII masking does not authorize publishing raw data.
- Dashboard readiness uses `/readyz` and graceful draining; liveness uses `/healthz`.
  Docker image health checks do not configure Kubernetes probes.
- Use immutable release identifiers and verify image digests. Terraform declares an
  immutable ECR policy, but operators must check whether that desired state is applied.
- ClickHouse schema initialization can be retriggered by a schema-file hash change.
  DDL can be partly applied before a Job fails. Inspect the Job, actual columns/keys,
  and migration ledger; Job completion alone is not proof of every intended change.
- Migrations 003 onward record their versions, but migrations and rollup rebuilds
  remain explicit operations. Preserve the `session.count` key exception and documented
  ingestion freeze/rebuild ordering.
- Backup, retention, and archive behavior must match actual storage policies and
  bucket lifecycle rules. Do not destroy old data based on an unverified backup.
- Keep schema copies and affected dashboard/legacy queries consistent. Update the
  architecture and operational reference when infrastructure behavior changes.

## References

- [Architecture](../docs/architecture.md)
- [IaC reference](../docs/reference/iac.md)
- [Deployment](../docs/runbooks/deploy-production.md)
- [Schema migrations](../docs/runbooks/schema-migrations.md)
- [Backup and restore](../docs/runbooks/backup-and-restore.md)
