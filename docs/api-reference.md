# API Reference

The source of truth is the explicit route table in
[dashboard/server/index.js](../dashboard/server/index.js), with SQL and result shaping in
[queries.js](../dashboard/server/queries.js). Paths below are relative to the dashboard
origin; the local Compose origin is `http://localhost:8080`.

## Authentication and request parameters

`AUTH_MODE=basic` (default) applies Basic Auth globally using `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD`.
Without both, startup fails unless `AUTH_ALLOW_INSECURE=1` explicitly enables local
unauthenticated use. Only probes bypass this gate. Explicit `AUTH_MODE=oidc` uses organization
login/session cookies; login/callback and origin-checked local logout are protocol exceptions.
Telemetry/config/static routes require a session and never fall back to Basic.
Chat requires analyst/admin permission in OIDC plus existing readonly/activation gates.
The opt-in device-ingestion namespace uses separate machine credentials as described below;
browser cookies never authorize that namespace.
See [SSO operations](runbooks/organization-sso.md).

`GET /api/session` returns `mode`, `role`, `permissions` and, for OIDC, current-user `name`
and `expiresAt`, without raw subject/IdP tokens. Optional `refreshExpiresAt` is the
absolute login deadline, present only while renewal is enabled and a valid refresh
cookie matches the current principal; `expiresAt` remains the short authorization deadline.
`/api/session` renews credentials within 60 seconds of short-session expiry when a
valid refresh cookie is present and renewal can extend that deadline; other protected
requests renew expired principals.
`/api/config` includes this `session`.
Unauthenticated OIDC APIs return JSON 401, `error=authentication_required`,
`loginUrl=/auth/login`. Unsafe session requests without the configured Origin or without
required permission return 403. Transient refresh failures return 503,
`error=authentication_temporarily_unavailable`, with `Retry-After: 5`. A rotated refresh
response requires a fresh login because this mode does not retain rotating credentials.

