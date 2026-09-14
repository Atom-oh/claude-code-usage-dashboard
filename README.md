# Claude Code Usage Dashboard

[![CI](https://github.com/Atom-oh/claude-code-usage-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/Atom-oh/claude-code-usage-dashboard/actions/workflows/ci.yml)

A workshop dashboard for selectable Claude Code and Codex usage. Claude Code supports
Amazon Bedrock and Claude Enterprise channels; Codex uses Bedrock Mantle or Runtime.
Claude metrics and Codex structured OpenTelemetry logs flow through a collector into
ClickHouse; an Express API serves both the data and a React SPA.

## What it shows

- Usage, token/cache types, spend, models, users and tools by enabled coding client.
  Claude spend is client-reported; Codex costs are labelled AWS list-price estimates.
- Claude detail pages retain channel comparisons, adoption, commits, code changes,
  activity measures and opt-in computed-cost diagnostics.
- Request/tool reliability and observed timing; Claude also has optional trace measures.
- A SQL chat assistant for Claude telemetry, backed by Bedrock with authentication
  and read-only query controls.

These are observations and estimates, not invoices, causal adoption effects, or validated
employee productivity scores. Combined user counts union distinct emitted IDs across
clients; they are neither a verified employee directory nor a sum of client headcounts.
Claude channels are inferred per session; model names do not establish client identity.

## Local setup

Docker Compose runs the local database and built dashboard:

```bash
git clone https://github.com/Atom-oh/claude-code-usage-dashboard.git
cd claude-code-usage-dashboard
docker compose -f dashboard/docker-compose.yml up -d --build
```

Open the dashboard at `http://localhost:8080`. Compose binds the app to loopback,
uses synthetic seed data, and explicitly disables app authentication for local use.
The database publishes ports 8123 and 9000 on all interfaces; run this development stack on a trusted
machine, not an exposed server. Seeds initialize only a new volume. `down -v` deletes it.

The SQL chat returns 503 on this default stack: it also needs authenticated access and
a confirmed read-only ClickHouse session.

For source development, use Node.js 22 or newer; the container builds with Node 24.
Install the packages separately:

```bash
(cd dashboard/server && npm ci)
(cd dashboard/web && npm ci)
docker compose -f dashboard/docker-compose.yml up -d clickhouse
```

Run the API and Vite in separate terminals:

```bash
# Terminal 1, from the repository root
cd dashboard/server
CH_URL=http://127.0.0.1:8123 CH_USER=default AUTH_ALLOW_INSECURE=1 npm run dev
```

```bash
# Terminal 2, from the repository root
cd dashboard/web
npm run dev
```

Use the Vite URL printed in the terminal. To serve the SPA directly through Express,
build `dashboard/web` first. `.env.example` is a configuration template: the application
does not load `.env` automatically. Export variables explicitly, or use Node's
`--env-file` option with the appropriate file path. The template's port 18123 is a
port-forward example; Compose publishes ClickHouse on 8123.

`scripts/setup.sh` is a legacy convenience wrapper using `npm install` and optional local
hooks; it does not enforce the Node version or load environment variables into the app.
The commands above are the reproducible setup path.

## Runtime configuration

See [.env.example](.env.example) and the [API reference](docs/api-reference.md).
Key contracts:

| Setting | Behavior |
|---|---|
| `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD` | Required together; missing credentials fail startup unless the explicit local bypass is set. |
| `AUTH_ALLOW_INSECURE` | Local-development bypass only. Health probes never require it. |
| `CH_URL` | Takes priority over `CH_HOST`/`CH_PORT`; fallback is `http://localhost:8123`. |
| `CH_DB`, `CH_USER`, `CH_PASSWORD` | Defaults: `claude_code`, `default`, and empty password. Supply deployment credentials securely. |
| `CLAUDE_ENABLED`, `CODEX_ENABLED` | Defaults: `true`, `false`. Enable either client or both; both false is invalid. Keep dashboard, bootstrap and collector settings consistent. |
| `CODEX_BEDROCK_ENDPOINT` | `mantle` (default) or `runtime`; selects Codex launcher defaults independently of Claude channels. |
| `CODEX_PRICING_JSON` | Validated inline JSON overrides for Codex AWS list-price estimates; see the [Codex runbook](docs/runbooks/codex-telemetry.md#dashboard-cost-and-query-contract). |
| `GROUP_MODE` | `ab` or `single`; affects Claude presentation, not channel inference or client selection. |
| `DEFAULT_RANGE_DAYS`, `RANGE_CAP_DAYS` | Default window 2 days, maximum 90 days; invalid configuration fails startup. |
| `PII_MASK_ENABLED` | Presentation/CSV/chat masking; not an authorization boundary for raw API access. |
| `PRICING_JSON` | Inline JSON overrides for diagnostic token prices, not a filename. |
| `PRICING_CACHE_WRITE_TTL` | Diagnostic cache-write assumption: `1h` or `5m`, default `1h`. |
| `CHAT_MODEL_ID`, `BEDROCK_REGION`, `AWS_REGION` | Configure the chat's Bedrock model and region; check deployment overrides. |
| `CHAT_ALLOW_INSECURE` | Independent chat-auth bypass for local development only; never enable on an internet-facing deployment. |
| `DATA_STALE_MINUTES` | Freshness threshold for enabled sources, default 360 minutes: Claude metric `TimeUnix` or Codex log `Timestamp`. |
| `ALERT_WEBHOOK_URL`, `ALERT_REPEAT_MINUTES` | Optional stale-data alerts; the webhook is a secret. |

JSON API responses use `no-store`; successful chat SSE currently uses `no-cache`.
The server has its own bounded cache/warmer. Unavailable telemetry is distinct from
measured zero.

Deployments with both clients enabled open the all-client overview; a single-client deployment
selects that client. Claude selection exposes its existing detail pages. Common views
use `/api/clients/overview`, with minute buckets through four hours and hourly buckets
for longer ranges. Mixed ranges share Claude's aligned `effective_range`; historical
rollup approximations remain. See the [data contract](docs/reference/data.md).

## Telemetry Ingestion and operations

The collector must remain running for data to arrive. Use supervised startup and its
disk-backed queue; follow the [operator procedures](docs/runbooks/incident-response.md)
and the actual `user-data.sh`/collector configuration. Claude uses the loopback OTLP/gRPC
receiver; `ccdash-codex` sends structured logs to `http://127.0.0.1:4318/v1/logs`.
The collector promotes Codex's observed time into `otel_logs.Timestamp` when source
time is zero. Usage-bearing completions are deduplicated before pricing; no new schema
is required. A recent export from either client does not prove complete capture.

Production uses an EKS-hosted image. Source definitions do not establish deployed state:
verify the image, readiness, CDN asset hashes, schema probes, and migration ledger.

- [Deploy production](docs/runbooks/deploy-production.md)
- [Select clients and qualify Codex telemetry](docs/runbooks/codex-telemetry.md)
- [Deploy for another organization](docs/deploying-for-your-org.md)
- [Schema migrations](docs/runbooks/schema-migrations.md)
- [Backup and restore](docs/runbooks/backup-and-restore.md)
- [Ingest-user cutover](docs/runbooks/clickhouse-ingest-user-cutover.md)
- [Alerting](docs/runbooks/alerting.md)
- [Workshop deployment notes](docs/workshop-studio-notes.md)

### Project tag (project.name)

Follow the [data reference](docs/reference/data.md) for attribute-string replacement,
managed-setting ownership, retained attribution keys and project-label privacy.

## Development and review

```bash
(cd dashboard/server && npm test)
(cd dashboard/web && npm test && npm run build)
bash tests/run-all.sh
terraform fmt -check -recursive infra/
(cd infra && terraform init -backend=false && terraform validate)
```

GitHub CI runs server/web tests, the shell harness, and Terraform validation. AI review
uses a separate self-hosted runner and a model-by-lens panel with a chair. Failed or
missing required review coverage is not a passing result. See the
[review runbook](docs/runbooks/pr-review-panel.md).

## Documentation map

| Area | Entry point |
|---|---|
| Engineering instructions | [AGENTS.md](AGENTS.md) and scoped guides; CLAUDE.md files import them |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| API and metrics | [API reference](docs/api-reference.md), [metric definitions](docs/metrics.md) |
| Implementation details | [Reference index](docs/reference/INDEX.md) |
| Decisions | [ADRs](docs/decisions/) |
| Documentation language/ownership | [Documentation policy](docs/documentation-policy.md) |
| Static site | `site/`; separate GitHub Pages workflow |
| Video | [video/AGENTS.md](video/AGENTS.md); separate pinned toolchain |

Project documentation is English-only. The application remains Korean-first.
The repository is proprietary; see [LICENSE](LICENSE). Package version `1.0.0` does
not imply a tagged release; see [CHANGELOG.md](CHANGELOG.md) for dated history.
