# Server instructions

Express ESM: read-only telemetry/SPA. Run `npm test` (`node:test`).

## API and security

- `index.js`'s `route()` validates, caches, deduplicates in-flight work and handles errors.
- Basic/OIDC protects config/freshness/data except probes/OIDC protocol. No OIDC fallback.
  [Identity](../../docs/decisions/ADR-019-dedicated-installation-identity.md).
  JSON is `no-store`; successful chat SSE is `no-cache`.
- Invalid auth fails startup except explicit Basic local bypass.
  Chat requires readonly-session confirmation. Security-review `sanitizeSql()` changes.
- OIDC unsafe requests require configured Origin; viewers cannot query chat.
- Imports never listen; boot checks/probes still run. Liveness: `/healthz`;
  `/readyz` fails during drain/ClickHouse outage. DB failure must not restart the app.

## Query contracts

- Temporality 2 is cumulative: `incFlat`/`incBucketed` or justified local differences;
  preserve delta/legacy handling. Use stored `SeriesKey`, never replacement hashes.
  Process start is included except `claude_code.session.count`; verify probes/ledger.
- Three-day baselines; raw through 4h, then hourly rollups. Shared overview permits
  explicit 10m-or-coarser subhour buckets through 24h.
  Keep historical-end/partial-hour approximations; no cross-window equality claims.
- Preserve helper dimensions (ADR-001: effort/version/language/agent/project).
- `filterCond()` needs source columns: model/counter/session-log grains differ.
  Unknown-channel inclusion is endpoint policy, not `GROUP_MODE`.
- `grouping.js` infers session channels; `UserEmail` often has no identity fallback.
- Logs lack promoted Model/Decision/Source/status-code; use attributes/normalized models.
- Project filters require a project-column probe `=== true` (logs only). Promoted fields
  must match both schemas/`grafana-ab-queries.sql`; files do not prove rollout.

## Cost and measurement

- Claude uses counters/reports. `clientMetrics.js` deduplicates usage-bearing Codex
  completions before grouping/`codexPricing.js`; generic completion is not usage.
  Input includes cache subsets; output includes reasoning. Never double-add them.
- Client flags gate Claude routes/warming/freshness; validate client/backend before cache.
  Sum usable costs with `cost_partial`/unpriced disclosure; all-unknown stays null.
- `TOKEN_SUMS`/`rollupComputedCost()` retain reports: change display, not counter SQL
  (except ADR-017 `nacCostSql()`). Keep `cost`/`computed_cost` diagnostics; TTL is assumed.
- `costEfficiency.js` joins user + channel. Report units stay null for missing/invalid
  reports or zero reports with positive tokens. Missing rates do not invalidate reports.
- Keep canonical tokens strict; split full-usage/pair validity before SQL sums.
  Positive Claude reports survive missing tokens; zero requires known zero.
  `observed_tokens` retains known pairs with `tokens_partial`:
  [coverage policies](../../docs/decisions/ADR-014-observed-token-subtotals.md).
  Totals prove neither collection completeness nor invoice accuracy.
- Productivity is heuristic; edit decisions mean permission (including automatic approval),
  not retained/correct code.
- Preserve unavailable traces (`{unsupported, rows, ...}`), never invented zeros.
  `/api/codex/insights` separates log units from metric/trace diagnostics; preserve
  temporality/dedup/range/optional-table coverage. Transport/permission failures are errors.

## Owners and operations

`queries.js`: SQL/models; `pricing.js`: diagnostics; `schema.js`: probes; `http.js`: validation.
`queryReadonly()` bounds results/time; reader profiles may reject `SETTINGS`. Never assume overrides.

Chat: whole-row cap and cooperative model/SQL cancellation; no token/billing bound.
SQL does not apply non-Anthropic/Codex spend adapters.

[API](../../docs/api-reference.md) · [metrics](../../docs/metrics.md) ·
[schema](../../docs/runbooks/schema-migrations.md).
