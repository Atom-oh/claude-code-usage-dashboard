# Project Context

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

## Project Structure
```
dashboard/           - The application (deployed as a single Docker image)
  server/            - Express API + ClickHouse query layer
  web/               - React SPA (Vite build, served as static files by server/)
  seed/              - Demo/workshop seed data (SQL) for ClickHouse
infra/               - Terraform: EKS, ClickHouse operator, ECR, DNS/CDN, dashboard deployment
docs/                - Architecture docs, ADRs, runbooks, implementation reference
scripts/             - Operational scripts (setup, git hooks, PR review automation)
grafana-ab-queries.sql   - Legacy Grafana panel queries (kept in sync with dashboard/server SQL)
clickhouse-schema.sql   - Reference schema for otel_metrics_sum / otel_logs
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

## Key Commands
```bash
# Server (dashboard/server)
npm install
npm start                 # node index.js
npm run dev               # node --watch index.js
node --test *.test.js     # unit tests (node:test, no framework)

# Web (dashboard/web)
npm install
npm run dev               # vite dev server
npm run build             # vite build -> dist/
npm run preview

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
