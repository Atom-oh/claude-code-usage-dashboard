# API Reference

The source of truth is the explicit route table in
[dashboard/server/index.js](../dashboard/server/index.js), with SQL and result shaping in
[queries.js](../dashboard/server/queries.js). Paths below are relative to the dashboard
origin; the local Compose origin is `http://localhost:8080`.

## Authentication and request parameters

HTTP Basic Auth applies globally using `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD`.
Without both, startup fails unless `AUTH_ALLOW_INSECURE=1` explicitly enables local
unauthenticated use. Only `/healthz` and `/readyz` bypass auth. Chat has additional gates.

Wrapped GET data routes validate these parameters before querying or caching:

| Parameter | Contract |
|---|---|
| `from`, `to` | Date strings; use ISO 8601 with timezone. Defaults: `to=now`, `from=to-DEFAULT_RANGE_DAYS`. Require `from < to`; default range is two days and default cap is 90 days. |
| `intervalHours` | Default 24. Must be finite and in `(0,744]`, even on routes that ignore buckets. Values below one are clamped to one when the range exceeds four hours. Only rows marked **B** below honor this parameter. |
| `group` | Exact inferred channel match, normally `bedrock`, `enterprise` or `unknown`; it is not a coding-client selector. |
| `user` | Case-insensitive substring of the query's identity expression, usually `UserEmail`. |
| `model` | Case-insensitive substring after the query's model normalization; scope varies by endpoint. |
| `project` | Exact project tag, only for the four Usage routes listed below and only while `schema.projectColumns === true`. `(untagged)` maps to the stored empty string. |
| `email` | Supply an exact identity for the four user drilldown routes. Omission is coerced to an empty string, not rejected as a missing required parameter; callers must not rely on uniform behavior without it. |
| `includeUnknown` | Only `/api/cost/by-user-model` recognizes the literal `1`, including unknown-channel rows in that result. |

Minute/day widths are rounded by `bucket()` where needed. Dates are bound to ClickHouse at
second precision. Historical rollup ends, latest-hour data and existence queries have
specific approximations; see [time boundaries](reference/data.md).
Config, health and chat routes do not use this range wrapper.

## Filter scope

Forwarded parameters are not universally implemented. [filterCond](../dashboard/server/queries.js)
applies a filter only when the query supplies its column expression.

| Queries | Actual scope |
|---|---|
| Most A/B queries | Exclude `unknown` by default; an explicit `group=unknown` bypasses that default exclusion. |
| `kpiSummary`, `costSummary`, `activeUsers`, `adoptionLevels`, `adoptionTimeseries` | Include unknown-channel rows when no channel is selected. |
| `activeUsers`, adoption routes | Honor group/user; ignore model and project. Adoption snapshots ignore `from` and use windows ending at `to`. |
| Integrity version cohorts | Honor group only; ignore user/model/project. |
| Plugin inventory | Range only; no group/user/model/project filtering. |
| Subagent fanout, skill activations, compaction, refusals, exhausted retries, permission wait, interaction breakdown | Honor group/user; ignore model/project. TTFT separately supports row-level model filtering. |
| Mixed metric queries | Model-bearing rows match directly; model-less session/commit/PR/LOC/decision/activity rows use a matching-session semi-join when `modelMixed` is configured. |
| Many log queries | `modelViaSession` accepts every matching session's events if that session has a matching model in the rollup lookback. This is not event-level model attribution. |
| Reported-vs-computed and entrypoints | Match the model on each `api_request` log row. |
| User daily/decisions/heatmap | Exact `email` and optional `group`; ignore global user/model/project. With no group, include all channels. Heatmap uses 91 days ending at `to`, ignoring `from`. |
| User interactions | Exact `email` and range only; ignores group/user/model/project. |
| Projects, permission modes, decision sources, entrypoints | The only queries applying project filters. Projects filter identity using the email/EndUserId fallback; the other three filter `UserEmail`. |

`GROUP_MODE=single` affects frontend presentation only. The project filter is silently dropped
on both server and frontend unless the project probe is true. `/api/usage/projects` also
returns `[]` while gated off; the other three routes can run without the new columns when
no project predicate is applied. The probe checks logs only, not every table or migration.

## Response conventions

All endpoint tables below describe GET JSON responses. Unless explicitly marked **object**,
a response is an array. Numeric ClickHouse fields may arrive as strings; derived JavaScript
fields are numbers or null. **B** means a configurable time bucket, not necessarily a day.

