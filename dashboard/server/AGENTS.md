# Server instructions

Express/Node.js ESM serves read-only telemetry and the SPA. Run `npm test` here (`node:test`).

## API and security

- Use `route()` in `index.js` for range validation, caching, in-flight deduplication and errors.
- Only `/healthz` and `/readyz` bypass Basic Auth; config, freshness and data require it.
  JSON is `no-store`; successful chat SSE is `no-cache`.
- Missing credentials fail startup except explicit local-development bypass; no production fallback. Chat also
  needs a readonly-session probe. Security-review `sanitizeSql()` changes.
- Imports must not bind the server; boot checks/probes still run. Liveness is `/healthz`;
  `/readyz` fails during drain/ClickHouse outage. DB failure must not restart the app.

## Query contracts

- Temporality 2 is cumulative: use `incFlat`/`incBucketed` or justified local differences,
  preserving delta/legacy handling. Use stored `SeriesKey`, never replacement hashes.
  It includes process start except `claude_code.session.count`; verify probes/ledger.
- Baselines span three days; use raw rows through four hours, then hourly rollups.
  Preserve historical-end/partial-hour approximations, not universal cross-window equality.
- Preserve helper dimensions. ADR-001 owns local differences for effort/version/language/agent/project.
- `filterCond()` needs source-specific columns: direct models, counters and session
  log filtering differ. Unknown-channel inclusion is endpoint policy, not `GROUP_MODE`.
- `grouping.js` infers session channels, not users. Many queries only use `UserEmail`;
  no universal identity fallback exists.
- Logs lack promoted Model/Decision/Source/status-code columns: use attributes/normalized models.
- Project filters require an exactly-true project-column probe (logs only). Promoted
  fields must match both schemas and affected `grafana-ab-queries.sql`; files do not prove rollout.

## Cost and measurement

- Claude uses counters/reports. `clientMetrics.js` deduplicates Codex usage-bearing
  completions before grouping/pricing (`codexPricing.js`); generic completion is not usage.
  Input contains cache subsets; output contains reasoning. Never double-add subsets.
- Client flags gate Claude routes/warming and freshness. Validate client/backend before cache.
  Shared costs sum usable amounts with `cost_partial`/unpriced disclosure; all-unknown stays null.
- Claude `TOKEN_SUMS`/`rollupComputedCost()` already retain reports: change display consumers,
  not repricing/counter SQL. Keep `cost`/summary `computed_cost` diagnostics; TTL is an assumption.
- `costEfficiency.js` joins user plus channel. Report-based units stay null for missing/invalid
  reports or zero reports with positive tokens. A missing local rate does not invalidate reports.
- Keep canonical tokens strict; separate full-usage/pair validity before SQL sums.
  Positive shared Claude reports survive missing tokens; zero requires known zero.
  `observed_tokens` retains known pairs with `tokens_partial`; see
  [coverage policies](../../docs/decisions/ADR-014-observed-token-subtotals.md).
  Positive totals prove neither complete collection nor invoice accuracy.
- Productivity is heuristic. Edit decisions are permissions (including automatic approval),
  not retained/correct code.
- Preserve unavailable trace results (`{unsupported, rows, ...}`), never invented zeros.
  `/api/codex/insights` separates log units from metric/trace diagnostics; retain temporality,
  deduplication, range bounds and optional-table coverage. Transport/permission failures are errors.
- `backend.js` (`resolveBackend`/`backendSql`) is the one place backend is resolved, for both
  clients: model id prefix first (region/global routing → runtime, bare vendor namespace →
  mantle), the resource tag only as a fallback for a prefix-less model. Never re-derive it
  inline; every SQL/JS site that needs it imports from here. Claude's enterprise-channel
  short-circuit to `anthropic` is separate and unchanged. See
  [ADR-017](../../docs/decisions/ADR-017-model-prefix-backend-and-computed-fallback.md).
- Codex pricing (`codexPricing.js`) falls back to the Claude table for an Anthropic model
  absent from its own table (`price_source: "claude_table"`), never overriding an existing
  Codex-table entry or the scope/backend/usage-validity guards. The overview's Claude usage
  (`clientMetrics.js`'s `claudeUsage`) falls back to a token-computed estimate
  (`cost_basis: "computed_estimate"`/`"mixed"`, counted in `cost_estimated`) only where the
  report itself is unusable — never in place of one, and only in `/api/clients/overview`;
  the legacy Cost/Executive/`spend.js` cost-basis contract (ADR-009) is unchanged elsewhere.
  Both tables accept an optional per-model `backends` override for mantle/runtime rate splits.

## Owners and operations

`queries.js`: SQL/models; `pricing.js`: diagnostics; `backend.js`: backend resolution;
`schema.js`: probes; `http.js`: validation.
Chat `queryReadonly()` has separate result/time limits. Reader profiles may reject
`SETTINGS`; never assume overrides are allowed.

Chat retains legacy cost/rollup wording. Its size helper and supported SQL disconnect
signal are not wired into the live loop; do not claim those guarantees.

See [API](../../docs/api-reference.md), [metrics](../../docs/metrics.md) and
[schema operations](../../docs/runbooks/schema-migrations.md).
