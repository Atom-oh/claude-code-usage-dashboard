# Metrics Glossary

This glossary defines the measures shown across Overview, Executive, Cost, Productivity,
Users, Trends, Reliability, Usage and Analytics. Names below describe the UI in English;
code identifiers locate labels and calculations without reproducing translated strings.
Field-level responses and filters are in the [API contract](api-reference.md).

## Shared interpretation

- Metric `Value` can be cumulative. [queries.js](../dashboard/server/queries.js) computes
  per-series increases with `incFlat` or bucketed differences; raw `sum(Value)` over repeated
  cumulative exports is wrong. The source schema is segment-aware except for `session.count`.
  Four-hour raw selection, lookback limits and historical/latest-hour approximations are
  documented in [data](reference/data.md). Different panels need not agree for every window.
- `bedrock` and `enterprise` are inferred access channels for Claude Code sessions, not
  coding clients. A user can appear in both. Native Codex telemetry is not supported by the
  current queries, and an OpenAI model name is not proof of Codex use.
- Total-oriented endpoints include `unknown` channels; many A/B endpoints exclude them.
  Headcounts can overlap across channels, and model filtering does not apply to active-user
  or adoption counts. Project filtering affects only four Usage queries. Always check
  [filter scope](api-reference.md) before comparing numerators and denominators.
- Most user measures depend on nonempty `UserEmail`; the EndUserId fallback is limited.
  Missing telemetry, identity or beta coverage is not zero activity. No source declaration
  or positive aggregate proves that a live fleet collected every event.
- CSV exports use the current table columns and sorted rows. `toText` supplies a textual
  representation when needed, and central `csv.js` masks the `user` column when enabled.
  See [UI contracts](reference/ui.md).

## Spend and cost diagnostics

Primary spend displays use client-reported `claude_code.cost.usage`, exposed as
`reported_cost`. [spend.js](../dashboard/web/src/spend.js) maps that field to display `cost`
and preserves original server `cost`/`computed_cost` as diagnostic `computed_cost`.
Previous-period fields follow the same rule. SQL and server rate calculations retain their
own meaning; the adapter is not a change to stored telemetry or all API fields.

Missing, blank, negative or nonfinite reports are unusable. A zero report with positive
tokens is treated as unpriced by spend consumers; zero without token evidence is valid and
`usd(0)` displays `$0`. `sumSpend` propagates unusable supplied rows as null, suppressing a
misleading partial total or average. Missing reports already folded into a positive SQL
aggregate cannot always be detected, so total and detail status can differ.

Reported spend is an estimate affected by client pricing/version, collection gaps and
contract terms. It is not an invoice, guaranteed lower bound, or proof of complete capture.
Computed diagnostics are also estimates and can overstate or understate billing.

[pricing.js](../dashboard/server/pricing.js) computes model-specific token cost:

```text
(input_tokens * input_rate
 + output_tokens * output_rate
 + cache_read_tokens * cache_read_rate
 + cache_write_tokens * effective_cache_write_rate) / 1,000,000
```

Rates are per million tokens. `cacheCreation` maps to the API's `cache_write_tokens` and
the price table's cache-write rate. `PRICING_CACHE_WRITE_TTL` selects the `1h` default or
`5m` assumption; telemetry here does not distinguish those writes. `PRICING_JSON` can
replace rates using normalized model keys. Use the code table rather than a copied list
of supposedly current vendor prices.

A model absent from the server rate table has computed `cost=null` and `unpriced=true`.
Computed aggregate totals skip those rates and retain `unpriced_tokens`. A valid reported
cost remains usable for spend and reported-cost efficiency, regardless of server pricing
coverage. No cost estimate should silently invent a rate.

