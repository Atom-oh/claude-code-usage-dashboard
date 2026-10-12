# Server instructions

Express ESM serves read-only telemetry and the SPA. Run `npm test` (`node:test`).

## API and security

- Use `route()` in `index.js` for validation, caching, in-flight deduplication and errors.
- Basic/OIDC protects config/freshness/data except probes/OIDC protocol. No OIDC fallback.
  See
  [identity](../../docs/decisions/ADR-019-dedicated-installation-identity.md).
  JSON is `no-store`; successful chat SSE is `no-cache`.
- Invalid auth fails startup except explicit Basic local bypass.
  Chat requires readonly-session confirmation. Security-review `sanitizeSql()` changes.
- OIDC unsafe requests require configured Origin; viewers cannot query chat.
- Imports must not listen; boot checks/probes still run. Liveness is `/healthz`;
  `/readyz` fails during drain/ClickHouse outage. DB failure must not restart the app.

## Query contracts

- Temporality 2 is cumulative: `incFlat`/`incBucketed` or justified local differences;
  preserve delta/legacy handling. Use stored `SeriesKey`, never replacement hashes.
  Process start is included except `claude_code.session.count`; verify probes/ledger.
- Three-day baselines; raw through four hours, then hourly rollups.
  Keep historical-end/partial-hour approximations; no cross-window equality claims.
- Keep helper dimensions; ADR-001 owns effort/version/language/agent/project differences.
- `filterCond()` needs source columns: direct models, counters and session
  logs differ. Unknown-channel inclusion is endpoint policy, not `GROUP_MODE`.
- `grouping.js` infers session channels; many queries use only `UserEmail`, without
  universal identity fallback.
- Logs lack promoted Model/Decision/Source/status-code: use attributes/normalized models.
- Project filters require an exactly-true project-column probe (logs only). Promoted
  fields must match both schemas/`grafana-ab-queries.sql`; files do not prove rollout.

## Cost and measurement

- Claude uses counters/reports. `clientMetrics.js` deduplicates Codex usage-bearing
  completions before grouping/`codexPricing.js`; generic completion is not usage.
  Input includes cache subsets; output includes reasoning. Never double-add them.
- Client flags gate Claude routes/warming/freshness. Validate client/backend before cache.
  Costs sum usable amounts with `cost_partial`/unpriced disclosure; all-unknown stays null.
- `TOKEN_SUMS`/`rollupComputedCost()` retain reports: change display, not counter SQL
  (except ADR-017 `nacCostSql()`). Keep `cost`/`computed_cost` diagnostics; TTL is assumed.
- `costEfficiency.js` joins user plus channel. Report-based units stay null for missing/invalid
  reports or zero reports with positive tokens. Missing rates do not invalidate reports.
- Keep canonical tokens strict; separate full-usage/pair validity before SQL sums.
  Positive Claude reports survive missing tokens; zero requires known zero.
  `observed_tokens` retains known pairs with `tokens_partial`; see
  [coverage policies](../../docs/decisions/ADR-014-observed-token-subtotals.md).
  Totals prove neither complete collection nor invoice accuracy.
- Productivity is heuristic; edit decisions are permissions (including automatic approval),
  not retained/correct code.
- Preserve unavailable traces (`{unsupported, rows, ...}`), never invented zeros.
  `/api/codex/insights` keeps log units separate from metric/trace diagnostics; retain
  temporality/dedup/range/optional-table coverage. Transport/permission failures are errors.

## Owners and operations

`queries.js`: SQL/models; `pricing.js`: diagnostics; `schema.js`: probes; `http.js`: validation.
`queryReadonly()` has result/time limits; reader profiles may reject `SETTINGS`.
Never assume overrides are allowed.

Chat: whole-row cap/cooperative model/SQL cancellation; no token/billing bound.
SQL does not apply non-Anthropic/Codex spend adapters.

See [API](../../docs/api-reference.md), [metrics](../../docs/metrics.md) and
[schema operations](../../docs/runbooks/schema-migrations.md).
