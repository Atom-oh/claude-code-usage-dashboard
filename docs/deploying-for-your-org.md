# Deploying the Dashboard for Your Organization

## 1. Confirm infrastructure prerequisites

This Terraform root **reuses an existing EKS cluster and VPC** (`infra/data.tf`). It does
not create the cluster, participant EC2 fleet, or collector sidecars. Before planning, verify:

- Existing EKS API access, OIDC provider, and a matching node IAM role discoverable by the
  `eksctl-<cluster>-nodegroup.*NodeInstanceRole.*` lookup.
- Installed Karpenter controllers/CRDs, ClickHouse and Keeper operators/CRDs, AWS Load
  Balancer Controller, and EBS CSI support with the `gp3` StorageClass.
- Private subnets/security groups tagged for Karpenter discovery; capacity for the declared
  arm64 NodePool, ClickHouse replicas, Keeper, and dashboard. Scheduling is not guaranteed
  by `replicasCount` in a manifest.
- A Route53 public zone for the domain and an issued wildcard ACM certificate in `us-east-1`.
  This stack looks them up instead of creating them.
- Terraform `>= 1.9` (`infra/providers.tf`), AWS CLI, `kubectl`, and Docker buildx capable of
  `linux/arm64`. Use the committed provider lockfile. Local app checks use Node.js >=22.

Package engines require Node.js >=22, CI uses 22, and the Docker runtime uses 24.
`scripts/setup.sh` only checks that `node` exists (its “24+” message is not a version guard)
and uses `npm install`; use the explicit `npm ci` checks below for reproducible validation.

The stack adds Karpenter resources, ClickHouse/Keeper installations, ECR, S3, dashboard
Deployment, IRSA roles, internal NLB services, and CloudFront/DNS resources. Inventory the
actual account and names before applying; do not assume a blank account is sufficient.

## 2. Configure non-secret inputs and state

From the repository root, copy the example only when no target configuration already exists:

```bash
test -e infra/terraform.tfvars || cp infra/terraform.tfvars.example infra/terraform.tfvars
```

Fill in the five non-secret inputs with no defaults: `eks_cluster_name`, `domain`,
`dashboard_hostname`, `ch_ingest_hostname`, and `dashboard_image_tag`. Set `region` and
`k8s_namespace` deliberately if the defaults are inappropriate. Keep `*.tfvars`, state, and
backend configuration out of commits. Terraform uses local state by default; secure and
back it up. Multi-operator state/backend migration is a separate planned operation using
`infra/backend.hcl.example`, not an incidental first-deploy step.

Choose an unused timestamp tag and put the same value in `dashboard_image_tag`:

```bash
TAG=$(date -u +%Y%m%d-%H%M%S)
```

A new ECR repository may not exist until apply. `wait_for_rollout = false` permits the
initial Deployment to reference this not-yet-pushed tag; temporary `ImagePullBackOff` is
expected until the build arrives. It is not a completed deployment. Terraform declares
immutable tags, but verify the actual repository after creation.

## 3. Supply secrets and collector prerequisites

Use the approved secret workflow to populate a protected, gitignored
`infra/secrets.auto.tfvars` or secret-injected Terraform variables. Required names are:

- `dashboard_basic_auth_password`
- `clickhouse_writer_password`
- `clickhouse_reader_password`
- `clickhouse_ingest_password`

Do not put credential values in examples, CLI arguments, logs, or committed files. Terraform
state can contain sensitive values even when plans mask them. Configure the dashboard's
Basic Auth username deliberately and keep self sign-up disabled.

Participant collectors require an out-of-band SSM SecureString whose value matches
`clickhouse_ingest_password`; Terraform does not create that parameter. Follow
[ingest user cutover](runbooks/clickhouse-ingest-user-cutover.md) for SSM/KMS access, effective
grants, and rotation. A changed parameter is only read at boot by the current template;
existing workshop instances retain their configuration until replaced.

## 4. Choose organization behavior

| Terraform variable | Server setting | Operational choice |
|---|---|---|
| `group_mode` | `GROUP_MODE` | `ab` or `single`; single mode changes comparison presentation, not the underlying session classifier. Default `ab`. |
| `default_range_days` | `DEFAULT_RANGE_DAYS` | Default query and cache-warmer window. Positive integer, default 2; wider ranges cost more query work. |
| `range_cap_days` | `RANGE_CAP_DAYS` | Maximum requested range, integer at least the default range; default 90. Longer requests return 400. |
| `pii_mask_enabled` | `PII_MASK_ENABLED` / `/api/config.piiMask` | Terraform defaults true; app defaults off. Controls UI email masking and conditional chat-result masking, not raw API authorization or data retention. |
| `data_stale_minutes` | `DATA_STALE_MINUTES` | Freshness threshold, default 360; server requires a positive number below its seven-day probe window. |
| `chat_model_id`, `bedrock_region` | `CHAT_MODEL_ID`, `BEDROCK_REGION` | Verify model/profile availability and applied IRSA in the calling account/region. Separate from infrastructure `region`. |
| `pricing_json`, `pricing_cache_write_ttl` | `PRICING_JSON`, `PRICING_CACHE_WRITE_TTL` | Optional token-price diagnostics. `PRICING_JSON` is inline JSON, not a file path. Keep unset values null; allowed TTL overrides are `1h` or `5m`. |

Invalid boot settings can prevent startup. Reported spend remains distinct from computed
cost diagnostics. Email masking does not make a deployment safe for audiences unauthorized
to access its raw data. For workshop account-identifier visibility, see the scoped exception
in [Workshop Studio notes](workshop-studio-notes.md).

