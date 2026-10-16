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

Before a Terraform plan, verify [existing environment inputs](../reference/iac.md#existing-environment-inputs).
Legacy node-role discovery now requires exactly one match. Existing clusters with multiple
nodegroups must set `node_role_name` to the verified deployed role; explicit lookup requires
IAM read access including `iam:GetRole`. Review any NodeClass change before applying.

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

## Reader-profile reconciliation

[dashboard.tf](../../infra/dashboard.tf) declares `CH_USER=otel_reader`; Compose uses
`default`. Verify the actual connection; declarations do not prove deployed settings.
[ADR-020](../decisions/ADR-020-cooperative-query-load-deadlines.md) enables readonly HTTP
disconnect cancellation while retaining execution/memory/result/read ceilings.

Before applying a profile change:

1. Record ClickHouse/operator versions, CHI users/profiles, pod UIDs/restarts,
   readiness, replication health and ingestion freshness. Keep manifests private:
   user configuration can contain credential hashes.
2. Review the complete Terraform plan against target state. Stop on resource replacement,
   schema-init retrigger or unrelated drift. Source checks do not establish a reconcile.
3. Establish the installed operator's behavior from its version/configuration and isolated
   rehearsal. Reconciliation can affect readiness or restart workloads; unknown effects
   block apply. Agree an ingestion/availability window and rollback first.
4. After reviewed apply, check CHI/operator events, pod UIDs/restarts and replica readiness.
   Use existing dashboard credentials; print no environment values or SQL `SETTINGS`
   overrides. Check each API pod, then connect directly to every ClickHouse replica:

```bash
verify_reader_session() {
  kube exec -i "$DASHBOARD_POD" -c dashboard -- node --input-type=module - "$@" <<'NODE'
try {
  if (process.argv[2]) {
    const url = new URL(process.env.CH_URL);
    url.hostname = process.argv[2];
    process.env.CH_URL = url.href;
  }
  const { query } = await import("/app/server/clickhouse.js");
  const rows = await query(`SELECT hostName() AS replica, currentUser() AS connection_user,
    getSetting('readonly') AS readonly,
    getSetting('cancel_http_readonly_queries_on_client_close') AS cancel_on_close,
    getSetting('max_execution_time') AS max_execution_time,
    getSetting('max_memory_usage') AS max_memory_usage,
    getSetting('max_result_bytes') AS max_result_bytes,
    getSetting('max_rows_to_read') AS max_rows_to_read`);
  console.log(JSON.stringify(rows));
  process.exit(0);
} catch { console.error("Reader-session verification failed"); process.exit(1); }
NODE
}
DASHBOARD_PODS=$(kube get pods -l app=dashboard -o name) || exit 1
: "${DASHBOARD_PODS:?No dashboard pods}"
for DASHBOARD_POD in $DASHBOARD_PODS; do
  kube wait --for=condition=Ready "$DASHBOARD_POD" --timeout=60s || exit 1
  verify_reader_session || exit 1
done

: "${CLICKHOUSE_CHI:?Set the target ClickHouseInstallation name}"
REPLICAS=$(kube get pods -l "clickhouse.altinity.com/chi=$CLICKHOUSE_CHI" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.podIP}{"\n"}{end}') || exit 1
: "${REPLICAS:?No ClickHouse replicas}"
while IFS=$'\t' read -r replica ip; do
  : "${ip:?Replica has no Pod IP}"
  kube wait --for=condition=Ready "pod/$replica" --timeout=60s || exit 1
  printf 'Checking %s\n' "$replica"
  case "$ip" in *:*) ip="[$ip]";; esac
  verify_reader_session "$ip" || exit 1
done <<< "$REPLICAS"
```

Direct probes change only the process's `CH_URL` hostname, retaining protocol/port/path.
First verify that the retained service port is also the replica's listening port and
that network policy permits dashboard-to-replica traffic. If ports differ, review a
probe variant that changes the target hostname/port, keeping credentials and TLS settings.
For TLS certificates requiring DNS, use verified replica DNS names instead of Pod IPs;
never disable certificate verification. Match each returned hostname to its replica.
Expected: `otel_reader`, readonly/cancellation `1`,
execution `60`, memory `4000000000`, result bytes `104857600`, rows read `2000000000`.
Any mismatch blocks rollout; a balanced service session cannot prove every replica.
For a failed probe, inspect private dashboard/operator logs, service `targetPort`,
replica endpoints and network policy. Keep credentials, connection URLs and query
details out of shared diagnostics.

Recheck ingestion, freshness, replica health and readiness. Use isolated synthetic
disconnect controls to observe server termination; client abort alone is insufficient.
Persistent warmer timeouts require investigation of logs, SQL and remaining server work;
there is no runtime warming-disable switch. Deadlines do not certify fleet capacity.

For an application-only regression, roll back the image and retain a verified healthy
cancellation profile. Roll back the profile only for a profile-specific reconciliation,
readiness or availability regression, through reviewed prior configuration; repeat session/
replica checks. Image rollback does not restore profiles. Disabling cancellation can leave
abandoned server work; retain readonly and resource ceilings.

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
docker buildx build --platform linux/arm64 \
  --build-arg "APP_REVISION=$(git rev-parse HEAD)" -t "$REPO:$TAG" --push dashboard/
DIGEST=$(aws ecr describe-images --region "$REGION" --repository-name "$REPO_NAME" \
  --image-ids imageTag="$TAG" --query 'imageDetails[0].imageDigest' --output text)
```

Use a new timestamp tag for each build. Do not overwrite tags or rely on `latest`.
Record `$DIGEST` as well as `$TAG` even when immutability is verified.

For a clean, committed source archive and a private provenance record, use:

```bash
python3 scripts/build-release.py --image "$REPO:$TAG" --push \
  --record "/tmp/dashboard-release-$TAG.json"
```

The helper requires Python >=3.9. It builds only Git-archived dashboard files, passes the full revision to the
runtime/OCI label and records the immutable build digest. It does not perform a rollout
or establish live ECR mutability, pod/edge state or registry signing. Keep the record
private; verify registry/pod digests using the remaining procedure.

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
[[ "$DIST_ID" =~ ^[A-Z0-9]+$ ]] || { echo "Expected one distribution ID" >&2; exit 1; }
aws cloudfront get-distribution-config --id "$DIST_ID" \
  --query 'DistributionConfig.{behavior:DefaultCacheBehavior.{cachePolicy:CachePolicyId,originRequestPolicy:OriginRequestPolicyId,headersPolicy:ResponseHeadersPolicyId},origins:Origins.Items[].{id:Id,vpcReadTimeout:VpcOriginConfig.OriginReadTimeout,customReadTimeout:CustomOriginConfig.OriginReadTimeout},errorResponses:CustomErrorResponses}'
```

Verify the dashboard origin's read timeout against the 25-second producer budget;
the declared VPC origin uses 30 seconds. Encoding and delivery are outside that budget,
so verify large responses through the actual edge before claiming a response SLO.
Read the selected policy with `aws cloudfront get-origin-request-policy --id <policy-id>`
and verify its `QueryStringsConfig` forwards all supported filters, including
`timeFormat`. Compact and legacy responses have distinct keys; only compact cost
responses are warmed, so legacy clients can still incur cold loads during rollout.

Require 403/500/502/503/504 entries with `ErrorCachingMinTTL=0`, without status/page
rewrites, matching the declared deployment contract. Verify the actual policy and origin
cache directives: AWS [error processing](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html)
documents that managed `CachingDisabled` disables cached 5xx errors, while 400/403 caching
requires positive `max-age` or `s-maxage`. Missing explicit entries alone do not
prove a live replay defect. Reconcile them through a reviewed configuration update;
other policies can retain the default ten-second error TTL.

If a previously cached build remains after rollout, invalidate the selected distribution
and wait:

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
