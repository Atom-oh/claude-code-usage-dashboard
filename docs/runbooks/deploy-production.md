# Runbook: Deploy the Dashboard to EKS

## Prerequisites

Run from the repository root with the intended application revision and a clean build
context. Images contain the working tree at build time. Use an isolated checkout if other
work is present. Complete the server tests and web tests/build from `.github/workflows/ci.yml`.
Stop on any failed command before continuing to a push or rollout.

The target needs an existing EKS installation and the prerequisites in
[Deploying for your organization](../deploying-for-your-org.md). Have authenticated AWS
ECR/CloudFront access, `kubectl`, Terraform state for this stack, and Docker buildx with
`linux/arm64` support. For chat, verify the deployed model/region and IRSA configuration
using [Workshop Studio notes](../workshop-studio-notes.md).

Set these non-secret parameters for the target; the namespace default matches Terraform:

```bash
: "${KUBE_CONTEXT:?Set the target kubectl context}"
: "${REGION:?Set the ECR region}"
NAMESPACE=${NAMESPACE:-claude-code}
kube() { kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }
REPO=$(terraform -chdir=infra output -raw ecr_repository_url)
REGISTRY=${REPO%%/*}
REPO_NAME=${REPO#*/}
DASHBOARD_URL=$(terraform -chdir=infra output -raw dashboard_url)
```

Terraform declares ECR `IMMUTABLE`, two dashboard replicas, readiness on `/readyz`, liveness
on `/healthz`, `preStop sleep 5`, a 30-second termination grace period, rolling update
`maxUnavailable=0`/`maxSurge=1`, preferred pod anti-affinity, and a PDB with one available
pod. **Verify these on the target; source declarations do not establish deployed state.**

```bash
aws ecr describe-repositories --region "$REGION" --repository-names "$REPO_NAME" \
  --query 'repositories[0].{uri:repositoryUri,mutability:imageTagMutability}'
kube get deployment dashboard -o yaml
kube get pdb dashboard
```

Reconcile drift through the reviewed Terraform plan before relying on those protections.
The ECR lifecycle declaration retains only ten images; confirm a rollback digest still exists.

## Procedure

### 1. Record the revision and rollback image

```bash
git status --short
git branch --show-current
git log -1 --oneline
PREVIOUS_IMAGE=$(kube get deployment dashboard -o jsonpath='{.spec.template.spec.containers[?(@.name=="dashboard")].image}')
TAG=$(date -u +%Y%m%d-%H%M%S)
```

Keep the previous image/digest with the deployment record. `dashboard_image_tag` seeds the
first rollout only: Terraform ignores subsequent image changes, which this procedure owns.
Terraform does not rebuild application images. A changed pod template rolls pods; a changed
Secret value alone requires a controlled restart to refresh environment variables.

### 2. Build and push

```bash
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"
docker buildx build --platform linux/arm64 -t "$REPO:$TAG" --push dashboard/
DIGEST=$(aws ecr describe-images --region "$REGION" --repository-name "$REPO_NAME" \
  --image-ids imageTag="$TAG" --query 'imageDetails[0].imageDigest' --output text)
```

Use a new timestamp tag for each build. Do not overwrite tags or rely on `latest`.
Record `$DIGEST` as well as `$TAG` even when immutability is verified.

### 3. Roll out and verify

```bash
kube set image deployment/dashboard "dashboard=$REPO:$TAG"
kube rollout status deployment/dashboard --timeout=120s
kube get pods -l app=dashboard -o wide
kube get deployment dashboard -o jsonpath='{.spec.template.spec.containers[?(@.name=="dashboard")].image}'
kube logs -l app=dashboard --tail=50 --prefix
```

Expect all desired replicas Ready on the intended image. Investigate a timeout before
retrying. Use a separate terminal for the foreground port-forward:

```bash
kube port-forward deployment/dashboard 8080:8080
```

Then check the pod directly:

```bash
curl --fail --silent --show-error http://127.0.0.1:8080/healthz
curl --fail --silent --show-error http://127.0.0.1:8080/readyz
```

Both should return 200. `/readyz` also depends on ClickHouse connectivity and shutdown state;
`/healthz` alone does not establish readiness or telemetry freshness. Check authenticated
`/api/config` and `/api/health/data`, then load the public UI and confirm its asset hashes
match the built image. The Docker build's frontend assets are authoritative; a stale local
`dashboard/web/dist` is not.

### 4. Check the edge and invalidate only when needed

`infra/dns_cdn.tf` declares `CachingDisabled`. Do not assume the live distribution caches
`index.html` or that it already has this policy. Select the distribution by exact alias:

```bash
DASHBOARD_HOST=${DASHBOARD_URL#https://}
DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Aliases.Items && contains(Aliases.Items, '$DASHBOARD_HOST')].Id" \
  --output text)
: "${DIST_ID:?No matching dashboard distribution}"
aws cloudfront get-distribution-config --id "$DIST_ID" \
  --query 'DistributionConfig.DefaultCacheBehavior.{cachePolicy:CachePolicyId,headersPolicy:ResponseHeadersPolicyId}'
```

Stop if the alias lookup returns multiple IDs. If a previously cached build remains after
rollout, invalidate the selected distribution and wait:

```bash
INV_ID=$(aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' \
  --query 'Invalidation.Id' --output text)
aws cloudfront wait invalidation-completed --distribution-id "$DIST_ID" --id "$INV_ID"
```

## Rollback

Redeploy the recorded known-good image, or use deployment history after confirming the prior
revision and its image still exist:

```bash
: "${PREVIOUS_IMAGE:?Recover the recorded known-good image first}"
kube set image deployment/dashboard "dashboard=$PREVIOUS_IMAGE"
kube rollout status deployment/dashboard --timeout=120s
```

`kube rollout undo deployment/dashboard` is the history-based alternative. Recheck the edge
and health endpoints. Image rollback does not undo Terraform, Secret, or schema changes.

## Schema and boot failures

Follow [schema migrations](schema-migrations.md) separately. The schema-init Job name embeds
the replicated SQL file's hash; a changed file causes a new Job on apply. Terraform waits
for completion, but background mutations and actual DDL still require independent checks.
A failed `--multiquery` run stops at its first failing statement; earlier statements may
already have executed. Inspect Job logs before retrying costly materializations.

A boot failure requiring `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` is intentional. Verify
Secret `dashboard-basic-auth` keys without printing values and restart after correction.
Do not use `AUTH_ALLOW_INSECURE=1` to recover a deployed environment. For backup retention
and pre-teardown archival, use [backup and restore](backup-and-restore.md).