**Token fields** means `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`.
**Priced row** means those fields plus `reported_cost`, computed `cost`, and `unpriced`.
An unknown server rate yields `cost: null, unpriced: true`; it does not invalidate a valid
client-reported spend value. Summary/effort/agent aggregates retain `unpriced_tokens`.

**Trace result** means `{unsupported:false, rows:[...]}` when matching spans exist, otherwise
`{unsupported:true, minVersion, rows:[]}`. `minVersion` is present on the unsupported result,
not guaranteed on success. An empty trace result is not measured zero; missing tables or
query failures still use the normal error path.

### Overview

| Path | Fields and grain |
|---|---|
| `/api/overview/kpi` | Per `group`: `sessions`, `users`, `commits`, `prs`, `total_tokens`, `input_tokens`, `output_tokens`, `lines_of_code`. Its row-existence user count is not a substitute for `active-users`. |
| `/api/overview/active-users` | **Object**: `users`, `bedrock_users`, `enterprise_users`; distinct nonempty emails with session-counter rows in range. |
| `/api/overview/tokens-timeseries` | **B**, per `t, group`: `tokens`, `input_tokens`, `output_tokens`. |
| `/api/overview/cache-efficiency` | Per `group`: `cache_read`, `input_side`, `cache_read_ratio`, `uncached_input`, `cache_write`, `output_tokens`. Input side includes uncached input, cache read and cache creation. |
| `/api/overview/model-distribution` | Per `group, model`: `tokens`, `input_tokens`, `output_tokens`. |

### Productivity

| Path | Fields and grain |
|---|---|
| `/api/productivity/normalized` | Per `group`: `loc`, `tokens`, `loc_per_million_tokens`, `commits`, `commits_per_million_tokens`. |
| `/api/productivity/decisions` | Per `group, decision`: `n`, from the code-edit permission-decision counter. |
| `/api/productivity/decisions-by-tool` | Per `group, tool, decision`: `n`; excludes empty tool names. |
| `/api/productivity/active-time` | **B**, per `t, group`: `active_seconds`, summing active-time types. |
| `/api/productivity/active-time-summary` | Per `group`: `user_seconds`, `cli_seconds`, distinct `sessions` in the active-time aggregation. |
| `/api/productivity/agenticness` | **B**, per `t, group`: `prompts`, `tool_calls`, `tool_calls_per_prompt`, from log events. |
| `/api/productivity/engagement` | **B**, per `t` after filters, with no group column: `users`, `sessions`, `prs`, `prs_per_user`. |
| `/api/productivity/loc-timeseries` | **B**, per `t, group`: `loc_added`, `loc_removed`. |
| `/api/productivity/languages` | Per `group, language`: `edits`, `accepted`; empty language becomes `unknown`. These are decision counts, not quality measurements. |
| `/api/productivity/permission-wait` | **Trace result**, `minVersion: "2.1.214"`; per `group, app_version`: `p50_wait_ms`, `p95_wait_ms`, `n`, from `tool.blocked_on_user`. |
| `/api/productivity/ttft` | **Trace result**, `minVersion: null`; per `group, model`: `p50_ttft_ms`, `p95_ttft_ms`, `n`, from `llm_request`. |
| `/api/productivity/interaction-breakdown` | **Trace result**, `minVersion: "2.1.214"`; per `group`: `interactions`, `p50_interaction_ms`, `p95_interaction_ms`, `llm_share`, `tool_exec_share`, `blocked_share`. |

Trace shares join child spans to interactions by `TraceId`. Overlap means shares can sum
above one; they are not a partition of elapsed time. These three trace routes are excluded
from cache warming. The beta setting and matching span/version coverage must be checked
before interpreting absence.

### Usage

