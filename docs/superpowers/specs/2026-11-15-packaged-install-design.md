# Packaged installation: Helm chart, public Terraform (ECS/EKS) and release bundles

Status: approved 2026-11-17 (draft 2026-11-15, builder check incorporated). Phase 1 plan: `docs/superpowers/plans/2026-11-17-packaged-install-phase1-images.md`.

## Intent

The repository is public. Customer organizations should be able to install the dashboard
in their own AWS account without building from source or editing Terraform written for
the `fsi-demo-cluster` production installation. Every GitHub release therefore carries
ready-to-install artifacts. The customer picks ECS or EKS and chooses a sizing preset
(standard, high availability, performance). On EKS the same thing is available as a plain
Helm chart for teams that deploy through Helm or GitOps.

Customer environments commonly block public container registries (public ECR, Docker Hub).
Images therefore ship as GitHub release assets that the customer loads into a private ECR.
Public registries are not part of the install path.

## Decisions made by the user

- **ClickHouse is out of scope.** The customer supplies ClickHouse: self-managed, Altinity
  on their cluster, ClickHouse Cloud, or anything else that speaks the protocol. The package
  takes connection settings only, on both ECS and EKS.
- **Deployment targets:** ECS and EKS.
- **The Helm chart is the source of truth for Kubernetes workloads** (approach 1 below).
  Our own production `infra/` moves from hand-declared Kubernetes resources to a
  `helm_release` of this chart.
- **A public Terraform root handles both targets** and selects one with a variable
  (`platform = "ecs" | "eks"`). On EKS it installs the Helm chart.
- **Distribution is GitHub Releases** on the free plan, with no public registry.
- **arm64 images only.** EKS installs need arm64 (Graviton) nodes; ECS uses Fargate ARM64.
- **Images are made smaller** before they are packaged (see Images).
- **Production runs the release images.** Production deploys the digest-pinned `vX.Y.Z`
  images built by the release workflow, including the OCB receiver collector, loaded into
  our ECR with `push-images.sh`. A local untagged build stays the exception path for fixes
  that cannot wait, reported as untagged (deploy skill Step 0.4).
