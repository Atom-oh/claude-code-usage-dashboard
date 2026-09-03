# Infra Module

## Role
Single Terraform root module provisioning the EKS cluster, ClickHouse (via its Kubernetes
Operator), ECR, S3, and DNS/CDN for the dashboard.

## Key Files
- `terraform.tfvars.example` -- the five variables with no default (`eks_cluster_name`,
  `domain`, `dashboard_hostname`, `ch_ingest_hostname`, `dashboard_image_tag`). Copy to
  `terraform.tfvars` and fill it in before the first `plan`; `*.tfvars` is gitignored but the
  `.example` filename is not matched by that pattern, so this template is committed
- `providers.tf`, `data.tf`, `variables.tf`, `outputs.tf` -- module scaffolding
- `nodepool.tf` -- Graviton (arm64) EKS managed node group
- `clickhouse.tf` -- ClickHouse Operator install, `Cluster` resource, `hot_cold` storage
  policy (local EBS `default` disk + `cold_s3` disk). Defines the ClickHouse accounts:
  `otel_writer` (no explicit grants, so default full privileges; used by the schema-init Job
  and the backup CronJob), `otel_reader` (`SELECT` + `readonly` profile, used by the
  dashboard) and `otel_ingest` (`INSERT ON claude_code.*` **plus**
  `SELECT ON claude_code.otel_metrics_sum`, used by the EC2 collector fleet). The second grant
  on `otel_ingest` is not optional: the materialized view onto `otel_metrics_sum` carries no
  security clause, so its `SELECT` is checked with the inserting user's privileges, and an
  INSERT-only account cannot insert at all. The schema-init Job now waits for the cluster
  itself (bounded, 60 tries x 5s) before running `clickhouse-client`, and runs with `--echo` so
  a failing statement is identifiable in the pod log.
- `dashboard.tf` -- dashboard k8s Deployment/Service, env injection from k8s Secret;
  `var.pii_mask_enabled` (default `true`) injects `PII_MASK_ENABLED=1` for email masking — the
  app itself defaults to off, so this variable is what makes the standard deployment masked.
  Workshop accounts set it to `false` so participants can find their own row. Also carries a
  readiness probe on `/readyz` (liveness stays on `/healthz`), a `preStop sleep 5` +
  `terminationGracePeriodSeconds 30` drain window, a `RollingUpdate` strategy with
  `max_unavailable=0` / `max_surge=1`, preferred pod anti-affinity on
  `kubernetes.io/hostname`, and a `kubernetes_pod_disruption_budget_v1` with
  `min_available = 1`. Most importantly for anyone reading this file before an apply: the
  Deployment carries `lifecycle { ignore_changes = [...] }` on the container image, because the
  live image is owned by the deploy runbook's `kubectl set image` and `var.dashboard_image_tag`
  only seeds the first rollout, with no default (the now-IMMUTABLE ECR repository has no
  `latest` to fall back to — a value must come from `terraform.tfvars`). Also wires
  `DATA_STALE_MINUTES` (from `var.data_stale_minutes`, default `360`) and the optional
  `PRICING_JSON` / `PRICING_CACHE_WRITE_TTL` (nullable vars; no env is injected when they're
  `null`).
- `ecr.tf` -- ECR repository for `cc-ab-dashboard`, `image_tag_mutability = "IMMUTABLE"` — the
  deploy path therefore pushes only the timestamp tag; a `latest` re-push is rejected by the
  registry.
- `s3.tf` -- cold-tier storage + backups
- `dns_cdn.tf` -- Route53 + CloudFront for the public dashboard endpoint. The dashboard
  distribution attaches the AWS managed `Managed-SecurityHeadersPolicy` response headers policy
  (`67f7725c-6f97-4210-82d7-5512b31e9d03`) on its default cache behavior; the ClickHouse ingest
  distribution deliberately does not, because it serves an OTLP write path to a non-browser
  client and the policy's browser-oriented headers buy nothing there.