| Path | Fields and grain |
|---|---|
| `/api/usage/tool-mcp` | Per `group, tool, mcp_server`: `ok`, `fail`, `total` from `tool_result`; ordered by group then volume, **50 returned rows total**. Only explicit success/false flags enter `ok`/`fail`. |
| `/api/usage/tool-decisions` | Per `group, tool, source`: `accepts`, `rejects`, `n`, `accept_rate`, from `tool_decision`. Selects the top 20 tool names by unfiltered fleet volume in range, then applies outer filters. Rate is accepts/(accepts+rejects), not accepts/n. |
| `/api/usage/skills` | Per `group, skill`: `invocations`, `est_cost_usd`. Counts `incFlat` cost-series rows and sums reported cost; not a direct activation count. |
| `/api/usage/connectors` | Per `group, connector`: `users`, `calls`, `ok`, from `tool_result` with a nonempty MCP server. |
| `/api/usage/subagent-fanout` | Per `group`: `subagent_completions`, `interactions`, `avg_subagents_per_interaction`; denominator is distinct nonempty `PromptId` among completion events. |
| `/api/usage/skill-activations` | Per `group, skill, trigger`: `invocations`, counting `skill_activated` events. |
| `/api/usage/compaction` | Per `group, trigger`: `compactions`, `sessions`, `compactions_per_session`, `avg_compression_ratio`; counts only compactions with positive pre-token count. |
| `/api/usage/plugins` | Fleet `plugin, marketplace`: `session_loads`, `sessions`, from nonempty `plugin_loaded` names. |
| `/api/usage/tool-latency` | Per `group, tool`: `uses`, `errors`, `p50_ms`, `p95_ms`; errors include explicit false success or a nonempty error attribute. Ordered by group then uses, **50 returned rows total**. |
| `/api/usage/commands` | **Object** `{commands, prompts}`. Commands: `group, command, uses, users`, excluding empty command names. Prompts: `group, prompts, p50_len, p95_len`, over all user-prompt events. |
| `/api/usage/hook-overhead` | Per `group`: `executions`, `total_seconds`, `p95_ms`, `blocked`; blocked counts executions with `num_blocking > 0`, not the sum of that attribute. |
| `/api/usage/mcp-health` | Per `group, server`: `attempts`, `connected`, `failed`, `p95_ms` from `mcp_server_connection`. Other statuses also enter attempts. |
| `/api/usage/projects` | Per `group, project`: reported `cost_usd`, `tokens`, `sessions`, `users`; empty project becomes `(untagged)`. Counts sessions/users only with cost/token rows in range. Returns `[]` unless the project gate is true. |
| `/api/usage/permission-modes` | Per `group, from_mode, to_mode`: `changes`, `sessions` from `permission_mode_changed`; mode values pass through. |
| `/api/usage/decision-sources` | Per `group, decision_source, decision_type`: `tool_results`, `share` from `tool_result`, excluding empty decision sources. Share is within channel, rounded to three decimals. |
| `/api/usage/entrypoints` | Per `group, entrypoint`: `requests`, `sessions`, reported `cost_usd`, `users` from `api_request`; empty entrypoint becomes `terminal`. Reads the entrypoint map directly. |

`tool_decision.source` and `tool_result.decision_source` describe different event populations.
MCP health reads `server_name`, while connector/tool-result queries use promoted fields
parsed from `tool_parameters`. Counts, quantiles and rates therefore need their own denominators.

### Reliability and integrity

| Path | Fields and grain |
|---|---|
| `/api/reliability/refusals` | Per `group`: `user_visible_refusals`, `server_hidden_refusals`; the latter have `server_fallback_hop='true'`. Keep them separate when describing visible failures. |
| `/api/reliability/retries-exhausted` | Per `group`: `exhausted_retries`, `avg_total_attempts`, `avg_retry_duration_ms`. It does not isolate throttling as the cause. |
| `/api/reliability/api-errors` | **Object** `{byModel, byStatus}`. By model: `group, model, requests, errors, total, error_rate`. By status: `group, status_code, errors`; missing status becomes `no-http-status`. |
| `/api/reliability/api-latency` | **Object** `{byModel, byEffort}`; each row has `group`, model/effort, `requests`, `p50_ms`, `p95_ms`. Empty effort becomes `unknown`; duration comes from `api_request.duration_ms`. |
| `/api/reliability/reported-vs-computed` | Bare array per `group, app_version, model`: `requests`, priced-row fields and `ratio = reported_cost / cost` when computed cost is positive, otherwise null. Source is `api_request` logs. |
| `/api/integrity/version-cohort-sessions` | Per `group, app_version`: distinct `sessions` with nonempty version and session-counter rows in range. |
| `/api/integrity/version-cohort-cost` | Per `group, version_cohort`: reported `cost_usd`, `tokens`, `usd_per_million_tokens`. Cohorts are `pre-2.1.214` and `>=2.1.214`; raw series are differenced locally. |

API error rate is `api_error / (api_request + api_error)` event counts. The code does not
establish whether failed requests also emit `api_request`, so this is not a deduplicated
request failure probability. Reported/computed ratios diagnose differences in pricing,
TTL assumptions or collection; they do not prove a specific bug or invoice accuracy.

