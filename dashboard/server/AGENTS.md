# Server

Express ESM read-only telemetry/SPA; run npm test (node:test).

## API

- index.js route(): validate/cache/deduplicate in-flight work/handle errors.
- Basic/OIDC protects config/freshness/data except probes/OIDC protocol; no OIDC fallback. [Identity](../../docs/decisions/ADR-019-dedicated-installation-identity.md). JSON: no-store; chat SSE success: no-cache.
- Invalid auth fails startup except explicit local Basic bypass. Chat needs confirmed readonly sessions; security-review sanitizeSql() changes.
- Unsafe OIDC: configured Origin required; viewers cannot query chat.
- Imports never listen; boot checks/probes run. /healthz: liveness; /readyz: fail on drain/ClickHouse outage. DB failure must not restart app.

## Queries

- Temporality 2: cumulative, incFlat/incBucketed or justified local differences. Keep delta/legacy handling; stored SeriesKey, no replacement hashes. Process start included except claude_code.session.count; verify probes/ledger.
- 3-day baselines; raw through 4h, then hourly rollups. Shared overview: explicit subhour buckets >=10m through 24h. Historical-end/partial-hour approximations; no cross-window equality claims.
- Keep ADR-001 helper dimensions: effort/version/language/agent/project.
- filterCond(): source columns; distinct model/counter/session-log grains. Unknown-channel inclusion: endpoint-owned, not GROUP_MODE.
- grouping.js: inferred session channels; UserEmail often has no identity fallback.
- Logs lack promoted Model/Decision/Source/status-code: use attributes/normalized models.
- Project filters: logs-only project-column probe ===true; promoted fields match both schemas/grafana-ab-queries.sql. Files do not prove rollout.

## Costs

- Claude: counters/reports. clientMetrics.js: deduplicate usage-bearing Codex completions before grouping/codexPricing.js; generic completion is not usage. Input includes cache subsets; output includes reasoning. Never double-add.
- Client flags gate Claude routes/warming/freshness; validate client/backend before cache. Sum usable costs with cost_partial/unpriced disclosure; all-unknown null.
- TOKEN_SUMS/rollupComputedCost(): retain reports; display changes only, except ADR-017 nacCostSql() counter SQL. Keep cost/computed_cost diagnostics; assumed TTL.
- costEfficiency.js: user/channel join. Report units null: missing/invalid reports or zero reports with positive tokens. Missing rates do not invalidate reports.
- Strict canonical tokens; split full-usage/pair validity before SQL sums. Positive Claude reports survive missing tokens; zero needs known zero. observed_tokens: known pairs with tokens_partial, [coverage](../../docs/decisions/ADR-014-observed-token-subtotals.md). Totals prove neither complete collection nor invoice accuracy.
- Productivity: heuristic; edit decisions: permission (auto-approval included), not retained/correct code.
- Unavailable traces: {unsupported, rows, ...}, no invented zeros. /api/codex/insights: log units separate from metric/trace diagnostics; keep temporality/dedup/range/optional-table coverage. Transport/permission failures are errors.

## Owners

queries.js: SQL/models; pricing.js: diagnostics; schema.js: probes; http.js: validation.
queryReadonly(): bounded results/time; reader profiles may reject SETTINGS; never assume overrides.
Chat: whole-row cap, cooperative model/SQL cancellation, no token/billing bound.
SQL does not apply non-Anthropic/Codex spend adapters.

[API](../../docs/api-reference.md); [metrics](../../docs/metrics.md);
[schema](../../docs/runbooks/schema-migrations.md).
