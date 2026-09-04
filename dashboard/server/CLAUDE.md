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

There are four non-data routes. `/healthz` is **liveness** (always 200, body `{ok}` from a
ClickHouse `ping()` — deliberately status-insensitive so a cluster incident cannot restart
healthy pods) and `/readyz` is **readiness** (200/503, unauthenticated like `/healthz`, 503
while draining after `SIGTERM` and 503 when `ping()` fails). `/api/health/data` is the
authenticated data-freshness route: it classifies `max(TimeUnix)` on the raw
`otel_metrics_sum` into `ok`/`stale`/`unknown`, answers 200 only for `ok`, memoizes for 30s
because many tabs poll it every 60s, and — like `/api/config` — deliberately skips the
`route()` wrapper (no range params, and `route()` cannot express a 503). `GET /api/config`
returns
`{piiMask, pricing, schema}`. `piiMask` comes from `PII_MASK_ENABLED` (`"1"`/`"true"` = on, unset =
off) so the SPA can decide whether to mask emails at render time — the image is built once and
reused across deployments, so this can't be a build-time `VITE_` flag. `pricing` is
`pricing.js`'s `pricingConfig` (`{cacheWriteTtl, overriddenModels}`), passed straight through
so the endpoint can't drift from the pricing module. `cacheWriteTtl` comes from
`PRICING_CACHE_WRITE_TTL` -- `"1h"` (default, since the main conversation's cache writes are
measured at the 1h rate) or `"5m"`; any other value throws at startup. `overriddenModels`
lists the normalized model keys supplied via `PRICING_JSON` -- a JSON object of normalized
model key -> `{input, output, cacheWrite?, cacheRead?, cacheWrite1h?}` merged over the
built-in table, with omitted cache fields derived from `input` (`×1.25`/`×0.1`/`×2`); invalid
JSON, a missing/negative `input`/`output`, or a non-normalized key throws at startup.
`schema.segmentAwareSeriesKey` is `true`/`false`/`null`, probed (not assumed) from the newest
`claude_code.cost.usage` rows at boot and refreshed every 10 minutes -- `true` means the
migration-003 segment-aware `SeriesKey` expression is in force on the cluster, `false` means
the legacy expression still is, and `null` means undetermined (mixed keys mid-
`MATERIALIZE COLUMN`, no recent rows, or any probe error). It intentionally skips the
`route()` wrapper (no ClickHouse, no range params) but still inherits the global Basic Auth --
the probe itself runs on its own timer rather than in the request path, so the route stays
synchronous and still touches no ClickHouse at request time.

`POST /api/chat` has two independent gates, both answering 503: auth must be configured (or
`CHAT_ALLOW_INSECURE=1`), and the server's boot probe must have confirmed the ClickHouse
session is `readonly`.

## Key Files
- `index.js` -- route table, `route()` wrapper (range/query parsing + error handling + TTL
  cache with in-flight dedup; see `QUANT_MS`/`CACHE_TTL_MS` constants for current timing math),
  cache warmer (pre-computes the default 2-day/no-filter view every `QUANT_MS` boundary; the web
  client quantizes `to` to the same boundary in `useApi.js` so keys match across sessions),
  global Basic Auth middleware, static file serving
- `http.js` -- `ValidationError`, `parseRange` (now takes `{defaultDays, capDays}`),
  `parseIntervalHours`, `parseGroupMode`, `parsePositiveInt` (pure, unit-tested)
- `app.test.js` -- drives the real Express app over an ephemeral socket (`app.listen(0)`) to pin
  the `route()` envelope itself: 400 mapping with a non-echoing `detail`, a 500 body of exactly
  `{error, id}` with no SQL or driver text, and `Cache-Control: no-store` on every `/api/*`
  response including `/api/chat` and `/api/config`
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
  `tierCosts`, `tierCostsByGroup`, `rollupComputedCost` (applies `withComputedCost` at a
  `model` grain and then folds rows onto coarser key columns — the pricing has to be computed
  before the model column is summed away, so a query that wants computed cost per
  effort/agent cannot do it in SQL)
- `productivity.js` -- productivity score derivation (pure function, used by leaderboard)
- `costEfficiency.js` -- `$/LOC`, `$/commit` derivation (pure function)
- `activity.js` -- `rollupAdoption(rows, from, to)`: the DAU/WAU/MAU + stickiness fold behind
  `/api/adoption/timeseries` (pure function, unit-tested). Windows are trailing 30 and 7 days
  *inclusive of the current day*; stickiness is `dau / mau * 100` to one decimal, and `0` when
  `mau` is `0`
