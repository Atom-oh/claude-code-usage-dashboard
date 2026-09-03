# Dashboard Module

## Role
The deployable application: a Node.js Express API (`server/`) that queries ClickHouse and
serves a React SPA (`web/`) as static files. Built into one Docker image
(`dashboard/Dockerfile`) and deployed as a single k8s Deployment.

## Key Files
- `Dockerfile` -- multi-stage build (`web-build` -> `server` runtime), targets `linux/arm64`;
  base pinned by **digest** (the multi-arch image index digest, so it still builds on amd64),
  `npm ci` in both stages with a **mandatory** lockfile COPY (no `*`), and a `HEALTHCHECK` on
  `/readyz`
- `docker-compose.yml` -- the local full stack: a `clickhouse` service that auto-loads
  `clickhouse-schema.sql` (the single-node reference copy) and `seed/seed.sql` from
  `/docker-entrypoint-initdb.d/` on **first** init, plus a `dashboard` service built from this
  directory. `down -v` drops the named volume, which is the only way to make the init scripts run
  again. `POST /api/chat` answers 503 on this stack and that is correct -- auth is not configured
  (`AUTH_ALLOW_INSECURE=1` only disables the requirement, it does not enable chat) and the local
  `default` account is not `readonly`, so both chat gates are closed
- `server/` -- see `server/CLAUDE.md`
- `web/` -- see `web/CLAUDE.md`
- `seed/*.sql` -- demo/workshop seed data loaded into ClickHouse; not part of the app runtime,
  only used to populate a fresh ClickHouse instance for demos/testing

## Rules
- The server serves `web/dist` as static files (`express.static` + catch-all `*` route) --
  `web/` must be built (`npm run build`) before the server can serve the current frontend;
  there is no separate frontend host in any environment.
- Keep `server/` and `web/` dependency-independent (no shared `node_modules`, no monorepo
  tooling) -- they're built and versioned separately inside the Dockerfile stages.
- **`npm ci`, not `npm install`, and the lockfile COPY has no `*`.** With `npm install` and an
  optional lockfile, a missing or stale lock silently resolves fresh semver ranges at build
  time, so two builds of the same commit can ship different dependency trees. A build that is
  missing the lockfile must fail, not improvise.
- **The `HEALTHCHECK` is for `docker run` / compose only.** Kubernetes ignores a container
  image's `HEALTHCHECK` and uses the probes in `infra/dashboard.tf` (`liveness_probe` on
  `/healthz`, `readiness_probe` on `/readyz`) -- the image-level check exists so a locally-run
  container has the same readiness definition.
