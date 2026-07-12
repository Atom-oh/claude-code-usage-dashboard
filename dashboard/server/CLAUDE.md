# Server Module

## Role
Express API layer. Every route is `GET`, read-only, and backed by a ClickHouse query. Also
hosts the Bedrock-backed `/api/chat` SQL assistant and serves the built `web/dist` as static
files.

## Endpoints
See [docs/api-reference.md](../../docs/api-reference.md) for the full list. Route
registration lives in `index.js`; the actual SQL is in `queries.js` (one exported function per
endpoint, mostly following the pattern `export async function xyz(from, to, ...params,
filters)`).

## Key Files
- `index.js` -- route table, `route()` wrapper (range/query parsing + error handling + TTL
  cache with in-flight dedup; see `QUANT_MS`/`CACHE_TTL_MS` constants for current timing math),
  cache warmer (pre-computes the default 2-day/no-filter view every `QUANT_MS` boundary; the web
  client quantizes `to` to the same boundary in `useApi.js` so keys match across sessions),
  global Basic Auth middleware, static file serving
- `queries.js` -- all ClickHouse SQL; `incFlat`/`incBucketed` (cumulative-counter diffing over
  the hourly rollup `otel_metrics_sum_hourly` — MINUTE-bucket drag-zoom falls back to the raw
  table via `incBucketedRaw`), `filterCond` (global group/user/model filters), `normModel`
  (model name normalization)
- `grouping.js` -- `GROUP_CTE`/`GROUP_EXPR`, session-scoped bedrock/enterprise inference (reads
  the hourly rollup's `has_org` column)
- `pricing.js` -- per-model token pricing, `withComputedCost`, `tierCosts`, `tierCostsByGroup`
- `productivity.js` -- productivity score derivation (pure function, used by leaderboard)
- `costEfficiency.js` -- `$/LOC`, `$/commit` derivation (pure function)
- `activity.js` -- DAU/WAU/MAU rollup from raw day x user rows (pure function,
  `MAU_WINDOW_DAYS` constant shared with `queries.js`)
- `chat.js` -- Bedrock ConverseStream chat assistant, `sanitizeSql()` SQL sandbox
- `clickhouse.js` -- `query()` / `queryReadonly()` / `ping()`
- `*.test.js` -- `node:test` unit tests for the pure functions above

## Rules
- **Never `sum(Value)` directly on `otel_metrics_sum`.** Values are cumulative per-session
  counters; use `incFlat()` (snapshot) or `incBucketed()` (timeseries) to get the actual
  increase over the requested range. See the long comment block above `incFlat` in
  `queries.js` for the measured failure mode (100x+ overcounting).
- Every new query function that should respect the global filter bar must call `filterCond()`
  with the right `cols` shape for the table it queries — `model` for tables with a `Model`
  column, `modelViaSession` for `otel_logs` (no `Model` column, semi-join via `SessionId`),
  `modelMixed` for queries that blend both (e.g. `kpiSummary`, where session/commit/PR rows
  have no `Model` but token rows do).
- If a change touches a promoted/materialized column also referenced in
  `grafana-ab-queries.sql` (repo root), update that file too — a past PR review caught these
  drifting out of sync.
- New endpoints go through the same `route()` wrapper in `index.js`; don't add a bespoke
  `app.get(...)` that bypasses the shared error handling and range parsing.
- `chat.js`'s `sanitizeSql()` is the only place user/LLM-influenced SQL reaches ClickHouse —
  any change there needs security-auditor-level scrutiny (see `.claude/agents/security-auditor.yml`).