### Users

| Path | Fields and grain |
|---|---|
| `/api/users/leaderboard` | Per `user, group`: `sessions`, `tokens`, `input_tokens`, `output_tokens`, `loc`, `commits`, `prs`, `accepted`, `decisions`, `active_days`, `user_active_days`, `accept_rate`, `productivity_score`. |
| `/api/users/tools` | Per `user, group, tool`: `uses` from tool-result logs. |
| `/api/users/skills` | Per `user, group, skill`: `invocations`, counting raw cost datapoints rather than activation events. |
| `/api/users/cost-efficiency` | Per `user, group`: computed `cost`, `unpriced`, `reported_cost`, `reported_unpriced`, `loc`, `commits`, `cost_per_loc`, `cost_per_commit`. Ratios use reported cost. |
| `/api/users/daily` | Exact-email daily `t, sessions, loc, tokens, commits`; fixed daily buckets. |
| `/api/users/decisions-by-tool` | Exact-email `group, tool, decision, n`. |
| `/api/users/heatmap` | Exact-email `d, sessions`, fixed 91-day lookback ending at `to`. |
| `/api/users/interactions` | **Trace result**, `minVersion: "2.1.214"`; `session_id`, `trace_id`, UTC `started_at`, `interaction_ms`, `llm_ms`, `tool_exec_ms`, `blocked_ms`, `agents`, `llm_calls`; newest **200** interactions. |

`user_active_days` is the distinct-day union within the query's filtered population, shared
across a user's channel rows; summing per-channel active days can double-count dates.
`agents` is a distinct-agent count, not agent depth. Child duration totals can exceed the
interaction duration. All four drilldowns are excluded from cache warming.

### Cost

Primary spend consumers use `reported_cost` through frontend
[spend.js](../dashboard/web/src/spend.js). Original `cost` or summary `computed_cost` remains
a token-price diagnostic. The API does not add display-status fields globally. Missing
reports and zero reports with positive tokens are unpriced at spend consumers; positive
aggregates are not proof of complete capture. See [metrics](metrics.md).

| Path | Fields and grain |
|---|---|
| `/api/cost/summary` | Per `group`: `computed_cost`, `reported_cost`, token fields, `unpriced_tokens`, `sessions`; includes unknown-channel rows by default. |
| `/api/cost/by-model` | Per `group, model`: priced row plus `tokens`. |
| `/api/cost/by-user-model` | Per `user, group, model`: priced row plus `tokens`; nonempty email/model required. `includeUnknown=1` broadens channel coverage. |
| `/api/cost/by-model-daily` | **B**, per `day, group, model`: priced row. The field is named `day` even for sub-day buckets. |
| `/api/cost/by-model-compare` | Per `model` across selected channels: current priced-row fields, `prev_reported_cost`, previous token fields prefixed `prev_`, and computed `prev_cost`; previous period derived server-side. |
| `/api/cost/tiers` | **Object** `{bedrock, enterprise}`, each with computed `uncachedInput`, `cacheRead`, `cacheWrite`, `output`; unknown rates are skipped. |
| `/api/cost/effort-mix` | Per `group, effort`: computed `cost`, `reported_cost`, `tokens`, `unpriced_tokens`; empty effort becomes `unknown`. |
| `/api/cost/by-agent` | Per `group, agent`: computed `cost`, `reported_cost`, `tokens`, `unpriced_tokens`; empty agent becomes `main`. Returns the top **30 by computed cost** after aggregation. |

The Cost UI reorders the returned agent subset by reported spend and shows at most 15;
this is not a fleet-wide top-15 query by reported spend. Its computed comparison is opt-in.
Efficiency ratios are null when reports are unpriced or denominators are zero, independently
of server rate coverage. Token-tier dollars are estimates under the configured cache-write
TTL, not an exact allocation of reported spend.

### Adoption

| Path | Fields and grain |
|---|---|
| `/api/adoption/levels` | **Object** `total_members`, `mau`, `wau`, `dau`; nonempty emails on session-counter rows before `to`. Members covers retained history; active windows are 30, 7 and 1 days. |
| `/api/adoption/timeseries` | Daily `t, dau, wau, mau, stickiness`; UTC day unions over trailing 1/7/30 days. `stickiness` is a **percentage (0-100)**, not a fraction. |

### Chat

`POST /api/chat` takes JSON history and returns SSE, not a JSON row array:

```json
{"messages":[{"role":"user","content":"Summarize reported spend for the last day."}]}
```

