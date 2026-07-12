# Developer Onboarding

## Quick Start

### 1. Prerequisites
- [ ] Node.js 24+ installed (matches `dashboard/Dockerfile`'s `node:24-alpine`)
- [ ] `kubectl` and `aws` CLI, if you'll deploy or debug against the live cluster
- [ ] `terraform` 1.x, if you'll touch `infra/`
- [ ] Repository access granted (github.com/Atom-oh/claude-code-usage-dashboard)
- [ ] Access to the `fsi-demo-cluster` EKS context and the `clickhouse-reader` k8s Secret, if
      you need to query live telemetry data

### 2. Setup
```bash
git clone git@github.com:Atom-oh/claude-code-usage-dashboard.git
cd claude-code-usage-dashboard
bash scripts/setup.sh
```
This installs dependencies for both `dashboard/server` and `dashboard/web`. See
`scripts/setup.sh` for what it does step by step.

For local full-stack testing without a live cluster:
```bash
cd dashboard
docker compose up
```

### 3. Verify
```bash
cd dashboard/server && node --test *.test.js
cd ../web && npm run build
```
Both should succeed with no errors before you start making changes.

## Project Overview
- Read [`CLAUDE.md`](../CLAUDE.md) for project context and conventions
- Read [`docs/architecture.md`](architecture.md) for system design
- Read [`docs/reference/INDEX.md`](reference/INDEX.md) for layer-by-layer implementation notes
- Review [`docs/decisions/`](decisions/) for architectural decisions (empty until the first ADR is recorded)

The single most important thing to internalize before touching `dashboard/server/queries.js`:
**`otel_metrics_sum` values are cumulative, not deltas.** Read the `incFlat`/`incBucketed`
comments in that file before writing any new aggregation query.

## Development Workflow
- Branch naming: `feat/`, `fix/`, `docs/`, `refactor/`
- Commit convention: Conventional Commits (`feat:`, `fix:`, `docs:`, ...)
- PR process: opened against `main`; `.github/workflows/pr-review.yml` runs a multi-AI review
  panel and blocks merge on CRITICAL/MAJOR findings

## Key Concepts
- **Cumulative OTel counters**: see `docs/reference/data.md`
- **Session-scoped bedrock/enterprise grouping**: see `docs/reference/data.md` and
  `dashboard/server/grouping.js`
- **Global range/filter context**: every page shares one `from`/`to`/`group`/`user`/`model`
  state; see `docs/reference/frontend.md`

## Troubleshooting
- **Query returns 0 rows unexpectedly**: check whether a global filter (especially `model`)
  is silently excluding rows on a table without that promoted column — see the `ponytail:`
  comment above `filterCond()` in `queries.js`.
- **New chart shows one bar/point on short date ranges**: check that the page re-syncs its
  local `intervalHours` state from the global range context via `useEffect`, not just a
  `useState` initializer.
- **Local server can't reach ClickHouse**: you likely need to port-forward
  `svc/clickhouse-cc-ab` and fetch the `clickhouse-reader` secret — see
  `docs/runbooks/deploy-production.md`'s verification note.

## Resources
- Repository: https://github.com/Atom-oh/claude-code-usage-dashboard
- Workshop notes: [`docs/workshop-studio-notes.md`](workshop-studio-notes.md)
