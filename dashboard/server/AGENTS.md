# Server instructions

Express and plain Node.js ESM provide read-only telemetry endpoints and serve the SPA.
Tests use `node:test`; run `npm test` in this directory.

## API and security

- Register data endpoints through `route()` in `index.js`. It owns range parsing,
  validation, caching, in-flight deduplication, and the shared error envelope.
- Only `/healthz` and `/readyz` bypass Basic Auth. `/api/config`, freshness, and all
  data routes remain authenticated. JSON API responses use `Cache-Control: no-store`;
  successful chat SSE currently overrides it with `no-cache`.
- Missing Basic Auth credentials fail startup unless the explicit local-development
  bypass is set. Do not introduce a production authentication fallback.
- Chat requires configured authentication and a successful read-only session probe.
  `sanitizeSql()` is the SQL sandbox; changes require focused security review.
- `/healthz` is liveness. `/readyz` fails while draining or unable to reach ClickHouse.
  Do not turn a database outage into an application restart loop.
- Preserve import-safe tests: `index.js` exports `app` and binds a port only as the entry
  module. Existing boot validation and probes also run on import.

## Query contracts

- Cumulative samples (`AggregationTemporality = 2`) are not increments. Use
  `incFlat`/`incBucketed` or a justified local diff query; their derived `Value` can be
  summed. The helpers also handle delta/legacy temporality.
- Use stored `SeriesKey`, never an inline replacement hash. The declared schema folds
  process start time into it except for `claude_code.session.count`. Actual deployment
  must be established by the schema probe and migration ledger.
- Helpers use a three-day baseline lookback. Snapshots up to four hours use raw rows;
  longer ranges use hourly rollups. Historical end alignment and partial-hour
  approximations remain: do not claim exact equality for every window or consumer.
- Do not widen shared helper dimensions casually. Follow ADR-001's local-diff pattern
  for fields such as effort, version, language, agent, or project.
- Use `filterCond()` with columns appropriate to the source. Direct model filtering,
  model-mixed counters, and session-based log filtering have different semantics.
  Unknown-channel inclusion is an endpoint policy, not a `GROUP_MODE` option.
- Session channels come from `grouping.js`; user identity is not the channel key.
  Many existing queries use `UserEmail` only. Do not claim a universal identity fallback.
- `otel_logs` has no promoted Model/Decision/Source/status-code column. Read the
  appropriate log attributes and normalize model identifiers where needed.
- Project filters are accepted only when the project-column probe is exactly true.
  That probe checks log columns; it is not proof that every table or migration is complete.
- New references to promoted schema fields must remain consistent with schema copies
  and any affected `grafana-ab-queries.sql` query. SQL file presence is not rollout evidence.

## Cost and measurement

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

`queries.js` owns SQL and model normalization; `pricing.js` owns diagnostic prices;
`schema.js` owns capability probes; `http.js` owns pure request validation.
`queryReadonly()` is chat-specific and imposes its own result and timeout handling.
Reader profiles may reject even settings changes; do not assume a SQL `SETTINGS`
override is permitted.

The chat prompt retains some legacy descriptions of computed costs and rollup use.
Its result-size helper is not wired into the live loop, and the handler does not pass
the supported disconnect signal to SQL. Do not document those as active guarantees.

Read [API contracts](../../docs/api-reference.md), [metric definitions](../../docs/metrics.md),
and [schema operations](../../docs/runbooks/schema-migrations.md) as needed.