It returns 503 unless auth is configured (or `CHAT_ALLOW_INSECURE=1`) and
`assertReadonlySession()` has confirmed a readonly ClickHouse session. The probe runs at
startup and every ten minutes; unknown status is fail-closed. Per-process IP limits return
429 before streaming. SSE events are `status` (`message`, optional `sql`), `thinking`
(`text`), `text` (`text`), `done` (`{}`), or `error` (`message`). Once streaming starts,
failures are SSE events on HTTP 200. Successful streams use `Cache-Control: no-cache`.
See [chat limits and prompt gaps](reference/agent-llm.md).

### Health and config

| Path | Response |
|---|---|
| `/healthz` | HTTP 200 `{ok:boolean}` from ClickHouse ping, even when false. |
| `/readyz` | `{ready:boolean}`, HTTP 200 when ready, 503 when draining or ping fails. |
| `/api/health/data` | `{status, latest, ageMinutes, staleAfterMinutes}`; status is `ok`, `stale` or `unknown`. HTTP 200 only for `ok`, 503 otherwise. |
| `/api/config` | `{piiMask, pricing, schema, groupMode, defaultRangeDays, rangeCapDays}`; reads in-memory configuration/probe snapshots, with no query in this handler. |

Freshness probes raw `otel_metrics_sum` over the last seven days, memoized for 30 seconds.
`latest` is ISO 8601 or null; `ageMinutes` is an integer or null. `DATA_STALE_MINUTES`
defaults to 360 and must be positive and below 10,080. Missing or failed measurement is
unknown, not healthy. Process shutdown and manifest probes are described in
[runtime](reference/infrastructure.md).

Config fields:

- `piiMask`: true for case-insensitive `PII_MASK_ENABLED=1` or `true`; otherwise false.
  Terraform defaults masking on. The frontend masks unless this response explicitly says
  false. Ordinary API payloads still contain raw identities.
- `pricing`: `{cacheWriteTtl, overriddenModels}`. TTL is `1h` by default or `5m` when
  configured; invalid values fail startup. Override names come from `PRICING_JSON`.
  Rates are not exposed. Cost displays this TTL as an assumption in computed diagnostics.
- `schema.segmentAwareSeriesKey`: true, false or null from up to 2,000 newest cost datapoints
  within 24 hours. Mixed, absent or failed evidence is null; this does not certify old data
  or rollup rebuild completion.
- `schema.migrations`: sorted distinct ledger versions; null means undetermined/missing
  ledger, while `[]` means a readable empty ledger.
- `schema.projectColumns`: true after `SELECT ProjectName, Entrypoint FROM
  claude_code.otel_logs LIMIT 0` succeeds; numeric server errors yield false, transport or
  other undetermined failures yield null. This checks **logs only**, not metric/trace
  columns or all migration-005 steps. All schema probes refresh every ten minutes.
- `groupMode`: `ab` or `single`; `defaultRangeDays` defaults 2 and `rangeCapDays` defaults 90.
  Invalid startup settings are rejected, including a cap below the default range.

## Errors and operational limits

| Status | Contract |
|---|---|
| 400 | Wrapped route validation: `{error, detail}` for invalid range/interval or excessive span. The detail does not echo submitted values. |
| 401 | Missing or invalid Basic Auth when auth is enabled. |
| 429 | Chat's per-process IP limit. |
| 500 | Wrapped query failure: `{error:"internal error", id:"<uuid>"}`. The full exception is logged under the ID, not returned. |
| 503 | Not-ready/freshness states or unmet chat gates. Ordinary wrapped data-query failures are 500. |

After authentication, JSON API middleware sets `no-store`; the server's bounded promise cache is separate.
There is no general data-route rate limit or pagination contract. Named row caps above are
part of the returned subset. See [API implementation](reference/api.md) for cache and warmer
behavior, and [security](reference/security.md) for SQL and identity boundaries.

For an authenticated local port-forward, set `BASIC_AUTH_USER` to your authorized username.
`curl` prompts for the password instead of placing it in the command arguments:

```bash
curl --fail-with-body --get http://localhost:8080/api/cost/by-model \
  --user "$BASIC_AUTH_USER" \
  --data-urlencode 'from=2026-09-01T00:00:00Z' \
  --data-urlencode 'to=2026-09-03T00:00:00Z' \
  --data-urlencode 'group=bedrock'
```

Outside a local port-forward, use the deployment's authorized HTTPS origin.
