# Application instructions

The deployable application has two independent Node.js packages. Express serves
the built `web/dist` and the API from one container; there is no separate frontend host.

- Install with `npm ci` in `server/` and `web/`. Keep their lockfiles mandatory and
  dependency installation independent.
- `Dockerfile` uses a pinned Node 24 image and builds the frontend before copying it
  into the server runtime. Deployment images target `linux/arm64`.
- Docker's `HEALTHCHECK` is for Docker/Compose. Kubernetes uses the probes declared
  in `infra/dashboard.tf`; check actual deployment state when diagnosing production.
- Compose seeds a fresh ClickHouse volume only on first initialization. Removing the
  volume is destructive. Local authentication bypass does not enable the SQL chat:
  chat also requires its own authentication gate and a confirmed read-only DB session.
- Follow [server](server/AGENTS.md) and [web](web/AGENTS.md) instructions for changes.
  Use the [deployment runbook](../docs/runbooks/deploy-production.md) for rollout.
