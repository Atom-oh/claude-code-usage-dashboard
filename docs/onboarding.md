# Developer Onboarding

Read [AGENTS.md](../AGENTS.md) for canonical developer instructions, then the scoped
[server](../dashboard/server/AGENTS.md), [web](../dashboard/web/AGENTS.md) or
[infra](../infra/AGENTS.md) instructions for your change. CLAUDE.md files are bridges to
those instructions. The [documentation policy](documentation-policy.md) owns language and scope.

## Local setup

Both application manifests require Node >=22, CI uses Node 22, and the container uses Node 24.
Docker Compose is needed only for the local full stack. AWS CLI, kubectl and Terraform
>=1.9 are needed only for infrastructure work against an authorized environment.

From the repository root, install locked dependencies:

```bash
npm --prefix dashboard/server ci
npm --prefix dashboard/web ci
```

The legacy [scripts/setup.sh](../scripts/setup.sh) uses `npm install` and checks only that
Node is present. Use the locked installs above for new work. Neither `node index.js` nor
the npm start/dev scripts auto-load `.env`; provide environment variables explicitly.

Start a local database and built dashboard with synthetic seed data:

```bash
docker compose -f dashboard/docker-compose.yml up -d --build
```

Open the dashboard on localhost port 8080. Schema and seed SQL run only when the ClickHouse
volume is first initialized. This Compose configuration explicitly permits unauthenticated
local use; chat remains disabled without its separate gates. See [runtime details](reference/infrastructure.md).

For hot reload, start only ClickHouse, then run the API and Vite in separate terminals:

```bash
docker compose -f dashboard/docker-compose.yml up -d clickhouse
AUTH_ALLOW_INSECURE=1 CH_URL=http://localhost:8123 npm --prefix dashboard/server run dev
```

```bash
npm --prefix dashboard/web run dev
```

Vite proxies `/api` to port 8080. Use the local URL printed by Vite.
The root [.env.example](../.env.example) uses ClickHouse port 18123 for a port-forward;
Compose exposes host port 8123. Do not interchange those defaults. To load a prepared
root `.env` explicitly from the repository root, run:

```bash
node --env-file=.env dashboard/server/index.js
```

`PRICING_JSON`, if set, is an inline JSON object of model rates, not a JSON file path.

## Verification

Run the relevant application checks from the repository root:

```bash
npm --prefix dashboard/server test
npm --prefix dashboard/web test
npm --prefix dashboard/web run build
```

[tests/run-all.sh](../tests/run-all.sh) covers repository/hooks structure separately from
application tests. Inspect each test's prerequisites before treating missing local tooling
as an application failure. For documentation changes, verify source symbols, endpoint
coverage, English-only text and relative links; do not call live services merely to edit prose.

## Concepts to understand before changing code

- [Data aggregation](reference/data.md): cumulative counter differences, the four-hour raw
  threshold, segment-aware source keys, channel inference and migration evidence.
- [Metrics](metrics.md): reported spend, computed diagnostics, missing-report handling and
  the limits of activity scores and permission-decision rates.
- [API contract](api-reference.md): actual routes, response shapes, filter exceptions and caps.
- [Frontend](reference/frontend.md): shared range/filter state, quantized requests and runtime config.
- [Architecture](architecture.md) and [decisions](decisions/): responsibilities and non-obvious tradeoffs.

A zero result can reflect missing telemetry or an unsupported filter combination. Trace
`unsupported` is not a measured zero. Model filters do not scope active-user/adoption
headcounts, and project filtering covers only four Usage queries. Check the contract before
interpreting a mismatch as a regression.

For development PRs, follow the latest-HEAD AI review, required checks and merge policy in
[AGENTS.md](../AGENTS.md) and the [review runbook](runbooks/pr-review-panel.md);
a documentation-only task does not authorize deployment. For authorized operations, use
[deployment](runbooks/deploy-production.md), [schema migrations](runbooks/schema-migrations.md),
or [deployment for another organization](deploying-for-your-org.md).
