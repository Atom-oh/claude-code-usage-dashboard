# Infrastructure instructions

Terraform configures dashboard/ClickHouse on existing EKS. Use Terraform 1.9+,
retain the provider lockfile; follow checked-in variable/output definitions.
Workshop Studio EC2 collector/user-data has a separate lifecycle.

## Validation and state

```bash
terraform fmt -check -recursive .
terraform init -backend=false
terraform validate
```

Validation proves neither a plan nor deployment. Read the relevant runbook before plan/apply.
Never commit credentials, real tfvars, state, plans or backend secrets.
Source files and static validation do not prove live resource state.

## Contracts

- Public access uses CloudFront and an internal load-balancer origin.
  Never create an unauthenticated alternate entry point.
- Keep application secrets in the existing secret references, not image layers or
  public outputs. Client-side PII masking does not authorize publishing raw data.
- Dashboard readiness uses `/readyz` and graceful draining; liveness uses `/healthz`.
  Docker health checks do not configure Kubernetes probes.
- Use immutable release identifiers; verify image digests.
  Verify that the Terraform-declared immutable ECR policy is actually applied.
- Schema-file hash changes can retrigger ClickHouse initialization. DDL may partly
  apply before Job failure. Inspect the Job, actual columns/keys and migration ledger;
  Job completion does not prove every intended change.
- Migrations 003 onward record versions; migrations/rollup rebuilds remain explicit.
  Keep the `session.count` key exception and documented ingestion freeze/rebuild order.
- Backup/retention/archive behavior must match actual storage policies and bucket
  lifecycle rules. Never destroy old data based on an unverified backup.
- Keep schema copies and affected dashboard/legacy queries consistent.
  Update architecture/operations references when infrastructure behavior changes.

## References

- [Architecture](../docs/architecture.md)
- [IaC reference](../docs/reference/iac.md)
- [Deployment](../docs/runbooks/deploy-production.md)
- [Schema migrations](../docs/runbooks/schema-migrations.md)
- [Backup and restore](../docs/runbooks/backup-and-restore.md)
