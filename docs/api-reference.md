# API Reference

## Base URL
Internal only, behind Basic Auth. No public base URL — access via the deployed dashboard
(`https://<cloudfront-domain>/api/...`) or locally at `http://localhost:8080/api/...`.

## Authentication
HTTP Basic Auth, applied globally by Express middleware in `dashboard/server/index.js`
(`BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` env vars). Both env vars are **required** — the
server refuses to start (`process.exit(1)`) without them, unless `AUTH_ALLOW_INSECURE=1` is
set explicitly for local dev / cluster-internal probes, in which case one loud warning is
logged at boot and every `/api/*` route is served unauthenticated. `GET /healthz` and
`GET /readyz` are always exempt from auth (kubelet probes send no `Authorization` header).
`GET /api/health/data` is **not** exempt — it is a data route the SPA calls.

## Common Query Parameters
Every data route below accepts these (parsed by `parseRange()` in `http.js` / `route()` in
`index.js`).
`POST /api/chat` (see the Chat section) is the one exception — it takes a JSON body instead.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | ISO 8601 datetime | No | Range start. Default: `to - 2 days` (workshop default). For uniq/existence endpoints (`overview/active-users`, `adoption/levels`, `adoption/timeseries`, and the leaderboard's active-days count), `from` is rounded down to the containing hour server-side, so up to 59 minutes of activity just before `from` can be included — a deliberate rollup-grain trade-off, negligible on multi-day ranges but noticeable on narrow (sub-hour) custom ranges |
| `to` | ISO 8601 datetime | No | Range end. Default: now |
| `group` | string (`bedrock`\|`enterprise`) | No | Filter by inferred experiment group. `unknown` sessions are excluded from group-scoped queries by default (~11% of sessions have no bedrock/enterprise signal) — a few "totals" endpoints (`active-users`, `adoption/levels`, `adoption/timeseries`, `cost/summary`, `overview/kpi`) include them instead since they report org-wide totals, not an A/B split |
| `user` | string | No | Filter by user email (partial match) |
| `model` | string | No | Filter by model name (partial match, normalized) |
| `intervalHours` | number | No | Bucket size for timeseries endpoints (fractional hours like `0.25` = 15 min for chart drag-zoom, 1 = hourly, 24 = daily, 168 = weekly). Only honored by endpoints marked *timeseries* below. Requests with `intervalHours < 1` are clamped to `1` server-side if the `from`/`to` span exceeds 4 hours (minute-bucket queries fall back to scanning the raw table, which is only cheap for narrow ranges). A value that is not a finite number in `(0, 744]` (744 = 24×31) is now rejected with **400** before any query runs, instead of being silently coerced to 24. |
| `email` | string | Only for `GET /api/users/{daily,decisions-by-tool,heatmap}` | Exact-match user email for the per-user drilldown endpoints. Not a general filter — ignored by every other route. |

For the three drilldown endpoints (`daily`/`decisions-by-tool`/`heatmap`), `group` is honored
and optional: omitted, they return the user's full activity across all sessions (including
`unknown`); passed, they scope to that session group — used by the Users page drawer, which
now opens from a per-user-x-group leaderboard row and passes that row's `group` so the
drilldown matches the row's own numbers.

## Endpoints

All data endpoints below are `GET`, take no request body, and return JSON (array of rows, or
a single object for snapshot endpoints). `POST /api/chat` is the sole exception (JSON body,
SSE response) — see the Chat section. See the Error Codes table below for the full set; in
short, a rejected query parameter returns `{"error": …, "detail": …}` with HTTP 400 before any
ClickHouse query runs, and any other failure returns `{"error": "internal error", "id": …}`
with HTTP 500.

