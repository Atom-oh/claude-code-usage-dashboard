# Application Runtime

The dashboard ships as one image and one Express process serving API routes and the built
SPA. Infrastructure ownership is described in [IaC](iac.md); full topology is in
[architecture](../architecture.md).

## Image and local stack

[dashboard/Dockerfile](../../dashboard/Dockerfile) uses two stages with a digest-pinned
`node:24-alpine` base. The web stage runs `npm ci` and Vite build; the runtime installs
server dependencies with `npm ci --omit=dev`, copies the web output, and runs as `node`.
The EKS NodePool requires arm64. Local builds can use the host architecture because the
pinned base digest is a multi-architecture image index.

From the repository root:

```bash
docker compose -f dashboard/docker-compose.yml up -d --build
```

[Compose](../../dashboard/docker-compose.yml) starts ClickHouse 24.8 and the dashboard on
loopback port 8080. On first volume initialization it loads the single-node root schema,
then `dashboard/seed/seed.sql`; that order lets seed inserts populate the hourly view.
Existing volumes do not rerun initialization. Compose explicitly sets `AUTH_ALLOW_INSECURE=1`
and disables display masking for synthetic seed identities. It does not enable insecure chat.

## Kubernetes runtime

[infra/dashboard.tf](../../infra/dashboard.tf) defines two dashboard replicas, preferred
pod anti-affinity, a disruption budget of one available replica, and rolling updates with
zero unavailable/one surge. Each container requests 100m CPU and 128Mi, with limits of
500m CPU and 256Mi. Credentials arrive through Kubernetes Secrets; the service account
uses IRSA for the configured chat model.

The image variable seeds the first deployment. Terraform ignores subsequent image changes;
the deployment runbook's image rollout owns that field. `wait_for_rollout=false` is not
proof that the image started successfully. See [deployment](../runbooks/deploy-production.md).

CloudFront VPC origins reach internal NLB TCP listeners on port 443. In the configured
origin path, port 443 carries HTTP to dashboard port 8080 or ClickHouse port 8123; TLS
terminates at CloudFront, not at those NLB listeners. The dashboard and ingestion have
separate distributions. Inspect [dns_cdn.tf](../../infra/dns_cdn.tf) for policies and aliases.

## Health and shutdown

| Check | Behavior |
|---|---|
| `/healthz` | Unauthenticated liveness; always HTTP 200, with ClickHouse ping in `ok` |
| `/readyz` | Unauthenticated readiness; 503 if ClickHouse cannot be reached or shutdown has begun |
| `/api/health/data` | Authenticated raw-metric freshness; 503 for stale or unknown data |

The Docker healthcheck uses `/readyz`. Kubernetes configures `/healthz` for liveness and
`/readyz` for readiness. Keeping them separate avoids restarting a healthy process during
a database outage.

[index.js](../../dashboard/server/index.js) marks shutdown on SIGTERM/SIGINT, closes the
listener and force-exits after ten seconds if needed. Already-open connections can observe
not-ready status; new connections can be refused. The manifest's five-second `preStop`
and 30-second termination grace support endpoint removal and draining.

Client collectors run separately from these Kubernetes resources. Use supervised collector
startup and durable queues as described in the [incident runbook](../runbooks/incident-response.md).
Source configuration alone does not prove ingestion health or rollout completion.