- `chat.js` -- Bedrock ConverseStream chat assistant, `sanitizeSql()` SQL sandbox
- `clickhouse.js` -- `query()` / `queryReadonly()` / `ping()`; `classifyReadonly` (pure,
  unit-tested tri-state) / `assertReadonlySession` (never throws, folds every error to `null`)
- `schema.js` -- `classifySeriesKeyProbe` (pure, unit-tested) classifies a `{seg, legacy}` row
  count pair into `true`/`false`/`null`; `probeSegmentAwareSeriesKey` runs the ClickHouse probe
  and never throws -- it folds every error to `null`, since the value feeds a fail-safe warning
  rather than a request path
- `freshness.js` -- `classifyFreshness` (pure, unit-tested) turns a `{latestMs, nowMs,
  staleAfterMinutes}` triple into `{status, latest, ageMinutes, staleAfterMinutes}`;
  `probeLatestTelemetryMs` runs the ClickHouse probe and never throws (every error folds to
  `null`, which classifies as `unknown`). Reads the **raw** `otel_metrics_sum`, not the hourly
  rollup -- the rollup lags up to an hour, which is longer than the outage this exists to
  catch. `staleAfterMinutes` comes from `DATA_STALE_MINUTES` (default `360`) and a
  non-positive/non-numeric value throws at module load, same policy as
  `PRICING_CACHE_WRITE_TTL`
- `alerting.js` -- outbound telemetry-staleness alerting: `planAlert` (pure planner: debounce
  two consecutive non-ok ticks, repeat while non-ok, one recovery message), `formatAlert` (the
  one-line `[ccdash] …` texts), `postWebhook` (Slack-compatible `{"text"}` POST, `AbortController`
  timeout, never throws) and `startAlertLoop` (returns `{tick, stop}` so a test can drive a tick
  without timers). Import-safe: nothing starts unless `ALERT_WEBHOOK_URL` is set, and the first
  tick is 60s in, never at boot. Each replica alerts independently, by design (ADR-005) -- the
  pod name is in the message. The webhook URL carries a token and is never logged
- `*.test.js` -- `node:test` unit tests for the pure functions above

## Rules
- **`index.js` binds the port only when it is the entry module** (`isMain` via
  `pathToFileURL(path.resolve(process.argv[1]))`) and exports `app`, so `app.test.js` can import
  it. Everything else at module scope -- the fail-closed auth check, the schema and readonly
  probes, route registration -- still runs at import time and the test depends on that: keep any
  new boot side effect import-safe, or move it inside the `isMain` guard.