### Overview
| Path | Returns |
|---|---|
| `GET /api/overview/kpi` | Group-level session/user/commit/PR/token/LOC summary |
| `GET /api/overview/active-users` | Ungrouped unique active user count (includes `unknown` sessions — a "totals" endpoint, see `group` param above) |
| `GET /api/overview/tokens-timeseries` | *timeseries* — token usage per group over time |
| `GET /api/overview/cache-efficiency` | Cache read ratio (`cache_read_ratio`) + token-type breakdown per group: `cache_read`, `input_side` (input + cacheRead + cacheCreation, the ratio's denominator), `uncached_input`, `cache_write`, `output_tokens` |
| `GET /api/overview/model-distribution` | Token distribution by group x model |

### Productivity
| Path | Returns |
|---|---|
| `GET /api/productivity/normalized` | LOC / commits per million tokens, per group |
| `GET /api/productivity/decisions` | Accept/reject counts per group |
| `GET /api/productivity/decisions-by-tool` | Accept/reject counts per group x tool |
| `GET /api/productivity/active-time` | *timeseries* — active-time seconds per group |
| `GET /api/productivity/agenticness` | *timeseries* — tool calls per prompt per group |
| `GET /api/productivity/engagement` | *timeseries* — daily users/sessions/PRs |
| `GET /api/productivity/loc-timeseries` | *timeseries* — lines added/removed per group |
| `GET /api/productivity/permission-wait` | *(2026-08-11, traces beta)* p50/p95 `claude_code.tool.blocked_on_user` wait time per group x `app_version`. Returns `{unsupported: true, minVersion: "2.1.214", rows: []}` instead of a zero row when no matching spans exist in range — that span type only exists on Claude Code ≥2.1.214 and requires `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` on the client. Not covered by the cache warmer (empty until the beta env rolls out). |
| `GET /api/productivity/ttft` | *(2026-08-11, traces beta)* p50/p95 time-to-first-token per group x model, from `claude_code.llm_request` spans. Same `{unsupported, rows}` shape as `permission-wait` (here `minVersion` is `null` — TTFT isn't version-gated, an empty result just means tracing isn't enabled yet). Not covered by the cache warmer. |
| `GET /api/productivity/interaction-breakdown` | *(2026-08-31, traces beta)* p50/p95 `claude_code.interaction` span duration per group, plus the share of that time spent in child spans (`llm_request` / `tool.execution` / `tool.blocked_on_user`), joined to the root interaction by `TraceId`. Same `{unsupported, rows}` shape as `permission-wait`, with `minVersion: "2.1.214"`. The three shares can sum to **more than 1** — child spans can overlap and a `tool` span's `duration_ms` covers permission wait + execution together, so read them as "time spent in this span type per unit of interaction time", not as a composition. Not covered by the cache warmer. |
| `GET /api/productivity/active-time-summary` | *(2026-09-01)* (`activeTimeSummary`) Snapshot per group: `user_seconds` / `cli_seconds` (from `active_time.total`, whose `type` attribute `'user'`\|`'cli'` rides the promoted `TokenType` column — measured 7d: cli 123h vs user 2.8h, the cli/user ratio is the "automation multiplier") + `sessions`. Feeds the Productivity KPI row and the Executive scoreboard. |
| `GET /api/productivity/languages` | *(2026-09-01)* (`languageBreakdown`) Per group x language: `edits` + `accepted` (`Decision='accept'`) from `code_edit_tool.decision`. `Language = ''` is folded into the literal `'unknown'` value that already exists in live data — one row, not two indistinguishable ones. Feeds the Productivity page's per-group language tables (accept rate is computed client-side). |

### Usage
| Path | Returns |
|---|---|
| `GET /api/usage/tool-mcp` | Tool/MCP invocation counts |
| `GET /api/usage/tool-decisions` | *(2026-08-31)* `tool_decision` event counts per group x tool x permission `source` (`config` = pre-allowed, `user_temporary` = prompted every time, `user_permanent` = user-allowlisted), with `accepts`/`rejects`/`n`/`accept_rate`. Limited to the top ~20 tools by fleet-wide volume (deliberately not per-group, so both groups are compared over the same tool set). `n != accepts + rejects` would mean a third `decision` value appeared. |
| `GET /api/usage/skills` | Skill invocation counts (subject to OTel redaction of third-party skill names) |
| `GET /api/usage/connectors` | MCP connector usage |
| `GET /api/usage/subagent-fanout` | *(2026-08-11)* Subagent completions per group, from `otel_logs`' `subagent_completed` event (not traces — this event needs no beta flag and has data today). Includes `avg_subagents_per_interaction` (keyed by `prompt.id`). |
| `GET /api/usage/skill-activations` | *(2026-08-11)* `skill_activated` event counts per group x skill x `invocation_trigger` (`user-slash`/`claude-proactive`/`nested-skill`) — the `claude-proactive` share is the signal for whether a skill fires on its own. |
| `GET /api/usage/compaction` | *(2026-08-11)* Compaction frequency + average compression ratio (`1 - post_tokens/pre_tokens`) per group x trigger, from `otel_logs`' `compaction` event. |
| `GET /api/usage/plugins` | *(2026-08-11)* Fleet-wide plugin inventory (no group split) from `plugin_loaded` events — plugin x marketplace, session-load and distinct-session counts. |
| `GET /api/usage/tool-latency` | *(2026-09-01)* (`toolLatency`) Per group x tool from `tool_result`: `uses`, `errors` (`Success='false'` **or** a non-empty `error` attribute — promoted `Success` alone misses rows that carry only an error message), p50/p95 of the promoted `DurationMs` (measured: Bash p50 281ms / p95 5008ms). Top 50 by uses, same cap as `tool-mcp`. Usage page. |
| `GET /api/usage/commands` | *(2026-09-01)* (`commandAdoption`) Returns `{commands, prompts}` — **an object, not a bare array** (two groupings of one `user_prompt` scan, `apiErrors` pattern). `commands`: per group x slash command (`command_name != ''` only) with `uses` and `users` (`uniqExactIf` over non-empty `UserEmail`, so `''` is never counted as a user). `prompts`: per group prompt count + p50/p95 `prompt_length` over **all** `user_prompt` events, plain natural-language prompts included. Usage page. |
| `GET /api/usage/hook-overhead` | *(2026-09-01)* (`hookOverhead`) Per group from `hook_execution_complete`: `executions`, `total_seconds`, `p95_ms` (per-execution `total_duration_ms`; measured 7d: 13,888s total, p95 213ms), and `blocked` = executions with `num_blocking > 0` — a count of executions, **not** a sum of `num_blocking`, so it shares the `executions` denominator and `blocked/executions` is a valid rate. Usage page. |
| `GET /api/usage/mcp-health` | *(2026-09-01)* (`mcpHealth`) Per group x MCP server from `mcp_server_connection` — server name is `LogAttributes['server_name']`, **not** the promoted `McpServerName` (that column is `tool_result`'s `mcp_server.name`): `attempts`, `connected`, `failed` (measured 7d: 1,229 / 56), `p95_ms`. `attempts` also counts `disconnected` rows, so it can exceed `connected + failed` — intentional. Usage page. |

### Reliability
| Path | Returns |
|---|---|
| `GET /api/reliability/refusals` | *(2026-08-11)* `api_refusal` counts per group, split into `user_visible_refusals` and `server_hidden_refusals` (`server_fallback_hop='true'` — the server already retried on a different model, so the user never saw it; keep this out of any refusal-rate total). |
| `GET /api/reliability/retries-exhausted` | *(2026-08-11)* `api_retries_exhausted` counts per group + average attempts/retry duration — a direct signal for Bedrock quota throttling. |
| `GET /api/reliability/api-errors` | *(2026-08-31)* Returns `{byModel, byStatus}` — **an object, not a bare array**. `byModel`: per group x model `requests` (`api_request`), `errors` (`api_error`), `total`, `error_rate`. `byStatus`: per group x HTTP `status_code`, with the sentinel `no-http-status` for errors that carry no status code at all (transport-level failures such as a stream idle timeout — measured 35 of 580, deliberately not dropped). `error_rate`'s denominator is `requests + errors` because whether `api_request` also fires for failed requests is not documented or measurable; at measured volumes the two readings differ by 0.33% relative, and the union denominator keeps the value inside [0,1] under either reading. |
| `GET /api/reliability/api-latency` | *(2026-09-01)* (`apiLatency`) Returns `{byModel, byEffort}` — **an object, not a bare array** (two groupings of one `api_request` scan, `apiErrors` pattern). Duration is `LogAttributes['duration_ms']` (measured 7d: p50 5,968ms / p95 36,262ms). `byModel`: per group x model (`normModel()`-normalized `LogAttributes['model']`) with `requests`/`p50_ms`/`p95_ms`. `byEffort`: same fields per group x effort, `effort = ''` mapped to `'unknown'` for parity with `cost/effort-mix`. Reliability page. |

### Integrity (A/B validity checks)
| Path | Returns |
|---|---|
| `GET /api/integrity/version-cohort-sessions` | *(2026-08-11)* Distinct session count per group x `app_version` (via `uniqExact(SessionId)`, not a `sum(Value)` of the cumulative counter) — surfaces whether the two groups are actually running the same Claude Code version. As of the 2026-08-11 spec sync, this fleet had 20 versions in play (2.1.202–2.1.226). |
| `GET /api/integrity/version-cohort-cost` | *(2026-08-11)* `cost.usage`/`token.usage`, session-boundary-diffed (same math as `incFlat`, computed locally rather than through it — see `dashboard/server/CLAUDE.md`), grouped by group x version cohort (`pre-2.1.214` / `>=2.1.214`). Exists to check, not assume, whether the pre-2.1.214 double-counting bug (usage streamed across multiple frames, each counted as a separate request) is present in this fleet's data. |

### Users
| Path | Returns |
|---|---|
| `GET /api/users/leaderboard` | Per-user x group metrics + productivity score (real session group, not majority-vote — a user active in both groups gets one row per group). Also includes `user_active_days`: group-agnostic distinct active days, identical across a straddling user's group rows — used to recompute an org-wide (ungrouped) productivity score without double-counting days a user was active in both groups |
| `GET /api/users/tools` | Per-user x group tool usage |
| `GET /api/users/skills` | Per-user x group skill usage |
| `GET /api/users/cost-efficiency` | Per-user x group `$/LOC`, `$/commit` |
| `GET /api/users/daily` | *timeseries* — daily sessions/LOC/tokens/commits for one user. **Requires `email` param** (exact match; not filtered by `user`/`model`). Optional `group` scopes to that session group. Not covered by the cache warmer. |
| `GET /api/users/decisions-by-tool` | Accept/reject counts per tool for one user. **Requires `email` param.** Optional `group` scopes to that session group. Not covered by the cache warmer. |
| `GET /api/users/heatmap` | GitHub-style daily session-count heatmap, last 91 days from `to`. **Requires `email` param**; ignores `from`. Optional `group` scopes to that session group. Not covered by the cache warmer. |

### Cost
| Path | Returns |
|---|---|
| `GET /api/cost/summary` | Group-level computed + reported cost, token breakdown |
| `GET /api/cost/by-model` | Cost/tokens per group x model |
| `GET /api/cost/by-user-model` | Cost/tokens per user x group x model (real session group, not majority-vote) |
| `GET /api/cost/by-model-daily` | *timeseries* — cost per group x model over time |
| `GET /api/cost/by-model-compare` | Current vs. previous equal-length period, per model |
| `GET /api/cost/tiers` | Cost broken down by token tier (uncachedInput/cacheRead/cacheWrite/output), split by group: `{"bedrock": {...}, "enterprise": {...}}` |
| `GET /api/cost/effort-mix` | *(2026-09-01)* (`effortMix`) Per group x effort level: `cost_usd` + `tokens`. `cost_usd` is the Claude-Code-**reported** `cost.usage` (same lower-bound basis as `version-cohort-cost`, not the pricing-table computed cost). Effort isn't an `incFlat` dimension, so this is a self-contained session-boundary local diff (ADR-001 pattern). `effort = ''` (rows with no effort attribute; measured 7d cost 578 vs medium 4,743 / high 1,576 / xhigh 307) → `'unknown'`; the `Speed` column is ignored (measured 0 rows fleet-wide). Cost page. |
| `GET /api/cost/by-agent` | *(2026-09-01)* (`agentCost`) Per group x subagent (`AgentName`, measured 7d: 4.56M non-empty rows; `'' → 'main'` = main-thread work): `cost_usd` (reported `cost.usage`, same basis as `effort-mix`) + `tokens`, via the same local-diff pattern. Ordered by cost, top 30. Cost page. |

### Adoption
| Path | Returns |
|---|---|
| `GET /api/adoption/levels` | DAU/WAU/MAU snapshot + total members |
| `GET /api/adoption/timeseries` | *timeseries* — DAU/WAU/MAU rolling window per day |

### Chat (AI Assistant)
| Path | Returns |
|---|---|
| `POST /api/chat` | Server-Sent Events stream. Body: `{"messages": [{"role": "user"\|"assistant", "content": "..."}]}`. Backed by Bedrock; internally allowed to run read-only ClickHouse SQL via a sandboxed tool — see `sanitizeSql()` in `dashboard/server/chat.js`. The route answers **503** unless auth is configured (or `CHAT_ALLOW_INSECURE=1`) **and** the server's boot probe (`assertReadonlySession()` in `clickhouse.js`, `SELECT toUInt8(getSetting('readonly'))`, re-run every 10 minutes) has confirmed the ClickHouse session is `readonly`. An undetermined probe (unreachable cluster, permission error) is treated the same as "not readonly" — fail-closed. |

### Health
| Path | Returns |
|---|---|
| `GET /healthz` | *(unauthenticated)* **Liveness.** `{"ok": bool}` — `ok` is a ClickHouse `ping()` result, but the status is **always 200**, so a cluster incident never restarts a healthy pod. This is the probe `infra/dashboard.tf` currently configures. |
| `GET /readyz` | *(2026-09-02, unauthenticated)* **Readiness.** `{"ready": bool}` with HTTP 200 when `ping()` succeeds and the process is not shutting down, 503 otherwise. Unlike `/healthz` it *does* fail on an unreachable ClickHouse (no reason to route traffic to a pod that cannot read) and it answers 503 for the rest of the process's life once `SIGTERM`/`SIGINT` arrives, so requests already in flight (or on an already-open connection) get a truthful "not ready" instead of a success. Measured 2026-09-02 on the running server: after `SIGTERM`, a **new** connection is refused outright, because Node's `server.close()` stops the listener in the same tick the flag is set — so the flip makes draining *honest*, but the time for a Service endpoint removal to propagate still has to come from a `preStop` hook / `terminationGracePeriod`, not from this route. Force-exits after `SHUTDOWN_TIMEOUT_MS` (10s) if sockets linger. |
| `GET /api/health/data` | *(2026-09-02, authenticated)* **Data freshness.** Body is `{"status": "ok"\|"stale"\|"unknown", "latest": ISO-8601\|null, "ageMinutes": int\|null, "staleAfterMinutes": int}`. HTTP **200** only for `ok`; **503** for both `stale` and `unknown` — a probe that goes quiet when it cannot measure would reproduce the silent-gap incident it exists to catch. `latest` comes from `max(TimeUnix)` on the raw `otel_metrics_sum` (not the hourly rollup, which lags up to an hour), bounded to the last 7 days for partition pruning; no rows in that window arrives as epoch `0` and is reported as `unknown`. Threshold is `DATA_STALE_MINUTES` (default `360`; a non-positive or non-numeric value throws at startup). Memoized server-side for 30s and served with `Cache-Control: no-store`. Skips the `route()` wrapper (no range params, and `route()` can only return 200/500) — the third such exception alongside `/healthz` and `/api/config`. Consumed by the SPA's `FreshnessBanner` and by `PageHeader`'s live pill. |

### Config
| Path | Returns |
|---|---|
| `GET /api/config` | `` `{"piiMask", "pricing", "schema", "groupMode", "defaultRangeDays", "rangeCapDays"}` `` — runtime config for the SPA; touches no ClickHouse and takes no range parameters. |

- **`piiMask`** — whether the frontend should mask user emails (`oj******@gmail.com`). Reflects the server's `PII_MASK_ENABLED` env var (`"1"` or `"true"`, case-insensitive = on; anything else = off). Fetched once by `web/src/main.jsx` before the first render (3s timeout), since the image is built once and reused across deployments. **Two-layer default:** the app defaults to off when the env var is unset, but `var.pii_mask_enabled` **defaults to `true`**, so the standard Terraform deployment (public demo URL) ships masking **on** — the workshop account is the one that flips it to `false`. The frontend is fail-closed: if this endpoint errors, times out, or returns a non-`false` `piiMask`, it masks. Masking is **display-level only**: the data endpoints above always return raw emails, so anyone past Basic Auth can read them from the network tab — it protects a shared screen or a public URL, not the data itself. The one env-independent exception is the chat path's ClickHouse error echo, which is always masked.
- **`pricing`** — `{"cacheWriteTtl": "1h"|"5m", "overriddenModels": [str]}`. `pricing.cacheWriteTtl` is the server's cache-write TTL assumption from `PRICING_CACHE_WRITE_TTL` ("1h" default, "5m" otherwise), surfaced because OTel's cache-creation TokenType can't distinguish 5m from 1h writes, so this figure on the Cost page is an assumption, not a measurement. `pricing.overriddenModels` lists the model keys whose rates came from `PRICING_JSON` (empty on a default deploy), so a viewer can tell built-in list prices from an operator's negotiated ones. As of 2026-09-02 the built-in table also covers `claude-fable-5-1` / `claude-mythos-5` / `claude-mythos-5-1` / `claude-opus-4-1` / `claude-opus-4` / `claude-sonnet-4` (the `-5-1` pair carries an explicit `cacheRead` of `$0.25`, a 0.025x exception to the usual 0.1x derivation), and the geo-prefix normalization now strips `us-gov.` / `jp.` / `au.` in addition to `us.` / `eu.` / `apac.` / `global.`. The rates themselves are deliberately not exposed by this endpoint. `pricing` is informational — the SPA does not currently read it.
- **`schema`** — `{"segmentAwareSeriesKey": bool|null}`. `true`/`false`/`null`: `true` means the cluster has migration-003's segment-aware `SeriesKey` expression in force, `false` means it still has the legacy expression, and `null` means undetermined — it is probed from the newest `claude_code.cost.usage` rows (at boot and every 10 minutes) rather than assumed, and mixed keys mid-`MATERIALIZE COLUMN`, no recent rows, or any probe error all collapse to `null`. The SPA's `LowerBoundNote` reads it fail-safe: only `true` drops the `--resume` cause from the lower-bound callout, and every other value keeps the full warning. `schema` is consumed by the SPA.
- **`groupMode`** — `"ab"` (default) or `"single"`. `"single"` collapses the A/B pairs in the SPA — presentation only, the queries are unchanged.
- **`defaultRangeDays`** — default `2`; the same value the server's cache warmer pre-computes.
- **`rangeCapDays`** — default `90`; a longer requested span is a 400.

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request — a rejected query parameter, returned by every `route()`-wrapped `/api/*` endpoint **before** any ClickHouse query runs (so an invalid request never creates a cache entry). Body is `{"error": "invalid range"|"invalid intervalHours"|"range too long", "detail": "<which parameter and why>"}`. Causes: an unparseable `from`/`to`, `from >= to`, an `intervalHours` outside `(0, 744]`, or a span longer than `rangeCapDays`. `detail` never echoes the submitted value. |
| 401 | Unauthorized — missing/invalid Basic Auth credentials. `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` are required: without both the server refuses to start (exit 1) unless `AUTH_ALLOW_INSECURE=1` is set, in which case no request is authenticated and nothing returns 401. |
| 500 | Internal Server Error — usually a ClickHouse query error. Body is `{"error": "internal error", "id": "<uuid>"}` and **never** carries the underlying exception message: a `ClickHouseError` text embeds the whole failing SQL. Grep the pod log for `[<id>]` to get the real error. |
| 503 | Service Unavailable — `/readyz` while draining or with ClickHouse unreachable; `/api/health/data` when data is `stale` or `unknown`; `POST /api/chat` when auth is not configured, or when the server has not confirmed its ClickHouse session is `readonly`. Data routes never return 503. |

## Rate Limits
None enforced at the application layer. The dashboard is used by a small workshop cohort;
if this changes, add rate limiting before removing this note.
