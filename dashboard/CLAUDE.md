# Dashboard Module

## Role
The deployable application: a Node.js Express API (`server/`) that queries ClickHouse and
serves a React SPA (`web/`) as static files. Built into one Docker image
(`dashboard/Dockerfile`) and deployed as a single k8s Deployment.

## Key Files
- `Dockerfile` -- multi-stage build (`web-build` -> `server` runtime), targets `linux/arm64`
- `docker-compose.yml` -- local dev stack (server + web)
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