| Measure | Calculation and consumer |
|---|---|
| Period/total spend | `costSummary.reported_cost`, adapted and summed by Cost/Executive; token breakdown and sessions remain separate fields. |
| Cost per developer | Reported period spend / `activeUsers.users`. A model filter narrows spend but not that headcount; Cost's `spendPerDeveloperHint` discloses this mismatch. |
| Cost per channel user | Reported channel spend / its distinct channel users; users spanning channels enter both denominators. |
| Daily average / 30-day projection | Spend / selected fractional days, then multiply by 30; Cost and Executive clamp the duration to at least one minute. This is linear extrapolation, not forecasting. |
| Cost per 1,000 added lines | Executive `costPerKloc`: spend / (`lines_of_code` / 1,000), null if the denominator is zero. |
| Cost per LOC / commit | `userCostEfficiency` in [costEfficiency.js](../dashboard/server/costEfficiency.js): reported cost / added LOC or commits, per user/channel. Missing report coverage or zero denominators yield null. Computed `cost`/`unpriced` are retained separately. |
| Model/effort/agent spend | Reported cost at the returned grain. Effort's empty value becomes `unknown`, displayed by `effortLabel` as unspecified; empty agent becomes `main`. Agent results are capped by computed cost before frontend spend sorting. |
| Previous-period comparison | `costByModelCompare` returns reported and computed current/previous values; longer windows have separate alignment logic. Compare selected populations and effective windows, not only labels. |
| Token-tier dollars | `tierCostsByGroup`: computed input/cache-read/cache-write/output costs, not an exact allocation of reported spend. |
| Reported/computed ratio | `reportedVsComputedByVersion`, using `api_request` logs at channel/version/model grain; null if computed cost is not positive. A deviation does not isolate its cause. |

Cost's `showComputed` defaults false. The optional comparison section, computed table columns
and effort annotations disclose computed diagnostics and the TTL assumption. The donut
`valueFormatter` replaces default/prefix formatting and preserves cents without changing
underlying values. Legacy Usage `est_cost_usd`/`cost_usd` tables and Reliability diagnostics
do not all pass through `spend.js`; their source and display handling must be read separately.

## Overview, Executive and Trends

| Measure | Source and calculation | Limits |
|---|---|---|
| Active users/developers | `activeUsers`: distinct nonempty emails with `claude_code.session.count` rows in range; also returns per-channel counts. | Row presence, not proof of new sessions or productive work. Short windows use raw rows; longer ones use hourly existence. |
| Sessions | `kpiSummary` or `costSummary`: increases of `claude_code.session.count`. | Other panels use distinct session IDs instead. Current queries do not universally filter `StartType='agents_view'`. |
| Added lines, commits, PRs | `kpiSummary`: `lines_of_code.count` with `TokenType='added'`, `commit.count`, `pull_request.count`. | Telemetry activity, not accepted changes, merged PRs or independently verified outcomes. |
| Total/input/output tokens | `kpiSummary`, `tokenTimeseries`, `modelDistribution`: `token.usage`, split by type where applicable. | Total includes cache-read and cache-creation tokens as well as input/output. |
| Cache reuse ratio | `cacheEfficiency`: `cacheRead / (input + cacheRead + cacheCreation)`. | Cache creation is a cache miss/write and belongs in the denominator; omitting it inflates reuse. Output tokens are separate. |
| Total members | `adoptionLevels`: distinct emails with retained session-counter history before `to`. | Observed history, not the organization's enrolled roster or unlimited all-time membership. Ignores `from`. |
| DAU/WAU/MAU snapshot | `adoptionLevels`: distinct emails in the trailing 1/7/30 days ending at `to`. | Hourly source, ignores model/project; do not equate the one-day snapshot to a calendar-day series point. |
| DAU/WAU/MAU series | `adoptionTimeseries` plus [rollupAdoption](../dashboard/server/activity.js): daily distinct-user unions over trailing 1/7/30 UTC days including that day. | Series labels begin at the first UTC midnight at or after `from`; no point is emitted at/after `to`. |
| Stickiness | `rollupAdoption`: `100 * dau/mau`, or 0 for zero MAU. | API series values are percentages; individual UI ratios may use fractions internally. |
| Average/peak DAU | Executive averages/takes the maximum of returned daily DAU points; Trends uses the latest point for headline values. | Follows the returned day population, including missing-activity days represented by zero. |
| Monthly adoption | MAU / observed `total_members` in the page calculation. | Not adoption against an external employee roster. |
| Sessions per developer-day | Executive `sessionsPerDevDay`: sessions / active developers / fractional days. | Uses the active-user population; not sessions per employee. |

The Executive scoreboard's `abUserSec` displays channel `user_seconds / 3600`; it is not
per-developer time. Its `abAutoRatio` divides `cli_seconds` by `user_seconds` when positive.
Group-mode presentation does not change any backend population policy.