Optional alert settings are `alert_webhook_url`, `alert_repeat_minutes`, and `alert_email`.
Follow [alerting](runbooks/alerting.md), including SNS confirmation and Secret refresh.

## 5. Validate and apply infrastructure

With target inputs and secrets available:

```bash
terraform -chdir=infra init
terraform fmt -check -recursive infra/
terraform -chdir=infra validate
terraform -chdir=infra plan
terraform -chdir=infra apply
```

Inspect additions, changes, and deletions in the plan; stop if they affect unintended shared
resources. A failed schema-init Job fails apply but can leave earlier SQL changes applied.
Do not rerun blindly: inspect Job logs and mutation load first.

## 6. Build and deploy the first image

Run app checks before building:

```bash
(cd dashboard/server && npm ci && npm test)
(cd dashboard/web && npm ci && npm test && npm run build)
bash tests/run-all.sh
```

Push the tag selected before apply, then verify rollout. These commands run from the
repository root with the intended AWS identity:

```bash
: "${TAG:?Set the same initial tag recorded in dashboard_image_tag}"
: "${KUBE_CONTEXT:?Set the target kubectl context}"
: "${REGION:?Set the ECR region}"
NAMESPACE=${NAMESPACE:-claude-code}
REPO=$(terraform -chdir=infra output -raw ecr_repository_url)
REGISTRY=${REPO%%/*}
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"
docker buildx build --platform linux/arm64 -t "$REPO:$TAG" --push dashboard/
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" set image deployment/dashboard "dashboard=$REPO:$TAG"
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" rollout status deployment/dashboard --timeout=120s
```

Follow [deployment verification](runbooks/deploy-production.md) before
declaring success. Later releases use that runbook with a new tag; Terraform ignores image
changes after the first rollout.

Verify live ECR mutability, pod probes/drain settings, current image, and CloudFront policies.
`CachingDisabled` is declared; cache invalidation is only needed if the actual edge still
serves an older cached build. A successful apply or build does not establish these settings.

For a local server investigation, `npm start`, `npm run dev`, and plain `node index.js`
do not automatically load `.env`. After preparing the protected root `.env`, load it
explicitly, or inject the environment through the approved launcher:

```bash
(cd dashboard/server && node --env-file=../../.env index.js)
```

Match `CH_URL` to the actual connection. The example's localhost port 18123 assumes a
port-forward; Docker Compose publishes ClickHouse on host port 8123. Do not change an
existing connection based on the example alone.

## 7. Verify schema and retention

Use [schema migrations](runbooks/schema-migrations.md). A fresh schema-init execution is
intended to create current tables and ledger evidence; verify completion and actual DDL.
For existing data, select the appropriate numbered operation. Migration 003 needs its
manual shadow-rollup rebuild; simply rerunning the schema file does not rebuild old history.
Migration 005 needs the ledger and special handling when the traces table is absent.

Check actual TTLs, storage policies, replica paths, pending mutations, and backup lifecycle.
`CREATE IF NOT EXISTS`, source retentions, and an API schema probe alone do not prove the
live database matches the declared schema. Use [backup and restore](runbooks/backup-and-restore.md)
to establish usable recovery coverage.

## 8. Provision participant collectors

Render `user-data.sh` for your launch-template/AMI or Workshop Studio workflow. It contains
deployment placeholders and a config-download fallback; provide the actual collector config
before expecting startup. Terraform does not provision this fleet.

Use the template's concrete systemd service: `/usr/local/bin/otelcol-contrib`,
`/etc/otelcol/config.yaml`, `EnvironmentFile=/etc/otelcol/env`, `Restart=always`, and
`RestartSec=5`. Its queue directory is `/var/lib/otelcol/queue`, selected through
`OTELCOL_QUEUE_DIR`. Do not copy a `%i` user-instance unit into an uninstantiated
`otelcol.service`, or use a foreground/`nohup` process as supervision.

Claude Code sends local OTLP/gRPC to `127.0.0.1:4317`; the collector then writes ClickHouse.
The committed exporter uses native TCP with TLS. For the CloudFront ingest route, adapt its
endpoint to the actual HTTPS ClickHouse ingress and validate the installed exporter config;
CloudFront does not proxy native ClickHouse TCP. Keep `create_schema: false`, pre-create
schema, retain the disk queue, and verify both required ingest grants.

A single-image Workshop Studio deployment also needs the identity/auth-choice adaptations
in [Workshop Studio notes](workshop-studio-notes.md); do not ship the static default group
overlay unchanged when participants choose their own login method.

## 9. Acceptance and recovery

Verify during authorized participant activity:

1. Desired dashboard, ClickHouse, and Keeper pods are Ready; direct `/readyz` returns 200.
2. Authenticated `/api/config` reflects the intended configuration and independently verified
   schema state; `/api/health/data` returns 200 when raw telemetry is fresh.
3. Raw metric/log timestamps advance, rollup buckets/retained history agree with source,
   identities and inferred groups are correct, and version cohorts are understood.
4. Reader/ingest grants are effective, credentials are absent from bootstrap logs, and any
   optional alerts deliver. Verify backup usability through an isolated restore drill.

For failure, use [incident response](runbooks/incident-response.md) and the deployment
rollback. Do not destroy shared infrastructure or data to retry installation. Archive before
tearing down a temporary account.

Basic Auth is the current baseline; edge SSO is a documented upgrade path, not an implemented
feature ([ADR-004](decisions/ADR-004-basic-auth-baseline-and-sso-upgrade-path.md)). The product
UI remains Korean. See `LICENSE` for repository usage terms.
