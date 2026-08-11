# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview
Claude Code Usage Dashboard — an internal telemetry pipeline and web dashboard for an
AWS Workshop Studio A/B scenario comparing Claude Code usage via Bedrock vs. Claude
Enterprise. Claude Code instances export OpenTelemetry metrics/logs to a ClickHouse
cluster on EKS; a Node.js API aggregates cost, adoption, and productivity KPIs, and a
React SPA renders them. bedrock/enterprise group membership is inferred per-session from
telemetry (no static experiment flag), since participants can pick their auth method at
login.

## Tech Stack
- **Server**: Node.js (ESM), Express, `@clickhouse/client`, `@aws-sdk/client-bedrock-runtime`
- **Web**: React 18, Vite, Tailwind CSS, Recharts, react-router-dom, react-markdown
- **Data**: ClickHouse (ReplicatedMergeTree, hot/cold storage policy, S3 cold tier), fed by an
  OpenTelemetry Collector (`collector-config.yaml`) receiving Claude Code's native OTel export
- **Infra**: Terraform on AWS (EKS/Graviton nodepool, ECR, S3, Route53/CloudFront, ClickHouse
  Kubernetes Operator) — see `infra/`
- **CI**: GitHub Actions multi-AI PR review (`.github/workflows/pr-review.yml`), orchestrated by
  scripts under `scripts/pr-review/`

## Architecture

Request/data flow, in order — understanding this end-to-end matters more than any single file:

1. Claude Code clients export native OTel metrics/logs (and, since 2026-08-11, beta traces) to
   a local `otelcol-contrib` sidecar (`collector-config.yaml`), which writes them into
   ClickHouse (`otel_metrics_sum`, `otel_logs`, `otel_traces`). Claude Code never talks to
   ClickHouse directly, and Claude Code never talks to `dashboard/server` directly either —
   the collector is the only write path, and it runs outside the EKS cluster on each
   participant's EC2 instance (`user-data.sh`), not as a cluster workload.
2. `dashboard/server` is the only reader. `queries.js` holds one exported function per API
   endpoint (`index.js` just does routing/caching/range-parsing); `grouping.js` infers
   bedrock/enterprise per session; `pricing.js`/`productivity.js`/`costEfficiency.js` are pure
   functions applied to query results. `chat.js` is the one place an LLM (via Bedrock) writes
   its own ClickHouse SQL, sandboxed by `sanitizeSql()` + `readonly=1`.
3. `dashboard/web` is a React SPA that calls `dashboard/server`'s `GET /api/*` routes and is
   served as static files by that same Express process (one image, one process — see
   `dashboard/CLAUDE.md`).
4. `infra/` (Terraform) provisions the EKS cluster the server/web image runs on and the
   ClickHouse Operator cluster it queries — but does **not** provision the EC2 fleet or the
   collector sidecar; that's `user-data.sh` + `scripts/setup-test-telemetry.sh` (tester
   self-service path), which are separate from the Terraform-managed pieces.

Module-local `CLAUDE.md` files (`dashboard/server/`, `dashboard/web/`, `infra/`) have the
per-module rules; `docs/reference/*.md` has layer-by-layer implementation detail;
`docs/architecture.md` has the full diagram.

## Project Structure
```
dashboard/           - The application (deployed as a single Docker image)
  server/            - Express API + ClickHouse query layer
  web/               - React SPA (Vite build, served as static files by server/)
  seed/              - Demo/workshop seed data (SQL) for ClickHouse
infra/               - Terraform: EKS, ClickHouse operator, ECR, DNS/CDN, dashboard deployment
docs/                - Architecture docs, ADRs, runbooks, implementation reference
site/                - Public docs site published to GitHub Pages (static HTML, no build step;
                       deployed by .github/workflows/pages.yml). Curated + sanitized — no account
                       IDs, no hostnames, participant labels anonymized in the screenshots
video/               - HyperFrames project that renders site/assets/video/dashboard-demo.mp4
                       (npx hyperframes, Node >= 22; renders/ + snapshots/ are gitignored)
scripts/             - Operational scripts (setup, git hooks, PR review automation)
grafana-ab-queries.sql   - Legacy Grafana panel queries (kept in sync with dashboard/server SQL)
clickhouse-schema.sql   - Reference schema for otel_metrics_sum / otel_logs / otel_traces (beta)
clickhouse-migration-002.sql - Additive migration (2026-08-11 telemetry spec sync); run this
                       directly against the live cluster, it's not applied by Terraform
collector-config.yaml   - OpenTelemetry Collector config (Claude Code -> ClickHouse)
.claude/             - Claude Code settings, hooks, skills (gitignored — local tooling only)
```

## Conventions
- **No comments unless the WHY is non-obvious.** This codebase leans heavily on comments that
  document measured behavior (`실측 확인: ...`), known ClickHouse quirks, and deliberate
  trade-offs (`ponytail: ...`) — keep that style, don't add narration comments.