`GET /auth/login` starts OIDC; `GET /auth/callback` completes it. `POST /auth/logout`
requires the configured Origin, clears local cookies, revokes any retained refresh
credential and redirects to `/`. Concurrent or replayed revocations share bounded work;
see [SSO operational limits](runbooks/organization-sso.md#rotation-logs-and-recovery).
Failed revocation or admission exhaustion returns a visible 503 after clearing
cookies. Logout does not end IdP SSO or immediately revoke copied short principal cookies.
Protocol responses are `no-store`.

`GET /api/installation` requires `installation:read` in OIDC mode; Basic/development
retain their existing full-installation access. It uses the shared response/error wrapper,
but is a current snapshot without usage-range/filter semantics. A single per-process
30-second memo deduplicates DB/receipt probes. Unauthorized roles are rejected before
probing; disabled clients are not queried or shown.

The response has `checkedAt`, `state=operational|needs_attention`, `release`,
`authentication`, `database`, `schema`, `clients`, `staleAfterMinutes` and explicit limits.
Each enabled client's seven-day receipt is `receiving`, `stale`, `empty` or `unavailable`.
Empty is not a token/cost zero; unavailable is not empty. Readonly/schema fields include
their cached probe timestamps. Ledger records do not prove actual DDL/rebuild completion;
receipt does not prove complete telemetry, OIDC configuration does not prove MFA, and no
backup or full commercial-release claim is made. `release.revision` is null unless the
runtime supplies a valid Git SHA through `APP_REVISION`.

### Device collection

`/api/collector` management routes require OIDC `collector:manage` (analyst/admin).
Unsafe requests retain the existing exact-Origin gate. Responses and downloads are
`no-store`; viewer/demo requests are denied before store or file access.

| Method and path | Contract |
|---|---|
| `GET /api/collector` | Feature state, public ingestion endpoint, Collector version, supported platforms and 30-day token lifetime. |
| `GET /api/collector/devices` | Owner-scoped `devices` and `nextCursor`; up to 50 records per page. Supply the returned `cursor` unchanged. |
| `POST /api/collector/devices` | `{name, platform}` where name is 1–64 characters without controls and platform is `linux` or `darwin`; 201 returns `device` and the token once. |
| `DELETE /api/collector/devices/:id` | Revoke an owned device; 204 for existing/already revoked, 404 for absent. |
| `GET /api/collector/package/:platform` | Authenticated installer archive for `linux` or `darwin`; no credentials embedded. |
| `POST /api/ingest/v1/{logs,metrics,traces}` | Device bearer token only; OTLP JSON/protobuf, at most 2 MiB, no content compression. |

Device fields are `id`, `name`, `platform`, `createdAt`, `expiresAt`, `revokedAt`
and `lastSeenAt`; dates are ISO strings or null. Tokens are ingestion-only, expire
30 days after issuance and may remain cached on another replica for up to ten seconds
after revocation. Last receipt does not prove database persistence. These APIs do not
use usage range/filter semantics. See [device operations](runbooks/device-collectors.md)
for installation, identity limitations, resource bounds and offboarding.

Wrapped GET data routes validate these parameters before querying or caching:

| Parameter | Contract |
|---|---|
| `from`, `to` | Date strings; use ISO 8601 with timezone. Defaults: `to=now`, `from=to-DEFAULT_RANGE_DAYS`. Require `from < to`; default range is two days and default cap is 90 days. |
| `intervalHours` | Default 24. Must be finite and in `(0,744]`, even on routes that ignore buckets. Values below one are clamped to one beyond four hours, except the bounded shared-overview fine resolution below. Only rows marked **B** below and shared overview honor this parameter. |
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

Wrapped data responses negotiate gzip for JSON bodies of at least 4 KiB. They retain
`Cache-Control: no-store` and add `Vary: Accept-Encoding`; compression does not change
authentication, range/filter cache keys, null values, or JSON escaping. Health
responses and streaming chat keep their separate response handling.

## Coding-client views

[Activation](runbooks/codex-telemetry.md) controls `/api/config`'s
`enabledClients`/`codexEndpoint`; disabled Claude routes return 404, stop warming/chat.

`GET /api/clients/overview` returns `clients`, `totals`, `by_client`, `by_model`,
`by_user`, `by_project`, `timeseries`, `tools` and metadata below.
`client=all|claude|codex` selects enabled sources;
`backend=all|bedrock-mantle|bedrock-runtime|anthropic|unknown`. Invalid/disabled clients,
arrays and nonempty group/project filters fail before caching.
Backend is resolved from the model id prefix first (region prefix → runtime, bare vendor
namespace → mantle), falling back to the resource tag (Codex) or the enterprise channel
(Claude → `anthropic`); otherwise `unknown`. See
[ADR-017](decisions/ADR-017-backend-cost-fallback.md).

Claude model terms normalize. Modeled rows match directly.
Model-less rows use same-client model evidence (logs; Claude also uses token/cost
counters) within the range and identical session (nonempty), user, backend and project.
Coarse session attribution can match several models; rows retain `model=""`.

`observed_tokens` sums known input/output pairs; `tokens_partial` discloses incomplete
usage/validation or unsafe sums. Cache and reasoning subsets are not added again.
Unpriced models can still have complete observed tokens. All-unknown is null and
known zero is retained. Primary token displays/CSV use observed counts with coverage
status; canonical `tokens` and components retain strict nulls for ratios and existing
consumers. These fields also appear in Codex detail summary/Effort rows. See
[ADR-014](decisions/ADR-014-observed-token-subtotals.md).

`cost_usd` uses `cost_basis=client_reported` (Claude) or `aws_list_estimate` (Codex), or
(Claude, this endpoint only) `computed_estimate`/`mixed` for a token-priced fallback when
no report is usable ([ADR-017](decisions/ADR-017-backend-cost-fallback.md)); `cost_estimated`
counts those rows. Claude rows for non-Anthropic models carry `aws_list_estimate`: their
counter cost is rescaled to the AWS list price ([ADR-017 amendment](decisions/ADR-017-backend-cost-fallback.md#amendment-2026-10-07-non-anthropic-models-used-through-claude-code)),
on this endpoint and in the legacy cost views' `reported_cost`.
It sums usable reports/estimates even when other records are unpriced.
`cost_partial` discloses exclusions or an unsafe aggregate; `unpriced` counts remain.
Groups with only unpriced evidence remain null; explicit zero stays zero.
Positive Claude reports remain usable with missing token fields; zero reports still
require known zero usage. Codex estimates still require valid usage and a known rate
(its own table, or the Claude table for an Anthropic model; `price_source: "claude_table"`).
Cost unit values use the known subtotal and observed denominators, with partial
labels in the UI/CSV. See [ADR-013](decisions/ADR-013-known-cost-subtotals.md).
User counts union IDs; sessions include client; model identity counts overlap.
`by_project` uses Codex `project.name`, not billing projects. Request/TTFT durations
are observed means or null. `requests` includes `api_error` attempts.

`observed_records`: deduplicated logs plus active Claude usage rows. Zero can coexist
with idle counter observations in `timeseries`; check both for an empty response.
Idle timeline rows carry `timeline_observed=true`, independent token/cost availability and partial flags
without adding active users/sessions or changing other aggregates. See
[ADR-015](decisions/ADR-015-idle-chart-buckets.md) for chart zero semantics.

`rejected_requests` counts explicit HTTP rejections. Identified Codex scopes containing only
rejections have zero recorded completion usage and retain request/error counts.
`request_rejections_only` labels those shared groups; chart tooltips disclose the
rejected count. Accepted/uncertain requests without usage and unpriced completions
remain unavailable. See [ADR-016](decisions/ADR-016-rejected-codex-requests.md).
`quality.missing_usage` counts Codex session/user/model/backend/project scopes without
usage across the range, making affected canonical token folds null and adding to
`unpriced`. Known cost and observed-token subtotals remain visible with coverage status.
Unpriced counts can combine usage-record counts and unmatched usage-scope counts;
they are not a request-coverage percentage. This cannot detect every dropped response.

Folds share rows; full-usage validity and input/output-pair validity are separate SQL
grouping dimensions, preserving usable costs and observed token pairs. Breakdowns
sort by observed tokens. Active rows and compact idle observations each have a
50,000-row guard (overflow returns 400); idle rows do not consume active-row capacity.
Claude counter/baseline rules remain.
`effective_range={from,to,requested_to}` applies Claude's resolved end to both clients
when selected; the UI discloses trimming. Native buckets are one minute through four hours,
otherwise one hour. On this endpoint only, an explicit `intervalHours` between ten minutes
and one hour (exclusive) enables ten-minute native raw counter buckets through one day.
Finer requests over four hours and subhour requests over one day fall back to hourly rollups;
the three-day counter baseline, row limits and query budgets remain. Fine historical queries
keep their requested end instead of flooring it to the hour.
A coarser `intervalHours` is honored, rounded up to a whole multiple of the
native bucket, and reported as `bucket_hours`; finer values fall back to native. Codex buckets in
SQL at the native bucket; both clients' rows are then regrouped, so distinct sessions stay exact,
coverage identity stays at the native bucket (`scope_t`), and bucket-only evidence merges as within
one bucket. Sizes use Claude's resolved end; eligibility for one-day raw resolution uses
the original requested span. Cache keys include display/native bucket sizes and resolved end.
Optional `userExact` and `modelExact` select exact row identities in addition to existing
partial user/model filters. Claude model IDs are normalized; Codex routing prefixes remain.
These validated, bound parameters have separate cache keys and are rejected by Codex insights.
Exact responses echo `applied_filters={userExact,modelExact,backend}`; the UI verifies this
acknowledgment before presenting identity detail, including during a rolling upgrade.
Raw Claude counter inputs also narrow user/model partitions throughout the baseline.
Session channel/backend inference and model-less coverage evidence retain their existing scope.
Bulk delta scope evidence keeps extracted scope dimensions and a fixed delta marker, without
retaining or sorting arbitrary attribute maps; completion deduplication keeps the original
full identity. Token-like attributes on a delta never become completion usage.

Optional `view=cost` selects the bounded cost profile on this endpoint. Any other supplied
value, including an empty value or array, returns 400 before caching. Its cache identity
is separate from the default view. Cost, token coverage, populations, rejected-request
evidence, effective bounds and exact-filter acknowledgments retain the same semantics.
The response echoes `view="cost"`. It omits `by_project`, `tools`, and row fields `api_errors`, `tool_calls`,
`tool_errors`, `request_duration_ms`, `ttft_ms`; omitted diagnostics are not measured zeros.
SQL still retains operational records needed for scope coverage, but skips duration/error
calculations and tool-name grouping. Observed `requests` remains available, including in
the Trends period table and CSV; unsupported counts retain null. Shared cost/executive/trend views, trend baselines and
cost drilldowns use this profile. The default profile retains diagnostic fields.
See [cost query performance](reference/cost-query-performance.md).

Codex detail log summaries use one query for full-identity deduplication, per-response
pricing and scope evidence. The 50,000-row transfer budget applies to aggregate
dimensions, not raw events. Families are counted before transfer; if their combined
size exceeds the budget, oversized families return only a limit marker under an
equal allowance. Whole-window usage totals are independent of Effort rows. `coverage.logs.limited_sections` names capped families
(`event`, `usage`, `effort`, `scope`, `operations`, `latency`, `tool`, `approval`, `runtime`) and
sets `partial=true`. Only affected results are withheld: limited scope evidence keeps
known subtotals partial while withholding strict ratios and session units. See
[Codex bounds](reference/codex-observability.md#api-and-bounds).

Codex insights additionally returns two log-derived objects in both profiles:

- `completion_usage`, with `basis="recorded_completions"` and
  `status="observed"|"empty"|"limited"|"unavailable"`, describes only deduplicated usage-bearing
  completion logs. Fields include `completions`, canonical `tokens`,
  `tokens_partial`, `cache_hit_rate`, `cache_write_share`, `reasoning_share`,
  `tokens_per_completion`, `cost_usd`, `unpriced`, `cost_partial`, and
  `cost_per_completion`. Costs retain `cost_basis="aws_list_estimate"`.
  `identified_sessions`, `identified_completions`, `unidentified_completions`,
  `identified_cost_usd`, `identified_unpriced`, and `identified_cost_partial`
  describe the subset with conversation IDs. `cost_per_identified_session`
  divides that subset's known cost by its distinct sessions. Anonymous costs
  never enter this session unit. Unknown components/prices, zero denominators
  and limited usage remain unavailable or partial; this cohort is not a
  replacement for whole-window completeness.
- `completeness` contains boolean `missing_usage`, `missing_session`,
  `usage_limited`, `scope_limited`, `operations_limited`, and `incomplete_tokens`
  reasons. `request_count` and `session_count` are observed whole-window
  denominators, null when their aggregate family is limited.

Existing `summary` and Effort fields are unchanged. Both objects use the same
log query and filters; they add no queries or identifiers to the response.

`profile=effort` on `/api/codex/insights` selects one log query instead of the default
log, four metric and trace queries. It preserves Effort/usage totals, denominators,
full event identity and missing-usage scope evidence. It skips latency/tool/approval/runtime
breakdowns and quantile work, omits those arrays and `summary.tool_success_rate`, and
reports `coverage.logs.omitted_sections`. Unqueried metric/trace coverage has
`status="not_requested"`, `records=null`, `last_seen=null`; empty signal arrays do not
assert absent collection. The response echoes `profile="effort"`. Invalid profile
values fail before caching; the profile has a distinct cache identity. The default
profile remains full. See [Effort profile](reference/codex-observability.md#effort-profile).

`GET /api/clients/claude-effort` supplies the common cost page's independent
Claude effort card. It accepts the same range, user, model and backend filters;
only `client=claude|all` is valid. Group/project and exact drilldown filters are
unsupported. Authentication, disabled-client checks, validation and cache
isolation use the shared route wrapper.
The response includes `range`, `cost_scope="reported_or_rescaled_counters"` and
`effort` rows with `effort`, `backend`, nullable `cost_usd`, `cost_partial`,
`cost_basis` and `unpriced`. Empty effort becomes `unknown`; backend identities
remain separate. `unpriced` counts aggregated user/session/model scopes, not requests.
`cost_basis` describes the known subtotal's contributing scopes; when all costs
are unknown, it describes their source bases. More than 50,000 scopes returns
400 and asks for a narrower range, without returning a truncated subtotal.
Known counter reports and ADR-017 rescaled estimates retain cumulative/delta
boundaries. Token-derived overview fallback estimates are outside this card's
scope, so its total need not equal the overview total. All-unknown cost is null;
known zero requires observed zero-cost evidence. Filtered responses are cached
independently; this endpoint is not warmed.

Cost pages keep model, effort and input-cache headings visible during loading,
empty results and errors. Model sectors retain version/backend identities and
family colors. Input-cache composition requires complete canonical components;
an observed token subtotal cannot replace a missing cache denominator. The
Codex effort card and detail table share one `profile=effort` response using the
overview's effective bounds.

`modelTime=1` is accepted only by `/api/clients/overview`; any other value returns 400
before caching. It is part of the cache key; the shared default cost profile warms
`view=cost&modelTime=1&timeFormat=compact`. Custom windows, filters, resolutions and
legacy time-row responses may remain cold;
`/api/codex/insights` ignores it. It adds `by_model_time`: one row per `client`, `t`, `model`, `backend` from the
same fold and buckets as `timeseries`, with Codex raw model IDs (routing prefixes
kept; Claude models are normalized as in `by_model`) and the usual cost/token/coverage fields. A row exists only where Claude counter
usage, a Codex usage-bearing completion or a Codex missing-usage scope backs it;
operational-only records (requests, tools, TTFT, stream errors, rejected-only requests)
attach to such a row but never create one, so their buckets appear only in `timeseries`.
Each row's `unpriced_reasons` counts Codex `unknown_backend`, `scope`, `unknown_model`,
`invalid_usage`, or Claude `report_missing`, `report_zero_with_tokens`, plus
`missing_usage` (usage scopes without usage; model-less scopes stay under `model=""`); the
counts sum to `unpriced`. Claude `report_missing` also covers an invalid (negative or
non-numeric) report and a zero report on a counter row whose `cost_observed` is 0;
`report_zero_with_tokens` also covers a zero report beside unknown tokens. Per `client`,
`t`, known `cost_usd` sums to the `timeseries` row; idle Claude observations stay in
`timeseries` only. Codex estimates are never recomputed from aggregated tokens. Each
unpriced Codex response has one `unpriced_reason`, checked in order: backend, scope
(`us-gov.`, a commercial routing prefix on mantle, or no rate for the scope/tier), model rate,
then usage validity; a configured rate with a non-finite estimate reports `unknown_model`.
It also adds `by_user_time`: the same backed usage regrouped per `client`, `t`, `user`
(raw identity, `""` when absent) with the same fields except `model` (`backend` is the rows' single backend or `mixed`), plus
`unpriced_reasons`; per `client`, `t` its known `cost_usd` and `unpriced` sum to the
`by_model_time` rows. Each client keeps its top 20 users with backed usage (known range
`cost_usd`, then `observed_tokens`, then identity) and `""`; the rest fold into one `user: null`
row per `client`, `t` whose `rest_users` is the client's folded user count (null on named
rows), sorted last.

Optional `timeFormat=compact` requires `view=cost&modelTime=1`; other supplied values
or combinations return 400 before cache lookup or database work. It has a separate
cache identity and echoes `time_format="compact-v1"`. Only `by_model_time` and
`by_user_time` change representation to `{columns, dictionaries, rows}`. Each row
is an array in `columns` order. Columns present in `dictionaries` use zero-based
indices into their dictionary; null remains null. Other cells retain their original
values. No fields, identities, buckets or coverage information are removed.
The format changes only the two time tables; totals, rankings and `timeseries`
retain their representation. Filters and cost calculation are unchanged.
User rankings sort descending by observed tokens, then client and raw user identity
for ties, so identical usage does not reorder users during refresh.
The SPA requests this format and reads rows lazily; older array responses remain
supported. Malformed or unknown compact formats are unavailable, never zero.
This reduces response and cache size; it does not reduce the underlying SQL scan
or prove a fleet capacity limit.

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
| Activity density, tool outcomes, permission occupancy | Honor group/user and session-level model filtering; ignore project. Unknown channels are excluded by default. |
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
| `/api/overview/kpi` | Per `group`: `sessions`, `users`, `commits`, `prs`, `total_tokens`, `input_tokens`, `output_tokens`, `lines_of_code`; observation flags `commits_observed`, `prs_observed`, `lines_of_code_observed`. Its row-existence user count is not a substitute for `active-users`. |
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
| `/api/productivity/active-time-summary` | Per `group`: `user_seconds`, `cli_seconds`, `user_seconds_observed`, `cli_seconds_observed`, and distinct `sessions` in the active-time aggregation. |
| `/api/productivity/activity-density` | Per `group`: `observed_scopes`, `matched_scopes`, nullable `matched_commits`, `user_hours`, `commits_per_user_hour`, and fractional `coverage`. Scopes are user/session pairs with either relevant counter observed; ratios use only matched scopes. |
| `/api/productivity/tool-outcomes` | Per `group`: `total`, `succeeded`, `failed`, `unknown`, nullable `success_rate`, `unknown_rate`. Fractions, no top-tool cap; both unprefixed and `claude_code.tool_result` events. |
| `/api/productivity/permission-occupancy` | `{unsupported, limited, rows}`. Per `group`: `interactions`, `matched_interactions`, `ambiguous_interactions`, nullable `interaction_ms`, `blocked_ms`, `blocked_share`, and fractional `coverage`. |
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

The three activity-density/tool-outcomes/permission-occupancy routes also skip cache
warming and use the authenticated Claude route wrapper. Occupancy's `blocked_share`
unions overlapping wait intervals within each matched interaction; it is distinct from
the additive share in interaction breakdown. No matched wait produces null, not zero.
`unsupported=true` means no valid eligible interactions; `limited=true` with empty rows
means the 20,000-span bound or a conflicting span identity prevented calculation.
Neither state swallows database errors. See [measurement and coverage rules](metrics.md#activity-and-flow-coverage).

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
| `/api/reliability/reported-vs-computed` | Bare array per `group, app_version, model`: `requests`, priced-row fields, `ratio = reported_cost / cost` when computed cost is positive (otherwise null), plus `cost_5m`/`cost_1h` (computed cost at each cache-write TTL, independent of the server's `PRICING_CACHE_WRITE_TTL` default) and `ttl_share = (reported_cost - cost_5m) / (cost_1h - cost_5m)` — near 0 means the reported cost prices cache writes at the 5-minute tier, near 1 means the 1-hour tier; null when the denominator is 0 (no cache-write tokens). Claude Code 2.1.300+ also logs `cache_creation_5m_tokens`/`cache_creation_1h_tokens`; the rows add `cache_write_5m_tokens`/`cache_write_1h_tokens` sums, `cache_split_coverage` (split share capped at 1 for positive total writes, otherwise null), `cost_split` (split tokens at their TTL list price, a nonnegative remainder at the server's `PRICING_CACHE_WRITE_TTL` assumption) and `ratio_split = reported_cost / cost_split`. Coverage 1 means a zero assumed remainder, not agreement between the total and split fields; 0 means `cost_split` equals `cost`. Over-total splits remain priced with a zero remainder, including when total writes are zero and coverage is null. Source is `api_request` logs. |
| `/api/integrity/version-cohort-sessions` | Per `group, app_version`: distinct `sessions` with nonempty version and session-counter rows in range. |
| `/api/integrity/version-cohort-cost` | Per `group, version_cohort`: reported `cost_usd`, `tokens`, `usd_per_million_tokens`. Cohorts are `pre-2.1.214` and `>=2.1.214`; raw series are differenced locally. |

API error rate is `api_error / (api_request + api_error)` event counts. The code does not
establish whether failed requests also emit `api_request`, so this is not a deduplicated
request failure probability. Reported/computed ratios diagnose differences in pricing,
TTL assumptions or collection; they do not prove a specific bug or invoice accuracy.

`ttl_share` isolates the cache-write TTL axis specifically, since the four token types stored
by OTel (`input`, `output`, `cacheRead`, `cacheCreation`) carry no TTL dimension. It does not
attribute any remaining reported/computed gap to collection completeness or a client pricing
bug — see [cost accuracy review](cost-accuracy-review-2026-09-10.md).

### Users

| Path | Fields and grain |
|---|---|
| `/api/users/leaderboard` | Per `user, group`: `sessions`, `tokens`, `input_tokens`, `output_tokens`, `loc`, `commits`, `prs`, `accepted`, `decisions`, `active_days`, `user_active_days`, `accept_rate`, `productivity_score` (both null without a positive decision denominator). |
| `/api/users/tools` | Per `user, group, tool`: `uses` from tool-result logs. |
| `/api/users/skills` | Per `user, group, skill`: `invocations`, counting raw cost datapoints rather than activation events. |
| `/api/users/cost-efficiency` | Per `user, group`: computed `cost`, `unpriced`, `reported_cost`, `reported_unpriced`, additive `known_reported_cost` and `reported_partial`, `loc`, `commits`, `cost_per_loc`, `cost_per_commit`. Ratios require usable reports from every included model; partial costs do not establish valid ratios. |
| `/api/users/daily` | Exact-email daily `t, sessions, loc, tokens, commits`; fixed daily buckets. |
| `/api/users/decisions-by-tool` | Exact-email `group, tool, decision, n`. |
| `/api/users/heatmap` | Exact-email `d, sessions`, fixed 91-day lookback ending at `to`. |
| `/api/users/interactions` | **Trace result**, `minVersion: "2.1.214"`; `session_id`, `trace_id`, UTC `started_at`, `interaction_ms`, `llm_ms`, `tool_exec_ms`, `blocked_ms`, `agents`, `llm_calls`; newest **200** interactions. |

`user_active_days` is the distinct-day union within the query's filtered population, shared
across a user's channel rows; summing per-channel active days can double-count dates.
`agents` is a distinct-agent count, not agent depth. Child duration totals can exceed the
interaction duration. All four drilldowns are excluded from cache warming.

KPI rows also expose `commits_observed`, `prs_observed`, and `lines_of_code_observed`.
Active-time rows expose separate user/CLI observation flags. These require in-window
samples with matching metric/type identities; lookback-only counters do not establish zero.
Above four hours, the first hour uses raw evidence and later hours use rollup presence.
Live ends retain the trailing partial hour, whose samples can extend beyond the requested
end; historical ends use the usual alignment. These flags inherit that approximation.
The flags establish observation, not complete collection. Detail Productivity and Executive
withhold aggregate outcome/time values if any returned channel lacks the relevant evidence.
See [activity availability](decisions/ADR-018-activity-observation-availability.md).

### Cost

Primary spend consumers select reported costs through frontend
[spend.js](../dashboard/web/src/spend.js). Original `cost` or summary `computed_cost` remains
a token-price diagnostic. The API does not add display-status fields globally. Missing
reports and zero reports with positive tokens are unpriced at spend consumers; positive
aggregates are not proof of complete capture. See [metrics](metrics.md).

| Path | Fields and grain |
|---|---|
| `/api/cost/summary` | Per `group`: `computed_cost`, strict `reported_cost`, additive `known_reported_cost` and `reported_partial`, token fields, `unpriced_tokens`, `sessions`; includes unknown-channel rows by default. |
| `/api/cost/by-model` | Per `group, model`: priced row plus `tokens`, `known_reported_cost`, `reported_partial`, `cost_counter_rows`, and `observed_usage_rows`; empty model stays `model=""`. |
| `/api/cost/by-user-model` | Per `user, group, model`: priced row plus `tokens`; nonempty email required; empty model stays `model=""`. `includeUnknown=1` broadens channel coverage. |
| `/api/cost/by-model-daily` | **B**, per `day, group, model`: priced row plus the report coverage fields below. The field is named `day` even for sub-day buckets. |
| `/api/cost/by-user-daily` | **B**, per `day, group, user`: the same per-(model, session) report scopes, each attributed to one user (`max(UserEmail)`, so a non-empty address wins; `""` means no identity), regrouped by user. The top 20 users by known report over the whole requested range are separate, and `""` always is; the other users fold into one `user: null` row per `day, group`, whose `rest_users` is the range-wide count of folded users (constant across rows). Report coverage fields and tokens, no computed `cost`/`unpriced` (a user row mixes models). |
| `/api/cost/by-model-compare` | Per `model` across selected channels: current priced-row fields, `prev_reported_cost`, previous token fields prefixed `prev_`, and computed `prev_cost`; previous period derived server-side. |
| `/api/cost/tiers` | **Object** `{bedrock, enterprise}`, each with computed `uncachedInput`, `cacheRead`, `cacheWrite`, `output`; unknown rates are skipped. |
| `/api/cost/effort-mix` | Per `group, effort`: computed `cost`, strict `reported_cost`, additive `known_reported_cost` and `reported_partial`, `tokens`, `unpriced_tokens`; empty effort becomes `unknown`. |
| `/api/cost/by-agent` | Per `group, agent`: the same cost/coverage fields as Effort; empty agent becomes `main`. Returns the top **30 by computed cost** after aggregation. |

Summary, model, Effort, agent, and efficiency `known_reported_cost` retain usable model totals
inside each channel and endpoint dimension, with
`reported_partial` when other model totals are unavailable. All-unpriced evidence
remains null. Summary/model/Effort/agent zero requires an in-window cost counter
and no positive tokens in that model scope; session-count-only and lookback-only
rows cannot establish that zero. Efficiency retains the existing per-user/model
report eligibility, including its zero policy without observation metadata.
Effort/agent model scopes without an in-window cost or token sample are omitted;
pre-window samples still establish counter baselines.
Current token samples with zero increments and no cost sample remain unavailable
coverage; they mark a mixed Effort/agent subtotal partial rather than establish zero.
The model endpoint retains its legacy rows and strict values. Its observation fields
count folded series with current cost samples or any current cost/token samples,
respectively, not raw exports. They use the existing raw/rollup window boundaries.
Cost omits explicitly historical-only model rows before computing current model shares.
The Claude detail Cost page uses these subtotals, discloses partial chart totals,
lists unavailable chart scopes, and exports cost status for its tables.
Summary-derived averages retain partial labels; the API's efficiency $/LOC and $/commit
remain null when any included model lacks a usable report, while Cost divides the known
subtotal and labels the result partial (ADR-013). Executive and other strict
consumers retain their existing report selection. These fields do not
recover an unavailable model's sessions or establish complete collection.

`/api/cost/by-model-daily` judges report availability per session inside ClickHouse
(`costByModelDailySql` in [queries.js](../dashboard/server/queries.js)) and returns one row per
`day, group, model` (including empty models); [modelCostTrend.js](../dashboard/server/modelCostTrend.js) maps the counts.
A session report is usable when it is positive, or zero with known zero tokens or no token
samples. `reported_cost` is the sum of usable reports and null when no session is usable;
`reported_partial`, `reported_unavailable` (unusable sessions), `reported_reasons` and
`reported_all_unavailable` disclose the exclusions. `report_missing` counts sessions with no
report sample or an invalid (negative or non-finite) report; `report_zero_with_tokens` counts
zero reports beside positive or unknown tokens; together they equal `reported_unavailable`.
A session with no in-window cost or token sample, such as a baseline-only first bucket, is
omitted as no data rather than reported as a known $0. Minute buckets are clock-aligned and
only buckets starting at or after `from` are returned, so an unaligned `from` drops the
partial first minute and any increment reported in it (a pre-existing detail boundary; the
coding-client views split that minute instead). A report-only session adds 0 to the
canonical token sums; `observed_tokens` excludes it and `tokens_partial` is the coverage
signal (all report-only yields null). `observed_tokens` and `tokens_partial` follow
[ADR-014](decisions/ADR-014-observed-token-subtotals.md); computed `cost` prices the summed
tokens of each model, which equals the sum of per-session estimates, and is null for unpriced
models. More than 50,000 `day, group, model` rows return 400.

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
Concurrent chat overload returns 503 before SSE without consuming an IP rate slot.
See [chat limits](reference/agent-llm.md) and [runtime admission](reference/api.md#request-and-cache-behavior).

### Health and config

| Path | Response |
|---|---|
| `/healthz` | HTTP 200 `{ok:boolean}` from ClickHouse ping, even when false. |
| `/readyz` | `{ready:boolean}`, HTTP 200 when ready, 503 when draining or ping fails. |
| `/api/health/data` | `{status, latest, ageMinutes, staleAfterMinutes}`; status is `ok`, `stale` or `unknown`. HTTP 200 only for `ok`, 503 otherwise. |
| `/api/config` | `{piiMask, pricing, schema, groupMode, defaultRangeDays, rangeCapDays}`; reads in-memory configuration/probe snapshots, with no query in this handler. |

Freshness uses the maximum enabled-source timestamp (Claude raw metrics, Codex logs)
over seven days, memoized for 30 seconds; one fresh source can mask another's outage.
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
| 401 | Missing/invalid Basic credentials or an OIDC session that cannot be renewed. |
| 403 | OIDC permission/group or unsafe-request Origin denied. |
| 429 | Chat's per-process IP limit. |
| 500 | Wrapped query failure: `{error:"internal error", id:"<uuid>"}`. The full exception is logged under the ID, not returned. |
| 503 | Not-ready/freshness states, unmet chat gates, or exhausted runtime admission. Overload JSON has `code:"capacity_exhausted"` and `Retry-After: 1`; other wrapped query failures remain 500. |
| 504 | The shared data-query load exceeded its cooperative 25-second budget: `{error, code:"query_timeout", id:"<uuid>"}` and `Retry-After: 5`. A warning logs the ID, registered route and code without filters or SQL. The localized message suggests a smaller range or retry. Timeout results are not cached as empty or zero data. |

After authentication, JSON API middleware sets `no-store`; the server's bounded promise cache is separate.
[CloudFront configuration](../infra/dns_cdn.tf) declares zero error-cache TTL for dashboard
403/500/502/503/504 without rewriting status or body. CloudFront can cache these errors
under other cache policies or positive origin cache directives; verify the actual policy,
error TTL and response headers. AWS [error processing](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html)
documents that managed `CachingDisabled` disables cached 5xx errors; 400/403 caching
requires positive `max-age` or `s-maxage`.
The explicit zero-TTL entries protect this deployment contract if its policy changes.
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