- **`GROUP_MODE` / `DEFAULT_RANGE_DAYS` / `RANGE_CAP_DAYS` are validated at boot and a bad value
  exits 1**, same policy as `BASIC_AUTH_*` and `DATA_STALE_MINUTES`. `DEFAULT_RANGE_DAYS` is the
  single source for the cache warmer's window, `parseRange`'s default span and (via
  `/api/config`) the SPA's default preset -- the three hard-coded `2`s those used to be are gone.
  `RANGE_CAP_DAYS` is enforced in `parseRange`, so it covers the `route()` pre-validation and
  `fetchCached` together. `DEFAULT_RANGE_DAYS` need not be one of the web's own presets
  (`dashboard/web/src/urlState.js`'s `PRESET_DAYS`) — `RangePicker.jsx` appends it to that list
  at render time, so a server default outside it still gets its own button.
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
  the `apiErrors` precedent. Since 2026-09-04 `effortMix`/`agentCost` carry a `model` grain and
  per-`TokenType` token columns in their outer `SELECT` and return `pricing.js`'s
  `rollupComputedCost()` output — computed `cost` + `reported_cost` + `unpriced_tokens` instead
  of the old reported-only `cost_usd` — because `cost.usage` is priced by the client and
  therefore version-dependent (measured 2026-09-03: v2.1.251 prices `claude-fable-5-1` off the
  opus-5 row, ≈0.5× of list). Adding `TokenType` to those local-diff `GROUP BY`s adds no rows:
  it is already folded into `SeriesKey`, exactly like `Model`.
- **`SeriesKey` identifies a per-process counter SEGMENT**, not just a series
  (`StartTimeUnix` folded in — `clickhouse-migration-003.sql` / ADR-003), except for
  `claude_code.session.count`, whose key definition is deliberately unchanged. **Never
  re-derive it inline** in a query — read the column; the one place that must compute it
  explicitly (`scripts/backfill-hourly-rollup.sh`) copies the expression verbatim.
- **`SIGTERM`/`SIGINT` set the `shuttingDown` flag, which is what makes `/readyz` answer 503
  for the rest of the process's life.** In a k8s rolling update the signal arrives *before* the
  pod leaves the Service's endpoints, so a draining pod must not keep claiming to be ready.
  `index.js` sets the flag in the handler, calls `server.close()`, and keeps a 10s
  `.unref()`'d force-exit as the backstop. Two things measured on the running server
  (2026-09-02), because both are easy to get wrong in either direction: **the flag is
  load-bearing** — remove it and a draining pod still answers `{"ready":true}` on an open
  connection — but **its position relative to `server.close()` is not**, since both statements
  run in the same synchronous tick, so no request handler can ever observe one without the
  other. Do not "fix" the ordering into something more elaborate, and do not delete the flag on
  the theory that `close()` already covers it. Note also that `close()` stops the listener
  immediately, so a *new* connection after `SIGTERM` is refused rather than 503'd: the window
  for a Service endpoint removal to propagate comes from a `preStop` hook /
  `terminationGracePeriod`, not from this flag. The existing periodic timers (cache sweep,
  schema probe, warmer chain) are all `.unref()`'d, so no timer registry is needed.
- **The pricing table's cache multipliers are not universal.** `cacheWrite = input × 1.25`,
  `cacheWrite1h = input × 2` and `cacheRead = input × 0.1` hold for most rows, but
  `claude-fable-5-1` and `claude-mythos-5-1` carry an explicit `cacheRead` of `$0.25` — a
  0.025x exception verified against the published price list on 2026-09-02. Never "simplify" a
  base row by deleting a field that looks derivable; only `cacheWrite1h` is actually derived
  (in `buildPricing`), and `pricing.test.js` pins both the exception and its control cases.
- **500 bodies never carry `err.message`** — a `ClickHouseError` text embeds the full SQL;
  correlate a user report with the log via the `id` in the body (`[<id>] <path>` in the pod
  log). Same bullet: every `route()` response (200, 400 and 500 alike) carries
  `Cache-Control: no-store`, and **validation runs before `fetchCached`** so an invalid request
  never allocates a cache key. The six `intervalHours` routes all go through `bucketHours()`;
  nothing calls `Number(query.intervalHours)` directly any more.
- **Alerting must stay import-safe and only start when `ALERT_WEBHOOK_URL` is set.**
  `app.test.js` imports `index.js`, so a timer or a network call at module scope would run
  inside the unit suite. `ALERT_REPEAT_MINUTES` is validated at boot regardless of whether the
  URL is set, same policy as `DATA_STALE_MINUTES`.
- **The server refuses to boot without `BASIC_AUTH_USER` + `BASIC_AUTH_PASSWORD`**
  (`console.error` + `process.exit(1)`), unless `AUTH_ALLOW_INSECURE=1` is set, which logs one
  loud warning and serves every `/api/*` route unauthenticated. `AUTH_ALLOW_INSECURE` and
  `CHAT_ALLOW_INSECURE` are a deliberate pair of **independent** opt-ins, not one flag: booting
  without auth and enabling an LLM-authored-SQL endpoint without auth are different risks.
- **The chat sandbox's readonly premise is measured, not assumed.** `clickhouse_settings: {
  readonly: 1 }` on `createClient()` is not the fix — the `otel_reader` profile rejects any
  client-side session-setting change (recorded in the comment above `queryReadonly` in
  `clickhouse.js`), so that would break every dashboard query, not just chat. Instead the
  server probes `getSetting('readonly')` at boot and every 10 minutes; `null` (probe failed) is
  treated exactly like `false`. Local-dev consequence: a plain local ClickHouse `default`
  account has `readonly=0`, so chat answers 503 locally unless `CH_USER` points at a
  readonly-profiled account.
- **`/api/adoption/timeseries` is `adoptionTimeseries`, and its rolling-window fold lives in
  `activity.js`'s `rollupAdoption`** -- the query returns only `[{d, users}]` day rows and the
  30/7-day unions plus `stickiness` are folded in JS, where `activity.test.js` can pin them. The
  older `activeUsersTimeseries` export and the unused 29/6-day `rollupActiveUsers` fold beside
  it were both deleted; there is one window definition now, and it is the one the page renders.
- **`npm test`** in `dashboard/server` runs `node --test *.test.js`. `engines.node` is `>=22`
  (local toolchain 22, runtime image 24). CI (`.github/workflows/ci.yml`) runs it on every push
  to `main`/`feat/**` and every pull request.