- **Cumulative OTel temporality**: `otel_metrics_sum` values are cumulative per-session
  counters, not deltas. Never `sum(Value)` directly — always diff via the `incFlat`/`incBucketed`
  helpers in `dashboard/server/queries.js` (session-boundary diff, matching Prometheus
  `increase()`). Direct summing has caused 100x+ overcounting in the past.
- **Don't trust Claude Code's own telemetry docs without checking live data first.** The
  2026-08-11 spec sync found `code.claude.com/docs/en/monitoring-usage.md` missing several
  events actually being emitted — schema/query changes there are keyed to a measured attribute
  census (`SELECT arrayJoin(mapKeys(Attributes)) ...`), not the docs alone. See
  `docs/decisions/ADR-001-*.md` / `ADR-002-*.md` for the two non-obvious trade-offs from that
  sync (why `incFlat`/`incBucketed` weren't extended for the new `AppVersion`/`EndUserId`
  dimensions, and why the Bedrock-identity fallback only covers new queries, not all ~90
  pre-existing `UserEmail` references).
- **bedrock/enterprise grouping is session-scoped**, not user-scoped — one user can straddle
  both in different sessions. See `dashboard/server/grouping.js` for the heuristic and its
  measured edge cases.
- **Model name normalization**: Bedrock region/date/version suffixes are stripped so the same
  model shows as one row in cost/usage breakdowns — see `normModel()` in `queries.js` and
  `normalizeModelId()` in `pricing.js` (kept in sync, same 5-step regex rules).
- Server code is plain ESM, no build step, no TypeScript. Web code is React + Tailwind, no CSS
  modules. Keep both minimal — this is a workshop dashboard, not a product.
- SQL changes to promoted/materialized columns (`otel_metrics_sum`, `otel_logs`) must be
  mirrored in `grafana-ab-queries.sql` if that query file references the same metric — a past
  review caught these drifting out of sync.
- **The OTel Collector must run as a supervised systemd service (`Restart=always`), never
  foreground/`nohup`.** If it dies (DNS blip, node reboot, crash), the dashboard shows a
  silently shrinking data window with no error anywhere — this has already caused an
  unnoticed ~43h telemetry gap in production. See the "Telemetry Ingestion" section of
  `README.md` for the exact unit file and how to verify it's actually writing
  (`SELECT max(TimeUnix) FROM claude_code.otel_metrics_sum`).

## Key Commands
```bash
# Server (dashboard/server)
npm install
npm start                 # node index.js
npm run dev               # node --watch index.js
node --test *.test.js     # all unit tests (node:test, no framework, no separate runner)
node --test queries.test.js          # a single test file
node --test --test-name-pattern="incFlat" *.test.js   # tests matching a name

# Web (dashboard/web)
npm install
npm run dev               # vite dev server
npm run build             # vite build -> dist/ (no dedicated web test suite yet)
npm run preview

# Claude Code harness tests (hooks, settings.json, repo structure — not app logic)
bash tests/run-all.sh              # all
bash tests/run-all.sh hooks        # only hooks/*.sh tests (pattern matches subdir/filename)

# Local full stack
docker compose -f dashboard/docker-compose.yml up

# Deploy (see docs/runbooks/deploy-production.md)
docker buildx build --platform linux/arm64 -t <ecr-repo>:<tag> --push dashboard/
kubectl --context <cluster> -n claude-code set image deployment/dashboard dashboard=<ecr-repo>:<tag>
kubectl --context <cluster> -n claude-code rollout status deployment/dashboard

# Infra (infra/)
terraform plan
terraform apply
```

---

## Auto-Sync Rules

Rules below are applied automatically after Plan mode exit and on major code changes.

### Post-Plan Mode Actions
After exiting Plan mode (`/plan`), before starting implementation:

1. **Architecture decision made** -> Update `docs/architecture.md`
2. **Technical choice/trade-off made** -> Create `docs/decisions/ADR-NNN-title.md`
3. **New module added** -> Create `CLAUDE.md` in that module directory
4. **Operational procedure defined** -> Create runbook in `docs/runbooks/`
5. **Changes needed in this file** -> Update relevant sections above

### Code Change Sync Rules
- New directory under `dashboard/server/`, `dashboard/web/src/`, or `infra/` -> create/update the
  nearest `CLAUDE.md`
- New API route in `dashboard/server/index.js` -> update `dashboard/server/CLAUDE.md`
- ClickHouse schema/materialized column changed -> update `clickhouse-schema.sql`,
  `grafana-ab-queries.sql`, and `docs/architecture.md` Infrastructure section
- Terraform changed under `infra/` -> update `docs/architecture.md` Infrastructure section and
  `infra/CLAUDE.md`

### ADR Numbering
Find the highest number in `docs/decisions/ADR-*.md` and increment by 1.
Format: `ADR-NNN-concise-title.md`

<!-- AUTO-MANAGED:references -->
## Implementation References
- [docs/reference/INDEX.md](docs/reference/INDEX.md) — layer-by-layer implementation notes
  (infrastructure, data, api, iac, frontend, ui, security)
<!-- /AUTO-MANAGED:references -->