- `files/clickhouse-schema-replicated.sql` -- schema applied by the `schema_init` Job in
  `clickhouse.tf` (kept in sync with the root `clickhouse-schema.sql` reference copy). The Job is
  named by the file's md5 so any edit re-runs it, and `wait_for_completion = true` makes a failing
  statement fail `terraform apply` — the client is `--multiquery`, so nothing after the failing
  statement is applied; read the Job pod logs, don't assume a green apply means the schema landed.
  The hourly rollup's TTL is DELETE-only on purpose (the live table is on `storage_policy=default`
  and cannot be moved to `hot_cold` in place — see the comment block in the SQL file)
- The `schema_init` Job's name embeds `filemd5(...)` of `files/clickhouse-schema-replicated.sql`
  (`clickhouse.tf`), so editing that file recreates and re-runs the Job on the next `apply` —
  most recently the `schema_migrations` ledger block added by `clickhouse-migration-004.sql`.
  A re-run on an already-provisioned cluster is idempotent in outcome but not free: the
  `CREATE … IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / guarded-`INSERT` statements are no-ops,
  but the 29 unguarded `ALTER TABLE … MATERIALIZE COLUMN` statements (`grep -c 'MATERIALIZE
  COLUMN' files/clickhouse-schema-replicated.sql`, all executable, none in comments) each schedule a full-table mutation on
  `otel_metrics_sum` / `otel_logs` again, so expect background mutation load after the apply
  (`SELECT * FROM system.mutations WHERE NOT is_done`).
- `secrets.auto.tfvars`, `image.auto.tfvars` -- gitignored; injected at `terraform apply` time,
  never committed
- `terraform.tfstate*` -- local state (gitignored); acceptable for a single-operator workshop
  environment, would need a remote backend before multi-operator use. `.terraform.lock.hcl`
  **is** committed now (provider versions must be reproducible).
- `backend.hcl.example` -- template for moving to an S3 backend; the filled-in `backend.hcl`
  itself is gitignored.

## Rules
- **`terraform plan`/`apply` requires a `terraform.tfvars`.** Five variables deliberately have
  no default -- an apply with no tfvars used to target this deployment's own cluster, domain and
  hostnames, and a `latest` image tag the now-IMMUTABLE ECR repository rejects. Start from
  `terraform.tfvars.example`.
- Never commit `*.tfvars`, `terraform.tfstate*`, `backend.hcl`, or anything under
  `.terraform/` — all already gitignored, keep it that way.
- If `clickhouse.tf` or `files/clickhouse-schema-replicated.sql` changes a promoted/materialized
  column, mirror the change in the root `clickhouse-schema.sql` (reference copy) and check
  `grafana-ab-queries.sql` and `dashboard/server/queries.js` for the same column.
- Build images for `linux/arm64` only — the nodepool defined here is Graviton
  (`m8g.xlarge`); an `amd64` image will not run.
- Changes here that require a new dashboard rollout to take effect (e.g. `dashboard.tf` env
  vars) need a follow-up `kubectl set image` or `rollout restart` — `terraform apply` alone
  does not rebuild the app image. See `docs/runbooks/deploy-production.md`.
- Regenerating the lock file for other platforms:
  `terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64`
  — run this (and commit the result) when adding a provider or bumping a constraint. 실측 확인
  (2026-09-02): 커밋된 lock에는 프로바이더별 `zh:` 해시가 12~16개씩(레지스트리 서명 체크섬,
  전 플랫폼 커버) 있고 `h1:`은 이 머신(linux_arm64)용 1개뿐이다 — 그래서 다른 플랫폼의 평범한
  `terraform init`은 `zh:`로 검증하고 자기 `h1:`을 덧붙이며 성공한다. 이 명령이 필요한 경우는
  그 덧붙이기가 불가능한 환경, 즉 프로바이더 미러/에어갭 설치나 `-lockfile=readonly`로 도는
  CI다(그런 CI에서는 `h1:`이 미리 기록돼 있지 않으면 실패한다).
- Moving to remote state (do not do it casually — local state is a recorded decision in
  `providers.tf`): uncomment the `backend "s3"` block, `cp backend.hcl.example backend.hcl`,
  fill it in, then `terraform init -backend-config=backend.hcl -migrate-state`. Keep
  `backend.hcl` out of git.