- **License:** FSL-1.1-ALv2 (PR #300). Bundles carry it.
- **Two release channels.** A `vX.Y.Z` tag produces the public release assets and is the
  only source for production. Every push to `main` deploys only the dashboard to a
  separate dev installation, `ccdash-dev`, which shares production ClickHouse read-only
  (see Dev installation).

## Goals

- A customer goes from downloaded release assets to a working dashboard with
  `push-images.sh` followed by either `terraform apply` or `helm install`, without cloning
  the repository.
- A `preset` input sets replicas and stability features. Explicit `replicas` and
  `resources` inputs override the preset.
- Production consumes the same chart, so the published chart is exercised every deploy.
- Release assets are reproducible from the tag and verifiable (checksums plus GitHub build
  provenance attestation).

## Non-goals

- Installing or operating ClickHouse, Keeper, backups of ClickHouse, or ClickHouse cold
  storage. Production keeps those in `infra/` as operator-specific layers.
- Creating VPCs, EKS clusters, Karpenter pools or Cognito user pools. The package takes
  existing IDs as inputs.
- amd64 images and public registry publishing.
- Exposing the customer's ClickHouse to participants. The packaged ingest path is the
  OTLP receiver. A direct participant-collector-to-ClickHouse path (`collector-config.yaml`)
  stays available but is the customer's own ClickHouse exposure.

## Anti-goals

These would make the work a failure even if it technically works.

- The chart and production drift apart: production deploys something the published chart
  cannot reproduce.
- The public Terraform creates internet-facing load balancers, `0.0.0.0/0` / `::/0`
  ingress, public IPs on tasks or nodes, or a VPC.
- The production cut-over to Helm recreates the dashboard or receiver Deployments, causes
  downtime, or changes immutable selectors.
- A customer must reach a public registry to install.
- Bundles or defaults leak installation-specific values: account IDs, hostnames,
  `custom:department` values, emails.

## Constraints

- Public entry stays CloudFront → CloudFront VPC origin → **internal** ALB/NLB. The public
  Terraform offers this as its exposure mode, or no exposure (the customer brings their own
  ingress). Load balancer security groups admit only the CloudFront VPC-origin security
  group or the CloudFront managed prefix list.
- Workloads run in private subnets supplied as inputs.
- If the public Terraform ever creates an identity pool it must set `selfSignUpEnabled=false`.
  The current design takes an existing OIDC issuer instead.
- Existing contracts in `AGENTS.md` still hold: masking is not access control,
  `CLAUDE_ENABLED`/`CODEX_ENABLED` cannot both be false, and so on. The chart exposes the
  same environment settings `infra/dashboard.tf` sets today.
- Sessions are encrypted stateless cookies (`dashboard/server/auth.js`), so more than one
  dashboard replica needs no stickiness. Each replica keeps its own result cache and runs
  its own cache warmer. Raising replicas therefore multiplies warmer load on ClickHouse.
  The presets must account for this.
- Releases stay batched. Bundles build from an existing `vX.Y.Z` tag, and the workflow
  attaches assets to the release; tagging is not automated.
- The bundle carries `LICENSE` (FSL-1.1-ALv2) and the third-party notices.
- Ingest topology matches production. The OTLP receiver is never exposed. It accepts a
  shared internal bearer token, and only the dashboard reaches it: a NetworkPolicy on EKS,
  security groups plus ECS Service Connect on ECS. The dashboard authenticates each
  device token against DynamoDB and forwards to `INGEST_UPSTREAM_URL`. Device ingest
  requires OIDC, as `infra/device_ingest.tf` does today. Basic-auth installs get no
  packaged device-ingest path; they can still use the direct collector configuration
  against their own ClickHouse.
- Secret values never enter Terraform state. On EKS, inputs name existing Kubernetes
  Secrets (production's pattern, `identity.tf`/`device_ingest.tf`), and the docs show an
  External Secrets example as optional. On ECS, inputs are Secrets Manager ARNs that task
  definitions reference.

## Approaches considered

1. **The chart is the source of truth, and production uses it (chosen).** EKS installs via
   `helm install` or the public Terraform. ECS installs via the public Terraform's ECS
   module. Shared AWS resources live in a Terraform `aws-base` module. Production `infra/`
   replaces its Deployment, Service, ConfigMap and PDB resources with `helm_release`.
   Cost: a one-time migration of live resources from Terraform to Helm.
2. **Leave production Terraform alone and build the chart and ECS module only for
   distribution.** No production risk, but the configuration is duplicated and production
   fixes would not reach the package. Rejected for drift.
3. **One Terraform with a platform switch and no standalone chart.** Simplest for
   Terraform users, but awkward for Helm/GitOps users. The chosen design keeps this
   experience as the public Terraform root on top of approach 1.

## Design

### Repository layout

```text
deploy/
  helm/ccdash/                  # chart (source of truth for Kubernetes workloads)
  terraform/
    modules/aws-base/           # IAM (Bedrock, DynamoDB), DynamoDB tables, Secrets Manager entries
    modules/ecs/                # Fargate ARM64 services, internal ALB, schema task
    modules/eks/                # helm_release of the chart, IRSA/Pod Identity bindings
    modules/edge/               # optional CloudFront VPC origin + Route53 for an internal LB
    main.tf variables.tf ...    # public root: platform = "ecs" | "eks"
    examples/{ecs,eks}.tfvars.example
  schema/                       # canonical ClickHouse schema + runner (moved, see Schema)
  scripts/push-images.sh
collector-build/                # OCB manifest for the custom receiver collector
.github/workflows/release-bundle.yml
```

`infra/` stays the production operator root. It keeps ClickHouse (CHI/CHK), Karpenter,
backups and the backup monitor, alerting and the existing CloudFront distributions. It
calls the chart through `helm_release` and `modules/aws-base`, and optionally
`modules/edge` if its resources can be adopted without replacement.

### Components the package installs

| Component | EKS (chart) | ECS (module) |
|---|---|---|
| Dashboard (UI + API, one image) | Deployment, ClusterIP Service, optional internal LoadBalancer Service, PDB, optional HPA | Fargate service behind an internal ALB |
| OTLP receiver (custom collector) | Deployment, ClusterIP Service, PDB, NetworkPolicy (dashboard only), ConfigMap | Fargate service reachable only from the dashboard over Service Connect (OTLP HTTP 4318) |
| Schema install / upgrade check | Helm hook Job | One-off ECS task, run and awaited by Terraform |
| AWS resources | `aws-base` (via Terraform) or documented prerequisites for helm-only users | `aws-base` |

The receiver's device-token DynamoDB table and the insights table move into `aws-base`.
Bedrock access (chat/analysis models) is an optional toggle in `aws-base` and the chart.

### Presets

`preset` is one of `standard`, `high-availability`, `performance`. Default is `standard`.

| Setting | standard | high-availability | performance |
|---|---|---|---|
| Dashboard replicas / ECS desired count | 1 | 2 | 3 (fixed) |
| Receiver replicas | 1 | 2 | 3 (fixed) |
| PDB (EKS) | none | minAvailable 1 | minAvailable 1 |
| Spread | none | zone + hostname topology spread (EKS); ≥2 AZ subnets required (ECS) | same as HA |
| Rollout | default | maxUnavailable 0; ECS minimum healthy 100% + circuit breaker rollback | same as HA |
| Dashboard resources | today's production requests/limits (256Mi) | same | larger memory and CPU, Node heap raised to match |

Explicit `replicas.*`, `resources.*` and `autoscaling.*` inputs override any preset value.
No preset autoscales. Every dashboard replica runs its own result cache and warmer, so
ClickHouse load grows with the replica count. HPA (EKS) and ECS service autoscaling are
opt-in, and the docs warn about that load. A per-replica warmer switch is a possible later
server change, not part of this work.
The presets only cover the application tier. The chart's README links a recommended
ClickHouse reader profile, taken from the `infra/clickhouse.tf` readonly profile, for the
customer to apply to their ClickHouse.

### Schema

The current schema (`infra/files/clickhouse-schema-replicated.sql`) assumes
`ON CLUSTER 'replicated'`, `ReplicatedMergeTree` ZooKeeper paths, and
`storage_policy='hot_cold'` with cold-volume TTLs. Customer ClickHouse may be a single node
or ClickHouse Cloud. The schema runner takes:

- `schema.mode`: `replicated` (with `schema.cluster`) or `single`. ClickHouse Cloud uses
  `single`, because the service converts MergeTree engines itself.
- `schema.coldStoragePolicy`: optional. When unset, the schema emits no storage policy and
  no volume-move TTL.

The schema step installs a fresh database automatically. On an existing database it
only verifies the contract (`clickhouse-schema-contract.sql`). If a migration is needed it
fails closed and points to `docs/runbooks/schema-migrations.md`; migrations 002-011 stay
manual. The runner is rewritten to run over the ClickHouse HTTP interface using the
dashboard image's Node, with TLS support. That removes the Docker Hub
`clickhouse/clickhouse-server` image from the job and supports ClickHouse Cloud.

The canonical schema files have exactly one copy. Production `infra/` and the package read
the same files, and production renders `replicated` with its cold policy. Required
ClickHouse users and grants (writer for schema, ingest for the receiver, reader for the
dashboard) are documented as customer prerequisites, and the installer verifies them
before running.

### Images

- **Dashboard:** the runtime stage starts from plain Alpine and copies only the Node
  binary. That removes about 20 MB of npm/yarn/headers that today stay in the base layer
  despite the later `rm`. The server is bundled with esbuild, so `node_modules` (36 MB, of
  which 27 MB is AWS SDK) is replaced by the bundled output. `collect-notices.mjs` and
  `verify-runtime.mjs` must still produce complete third-party notices and runtime checks
  for what is actually bundled. The measured baseline is 195 MB uncompressed / 69 MB
  gzipped (image `20261115-025552`); the estimate is about 145 MB / 50 MB, to be measured.
- **Receiver:** a custom collector built with the OpenTelemetry Collector Builder,
  containing only the components the receiver and device policies use. It replaces
  `otel/opentelemetry-collector-contrib` (345 MB uncompressed), so customers never pull
  from Docker Hub. The version tracks `dashboard/collector/release.json`.
- Both images are `linux/arm64`, tagged `vX.Y.Z`, and saved as one OCI archive.

### Release assets

The `release-bundle.yml` workflow runs on an `ubuntu-24.04-arm` runner. It is triggered
when a `vX.Y.Z` release is published, or manually for an existing tag. It builds and
uploads:

- `ccdash-vX.Y.Z.tar.gz`: chart, public Terraform, schema, collector packages (the
  existing `build-packages.mjs` output), install guide, license and notices, and a
  manifest of image digests.
- `ccdash-chart-vX.Y.Z.tgz`: the `helm package` output, for `helm install ./file.tgz`.
- `ccdash-images-vX.Y.Z-arm64.tar.gz`: the OCI archive of both images.
- `SHA256SUMS` and build provenance attestations for each asset.

`push-images.sh <registry>` copies the archive into the customer's private ECR,
preserving digests, and prints the digest-pinned image references for tfvars or values.
Chart and Terraform defaults reference images by digest, never by a mutable tag.

### Public Terraform root

Inputs, beyond `platform` and `preset`:

- Network and region: region, `vpc_id`, private subnet IDs.
- ClickHouse connection: URL, database, the three credentials (as Secrets Manager ARNs or
  values), and the schema options.
- Image references.
- Feature toggles mirroring today's dashboard settings: clients, masking, Bedrock models,
  insights.
- Auth: Basic or OIDC issuer/client.
- Exposure: `edge` (CloudFront + internal LB, needing an ACM certificate ARN and a hosted
  zone) or `none`.
- EKS only: cluster name, namespace, and the service-account identity mode.

The root never creates a VPC, an EKS cluster, or public-facing listeners.

### Production migration (`infra/`)

- The chart moves these objects: the dashboard and receiver Deployments, the receiver
  ConfigMap/ClusterIP Service/NetworkPolicy, the PDBs and the dashboard ServiceAccount
  (keeping the IRSA annotation). These stay in Terraform: the `dashboard-nlb` and
  `clickhouse-ingest-nlb` LoadBalancer Services (CloudFront VPC origins reference their
  NLB ARNs, so recreating them would break the edge), the existing Secrets, the CHI/CHK,
  backups and the schema Job. Production sets `service.loadBalancer.enabled=false`. After
  the cut-over, the schema Job moves to the chart in a separate step.
- Production images come from the release workflow (see Decisions). The deploy runbook
  and deploy skill switch to downloading `ccdash-images-vX.Y.Z-arm64.tar.gz`, verifying
  `SHA256SUMS` and the attestation, running `push-images.sh` into our ECR, and setting the
  digest in `helm_release` values.
- The chart must render the current production Deployments' immutable selector labels
  exactly (`app=dashboard`, the receiver's existing labels), so Helm adopts the live
  objects instead of replacing them.
- The cut-over:
  1. Annotate and label the existing objects for Helm ownership (`meta.helm.sh/release-*`,
     `app.kubernetes.io/managed-by=Helm`).
  2. Release them from Terraform with `removed { lifecycle { destroy = false } }` blocks.
  3. Apply `helm_release` from current `main`.
  4. Confirm that the pods were not restarted, or were rolled only once by an intended
     template change.
- The cut-over is its own PR with a written runbook step, executed only with user approval.

### Dev installation (`ccdash-dev`)

- **What runs:** only the dashboard, from the same chart with `preset: standard`, in
  namespace `claude-code-dev` on the existing cluster and NodePool. It is served at
  `ccdash-dev.<domain>` through its own CloudFront distribution, a VPC origin and an
  internal LB (same edge rules as production).
- **What does not run:** no receiver, no schema job, no backups, no alerting. Dev never
  changes ClickHouse schema or data.
- **Shared ClickHouse, isolated load:** dev connects to the production ClickHouse service
  as a separate user, `otel_reader_dev`. It is read-only with `GRANT SELECT ON
  claude_code.*` and a lower-priority profile:
  - `max_memory_usage` 2GB and `max_memory_usage_for_user` 4GB;
  - a low `max_concurrent_queries_for_user`;
  - `priority` below production's;
  - the same execution, result and scan ceilings as production.
  
  The cache warmer is off in dev. That needs a small server change: an env switch that
  disables the warmer, defaulting to on.
- **Separate state:** dev has its own DynamoDB tables for settings, team mapping and
  insights, so dev settings never change production.
- **Access:** the production Cognito pool with a separate app client and callback URL,
  limited to the administrator group, because dev shows real telemetry.
- **Pipeline:** a push to `main` runs CI. If CI passes, it builds the arm64 image, pushes
  it to a dev ECR repository, and rolls the dev release by digest. GitHub Actions
  authenticates to AWS with an OIDC role. Its trust is limited to this repository's
  `main` branch and the `dev` environment, so fork PRs cannot assume it. Its permissions
  are limited to the dev ECR repository and to deploying into `claude-code-dev` (an EKS
  access entry scoped to that namespace).
- **Production stays manual:** a tag builds the release assets. Production deploys them
  after approval, as today.

## Phasing (proposed order)

1. Image slimming and the OCB receiver collector, verified against current production
   behavior.
2. Schema modes (`single` / `replicated`, optional cold policy) with one canonical copy,
   and the HTTP schema runner.
3. Helm chart with presets and chart tests (`helm lint`, `helm template` golden or
   kubeconform).
4. `ccdash-dev`: the first real install of the chart, dashboard only, with the
   `otel_reader_dev` user, the warmer switch and the main-branch pipeline. Running the
   chart in dev first takes risk out of the production cut-over.
5. Public Terraform: `aws-base`, `eks`, `ecs`, `edge` and the root `platform` switch,
   validated with `terraform validate` and a plan against fixtures.
6. Release workflow and `push-images.sh`, exercised on a release candidate tag, or as a
   manual run on an existing tag with upload disabled.
7. Production cut-over of `infra/` to `helm_release` and release images (separate
   approval).
8. An end-to-end customer-style install on a scratch ECS service and a scratch EKS
   namespace against a test ClickHouse, then teardown.

## Left to the builder

- Exact chart value names and template structure; NetworkPolicy defaults.
- How Terraform runs and waits for the ECS schema task (for example `terraform_data` with
  `aws ecs run-task`, waiting on the task and checking the exit code).
- Which collector components the OCB manifest needs (derived from the generated
  central/local configs).
- Which tool preserves digests when copying the OCI archive (crane, skopeo or regctl,
  vendored or required as a prerequisite).
- Test fixtures and CI wiring for chart and Terraform checks, following `tests/run-all.sh`
  conventions.