## Productivity and Users

`claude_code.code_edit_tool.decision` counts permission decisions, including automatically
allowed decisions. The UI's suggestion-acceptance wording does not make these human reviews
of generated code or measurements of accepted code quality.

| Measure | Calculation | Interpretation |
|---|---|---|
| Decision accept rate | `codeEditDecisions` totals `decision='accept'` / all decision counts; leaderboard uses `accepted/decisions`. | A permission-decision mix. Automatic/configured approvals can raise it without human evaluation. |
| Estimated accepted lines | Productivity computes `round(added_lines * acceptRate)`. | Arithmetic proxy only: neither source measures line-level acceptance. |
| Normalized activity | `normalizedProductivity`: added LOC or commits / tokens * 1,000,000. | Zero token denominators produce null SQL ratios. Volume efficiency is not code quality. |
| User/CLI active time | `activeTimeSummary` separates `active_time.total` by `TokenType='user'` and `'cli'`; the older `activeTimeSeries` sums types into `active_seconds`. | CLI time is not automatically unattended work, and user time is not measured labor savings. |
| Automation ratio | CLI seconds / user seconds, when the user denominator is positive. | Runtime ratio only; it does not establish autonomous success or time saved. |
| Lines per active hour | Productivity added lines / (`user_seconds/3600`). | Output-volume proxy; missing user-time telemetry prevents a meaningful ratio. |
| Tool calls per prompt | `agenticness`: tool-result count / user-prompt count by bucket/channel. | Measures tool activity per observed prompt, not successful task completion. |
| Engagement | `dailyEngagement`: users, session/PR increases and PRs per user per requested bucket. | No channel column in the response after filtering; not always daily despite the function name. |
| Language activity | `languageBreakdown`: code-edit decision totals and accepted decisions per language. | Permission counts; empty language merges into `unknown`. |

The existing **productivity score is an arbitrary activity heuristic**, not a validated
performance measure. [productivity.js](../dashboard/server/productivity.js) uses
`d = max(1, selected_days)` and the following weights/caps:

```text
100 * (
  0.30 * min(added_LOC / d / 300, 1)
+ 0.25 * decision_accept_rate
+ 0.20 * min(commits / d / 3, 1)
+ 0.15 * min(active_days / d, 1)
+ 0.10 * min(sessions / d / 4, 1)
)
```

The server rounds the score to one decimal and acceptance to three. The Users leaderboard
is per user/channel; a user can have multiple rows. Executive and aggregate Productivity
views use [foldLeaderboardByUser](../dashboard/web/src/score.js), sum activity across returned
channel rows, use `user_active_days` for the distinct-day union, then recompute the formula.
Executive averages those user scores. A top-ten list ranks this heuristic, not developers'
quality or business impact. Users' channel acceptance summary is weighted by decision counts.

Users' `familyStats` divides each model family's reported spend by distinct users in that
family's returned rows, with `includeUnknown=1`. It includes valid reported spend for models
missing server rates. An unusable report makes the family total/average null; a user active
in several families appears in each denominator.

User drilldowns have separate scope and caps: daily metrics and heatmaps are fixed daily
views; interactions show at most 200 newest spans and ignore the channel filter.
`agents` is a count of distinct IDs, not a depth or parent-child tree.

## Reliability and beta timing

[queries.js](../dashboard/server/queries.js) defines the Reliability tables:

| Measure | Definition and limit |
|---|---|
| API latency | `apiLatency`: p50/p95 `api_request.duration_ms` by channel/model and channel/effort. These are request durations, not TTFT. |
| API error rate | `apiErrors`: errors / (request events + error events), retaining `no-http-status` errors. Event overlap is not resolved, so this is not a deduplicated failure probability. |
| Refusals | `refusalRate`: separate user-visible and server-fallback refusal counts, not a percentage. |
| Exhausted retries | `retriesExhausted`: event count, mean attempts and retry duration. Quota/throttling is one possible cause, not established by the count alone. |
| Version cohorts | `versionCohortSessions` shows distinct sessions by version; `versionCohortCost` splits reported cost/tokens at version 2.1.214. Cohort imbalance is a reason to investigate, not proof of a client defect. |
| Permission wait | `permissionWaitOverhead`: p50/p95 duration of `tool.blocked_on_user`, per channel/version. |
| TTFT | `ttftComparison`: p50/p95 `TtftMs` from `llm_request`, per channel/model. |
| Interaction breakdown | `interactionBreakdown`: interaction duration quantiles and child LLM/execution/blocked time divided by interaction time. Overlapping spans can make shares exceed 100%. |

