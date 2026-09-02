# Server Module

## Role
Express API layer. Every data route is `GET`, read-only, and backed by a ClickHouse query.
Also hosts the Bedrock-backed `POST /api/chat` SQL assistant (SSE stream) and serves the
built `web/dist` as static files.

## Endpoints
See [docs/api-reference.md](../../docs/api-reference.md) for the full list. Route
registration lives in `index.js`; the actual SQL is in `queries.js` (one exported function per
endpoint, mostly following the pattern `export async function xyz(from, to, ...params,
filters)`).

`GET /api/config` is the one non-data route besides `/healthz`: it returns
`{piiMask, pricing}`. `piiMask` comes from `PII_MASK_ENABLED` (`"1"`/`"true"` = on, unset =
off) so the SPA can decide whether to mask emails at render time — the image is built once and
reused across deployments, so this can't be a build-time `VITE_` flag. `pricing` is
`pricing.js`'s `pricingConfig` (`{cacheWriteTtl, overriddenModels}`), passed straight through
so the endpoint can't drift from the pricing module. `cacheWriteTtl` comes from
`PRICING_CACHE_WRITE_TTL` -- `"1h"` (default, since the main conversation's cache writes are
measured at the 1h rate) or `"5m"`; any other value throws at startup. `overriddenModels`
lists the normalized model keys supplied via `PRICING_JSON` -- a JSON object of normalized
model key -> `{input, output, cacheWrite?, cacheRead?, cacheWrite1h?}` merged over the
built-in table, with omitted cache fields derived from `input` (`×1.25`/`×0.1`/`×2`); invalid
JSON, a missing/negative `input`/`output`, or a non-normalized key throws at startup. It
intentionally skips the `route()` wrapper (no ClickHouse, no range params) but still inherits
the global Basic Auth.

## Key Files
- `index.js` -- route table, `route()` wrapper (range/query parsing + error handling + TTL
  cache with in-flight dedup; see `QUANT_MS`/`CACHE_TTL_MS` constants for current timing math),
  cache warmer (pre-computes the default 2-day/no-filter view every `QUANT_MS` boundary; the web
  client quantizes `to` to the same boundary in `useApi.js` so keys match across sessions),
  global Basic Auth middleware, static file serving
- `queries.js` -- all ClickHouse SQL; `incFlat`/`incBucketed` (cumulative-counter diffing over
  the hourly rollup `otel_metrics_sum_hourly` — MINUTE-bucket drag-zoom falls back to the raw
  table via `incBucketedRaw`), `filterCond` (global group/user/model filters), `normModel`
  (model name normalization). 2026-08-11 additions (below the `userLeaderboard` marker comment)
  cover the traces/logs/version-cohort panels added in that sync — see the "Rules" bullets
  below for the two patterns they establish (local diff subqueries, `{unsupported}` shape). The
  2026-08-31 additions (`apiErrors`, `toolDecisionFunnel`, `interactionBreakdown`) sit at the end
  of the file and follow those same patterns
- `grouping.js` -- `GROUP_CTE`/`GROUP_EXPR`, session-scoped bedrock/enterprise inference (reads
  the hourly rollup's `has_org` column)
- `pricing.js` -- per-model token pricing (`buildPricing(env)`, env-overridable via
  `PRICING_JSON`/`PRICING_CACHE_WRITE_TTL`, exports `pricingConfig`), `withComputedCost`,
  `tierCosts`, `tierCostsByGroup`
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
- **Don't widen `incFlat`/`incBucketed`'s `GROUP BY` for a new dimension without reading
  ADR-001 first** (`docs/decisions/ADR-001-local-diff-over-shared-incflat-extension.md`). They
  have ~40 consumers and a history of subtle boundary bugs. If a cumulative-counter diff needs
  a dimension those functions don't carry (e.g. `AppVersion`, `EndUserId`), the established
  pattern (see `versionCohortSessions`/`versionCohortCost`) is a small self-contained local
  diff subquery, not a shared-function extension — until a second/third real need makes
  extension the better trade-off.
- **Per-user identity is `UserEmail`-only in most existing functions, not
  `coalesce(UserEmail, EndUserId)`.** This was a real gap (see ADR-002) fixed at the source
  instead: `user-data.sh` now force-injects `user.email` for the Bedrock group specifically
  (same `Email` instance tag it already read for `enduser.id`), so `UserEmail` itself is
  populated and `userLeaderboard`'s ~90 pre-existing `UserEmail` references need no change.
  This only helps instances whose Launch Template actually sets that tag
  (`InstanceMetadataTags=enabled`) — if that's missing, those sessions fall back to being
  merely `coalesce`-visible (new query functions and `grafana-ab-queries.sql` only) rather than
  fully invisible. See ADR-002's 2026-08-11 update for why the injection is Bedrock-only (an
  Enterprise session's real authenticated `user.email` must never be at risk of getting
  overwritten by this).
- Traces-beta query functions (`permissionWaitOverhead`, `ttftComparison`) return
  `{unsupported: boolean, minVersion, rows}`, not a bare array — `otel_traces` can be
  legitimately empty (beta not rolled out, or client version too old for that span type), and a
  KPI consumer must not render that as a confirmed zero. Follow this shape for any new
  `otel_traces`-backed endpoint.
- **A query function may return a keyed object instead of a bare array** — `apiErrors` returns
  `{byModel, byStatus}` because one panel needs two different groupings of the same event scan,
  and issuing two endpoints would double the `otel_logs` scan for one card. Consumers must use
  `data?.byModel || []`, not `data || []`; the `route()` wrapper and the cache are shape-agnostic.
  Prefer this over a bespoke `app.get(...)` or a second route whose only difference is `GROUP BY`.
- **`otel_logs` has no `Model`/`Decision`/`Source`/`status_code` promoted column.** Only
  `ToolName`, `Success`, and the 2026-08-11 batch are promoted (see `clickhouse-schema.sql`
  §2) — anything else has to be read as `LogAttributes['<key>']`, and a model name read that way
  still needs `normModel()` applied to match the pricing-table keys. `apiErrors` /
  `toolDecisionFunnel` are the reference examples.
- The 2026-09-01 batch (`activeTimeSummary` through `agentCost`, end of `queries.js`) adds no
  new rules — `effortMix`/`languageBreakdown`/`agentCost` are further local-diff instances
  (Effort/Language/AgentName aren't `incFlat` dimensions, ADR-001), the rest are `otel_logs`
  scans with `quantile()` percentiles over `LogAttributes` durations, and `apiLatency` /
  `commandAdoption` return keyed objects (`{byModel, byEffort}` / `{commands, prompts}`) per
  the `apiErrors` precedent.
