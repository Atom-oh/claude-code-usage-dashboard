# Server instructions

Express and plain Node.js ESM provide read-only telemetry endpoints and serve the SPA.
Tests use `node:test`; run `npm test` in this directory.

## API and security

- Register data through `route()` in `index.js` for ranges, validation, caching,
  in-flight deduplication and shared errors.
- Only `/healthz` and `/readyz` bypass Basic Auth. Config, freshness and data stay authenticated.
  JSON uses `no-store`; successful chat SSE overrides with `no-cache`.
- Missing credentials fail startup except explicit local-development bypass; no production fallback.
- Chat requires authentication plus a readonly-session probe. `sanitizeSql()` changes need security review.
- Liveness is `/healthz`; readiness fails during drain/ClickHouse outage. Database failure must not restart the app.
- Keep `app` import-safe and bind only as entry module; boot checks/probes still run on import.

## Query contracts

- Cumulative temporality 2 is not incremental usage. Sum only values derived through
  `incFlat`/`incBucketed` or justified local differencing; preserve delta/legacy handling.
- Use stored `SeriesKey`, never replacement hashes. It includes process start except
  `claude_code.session.count`; probes/ledger establish actual deployment.
- Three-day baselines; raw rows up to four hours, hourly rollups beyond. Preserve
  historical-end/partial-hour approximations; no universal cross-window equality.
- Preserve shared helper dimensions. Use ADR-001 local differencing for effort,
  version, language, agent or project.
- Supply source-appropriate columns to `filterCond()`. Direct models, mixed counters
  and session-based log filtering differ. Unknown-channel inclusion is endpoint policy,
  not a `GROUP_MODE` option.
- `grouping.js` infers session channels, not users. Many queries only use `UserEmail`;
  there is no universal identity fallback.
- Logs lack promoted Model/Decision/Source/status-code columns; read attributes and normalize models.
- Project filters require the project-column probe to be exactly true. It checks logs,
  not every table or migration.
- Promoted-field references must match schema copies and affected `grafana-ab-queries.sql`;
  SQL file existence is not rollout evidence.

## Cost and measurement

- The counter/`reported_cost` contracts below apply to Claude. Client views use
  `clientMetrics.js`: Codex usage-bearing completion logs are deduplicated before grouping
  and priced by `codexPricing.js`. A generic completion event is not usage.
  Input contains cache subsets and output contains reasoning; never add subsets twice.
- Client flags gate Claude routes/warming and select freshness sources. Client/backend
  selectors are validated before cache lookup; unknown costs propagate through folds.
- `TOKEN_SUMS` already returns `reported_cost`; `rollupComputedCost()` preserves its sum.
  A display-source change belongs in consumers, not in repricing or SQL rewrites.
- `cost` and summary `computed_cost` remain token-priced diagnostics. The configured
  cache-write TTL is an assumption, not a measurement of each request's TTL.
- `costEfficiency.js` joins user plus channel and computes unit costs from the report.
  Missing/invalid reports and zero reports with token usage produce null unit costs.
  Valid reports remain usable when a local model price is absent.
- Preserve row-level missingness through folds. Positive totals can conceal missing
  component reports; neither estimates nor the telemetry stream guarantee billing accuracy.
- Productivity scoring is a heuristic activity formula. Edit decisions are permission
  decisions, including automatic decisions, not proof of retained or correct code.
- Trace-backed queries use `{unsupported, rows, ...}` where absence is legitimate.
  Preserve unavailable states rather than manufacturing measured zeros.

## Owners and operations

`queries.js`: SQL/model normalization; `pricing.js`: diagnostics; `schema.js`: probes;
`http.js`: validation. Chat's `queryReadonly()` has separate result/time limits.
Reader profiles may reject even `SETTINGS` changes; never assume an override is allowed.

Chat retains legacy cost/rollup wording. Its size helper and supported SQL disconnect
signal are not wired into the live loop; do not claim those guarantees.

See [API](../../docs/api-reference.md), [metrics](../../docs/metrics.md) and
[schema operations](../../docs/runbooks/schema-migrations.md).