Trace handlers return an explicit `unsupported` result when no matching spans are found.
The unsupported minimum-version hint is 2.1.214 for permission/interaction panels and null
for TTFT; it is not a live capability test. Verify beta rollout, versions, range and filters
before interpreting missing spans. Parent/child depth cannot be inferred from the reported
`agents` count alone. See [API trace shapes](api-reference.md).

## Usage

| Measure | Source and calculation | Limit |
|---|---|---|
| Tool/MCP use | `toolMcpUsage`, `mcpConnectorUsage`, `userToolUsage` count `tool_result`. | Success flags can be absent; tool rows are capped. MCP names come from parsed tool parameters. |
| Tool latency/errors | `toolLatency` counts results, treats false success or a nonempty error attribute as an error, and computes duration p50/p95. | Different error rule from `toolMcpUsage`; 50 returned rows total. |
| Permission funnel | `toolDecisionFunnel`: `tool_decision.source` and accept/reject counts for the fleet's top 20 tool names. | Denominator is accept+reject; other decisions can make `n` larger. |
| Skill cost/use proxy | `skillUsage`: count of cost-series rows after `incFlat`, with reported `est_cost_usd`. | Not an activation count or server-priced estimate; does not exclude a model merely for missing server rates. Lookback/series grain affects counts. |
| Per-user skill proxy | `userSkillUsage`: raw `cost.usage` datapoint count with `SkillName`. | Repeated exports can inflate invocation-like counts; not the same grain as `skillUsage`. |
| Skill activations | `skillActivations`: `skill_activated` event counts by skill and `invocation_trigger`. | Use this event population for activation analysis; name redaction/coverage may limit interpretation. |
| Subagent fanout | `subagentFanout`: completions / distinct nonempty prompt IDs among `subagent_completed` events. | Denominator is prompts with completion events, not every prompt. No beta traces required by this query. |
| Compaction | `compactionPressure`: count, count/session and mean `1-post_tokens/pre_tokens` for positive pre-token counts. | Sessions are those with matching compactions, not all sessions. |
| Plugin inventory | `pluginInventory`: plugin/marketplace load events and distinct sessions. | Fleet-wide, range-only; ignores global filters. |
| Commands/prompt length | `commandAdoption`: nonempty slash-command counts/users; p50/p95 length across all user prompts. | Separate populations within the returned object; prompt text is not required. |
| Hook overhead | `hookOverhead`: execution count, summed duration in seconds, p95 milliseconds and count with blocking hooks. | `blocked/executions` is a rate; `blocked` is not total blocking-hook count. |
| MCP health | `mcpHealth`: connection-event attempts, connected/failed counts and p95 duration. | Other statuses, including disconnects, remain in attempts. |
| Projects | `projectBreakdown`: reported cost/token increases and in-range session/user existence per project/channel. | Requires project gate; EndUserId fallback is limited to this identity expression. |
| Permission modes | `permissionModeChanges`: transition event count and distinct sessions by from/to mode. | Values pass through; absence is not proof a mode was unused. |
| Decision sources | `toolDecisionSources`: executed tool results with nonempty decision source, divided by that channel's matching total. | Different from the permission-funnel event and denominator. |
| Entrypoints | `entrypointBreakdown`: API request count, sessions, reported log cost and users by entrypoint. | Empty entrypoint is labeled `terminal`; this fallback does not identify a separate coding client. |

The Usage `costPerUse` cell divides `est_cost_usd` by its proxy `invocations` (or one if zero).
Despite a session-oriented display label, it is not necessarily cost per distinct session.
Project tags and permission/entrypoint fields have the limited filter scope described in the API.

## Analytics

Analytics uses [chat.js](../dashboard/server/chat.js) to query the same telemetry through a
bounded SQL tool loop. It creates no separate KPI source. The hardcoded prompt still has
outdated cost-display and rollup wording; consult the [chat reference](reference/agent-llm.md)
when reconciling assistant answers with the dashboard. No live model or data access is
implied by these definitions.
