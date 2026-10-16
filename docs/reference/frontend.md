# Frontend Implementation

OIDC installations show the current user's role/logout on desktop and mobile.
Viewers have no SQL-chat control; the server enforces permission independently.
Expiry or a data API 401 unmounts telemetry and offers organization login.
Basic/legacy configuration retains its behavior. See
[identity contracts](../decisions/ADR-019-dedicated-installation-identity.md).

The permission-aware `/installation` route is preserved independently of client navigation.
It hides usage filters/chat and shows configuration, per-client receipt and schema checks.
Non-admin views make no diagnostic request. Refresh failure retains results only with a
visible previous-result warning; receipt/empty/unavailable never become usage zeros.

The React 18/Vite 8/Tailwind 4 SPA (Node >=22.12) shares the Express image.
See [web/AGENTS.md](../../dashboard/web/AGENTS.md) for developer instructions and
[UI](ui.md) for component and export contracts.

## Routes and state

Charts use supported Recharts 3 public data-snap scales for pointer-driven zoom rather
than stale tooltip state. Mouse drags preserve UTC bucket/range clamps and the existing
disabled-while-stale contract. Other frequent events retain throttling. Axis text uses
the higher-contrast ink token; gridlines retain their separate lighter token.
The legacy Tailwind theme is explicitly loaded through `@config` under Tailwind 4.

[App.jsx](../../dashboard/web/src/App.jsx) shares these nine routes across all clients:

| Path | Page |
|---|---|
| `/` | Overview |
| `/exec` | Executive |
| `/trends` | Trends |
| `/productivity` | Productivity |
| `/usage` | Usage |
| `/users` | Users |
| `/cost` | Cost |
| `/reliability` | Reliability |
| `/analytics` | Analytics |

All, Claude and Codex default to shared metrics from `/api/clients/overview`, with
the same navigation, headers, filters, cards and table columns. Client switching
preserves valid routes and date/model/unmasked-user state; unknown paths normalize to `/`.
`ClientContext` owns selection and Claude `view=detail`, which opens existing advanced/A/B
pages. Floating chat and the Analytics question input appear in every view for `chat:query`
users; shared `/analytics` places that chat above the model diagnostics.
Claude group/project links without `view` retain detail compatibility.
Shared views use backend filters; detail uses group/project and drops backend. Leaving
Claude detail clears `view` and its filters. Both URL-state providers preserve `view`.
No Codex enterprise comparison or unsupported productivity metrics are added.

Claude detail's Productivity page adds independent activity-density, permission-occupancy
and tool-outcome tables with coverage and unavailable states. The legacy score is labelled
an activity index across Productivity, Users, Executive and the user drawer; its API field
stays unchanged, while an unavailable permission denominator withholds the score.
Means require scores for every returned user, and rankings omit unavailable scores. Permission approvals no longer imply accepted code, and the
estimated accepted-lines card is removed. Shared Productivity explains the external data
needed for task outcome measures. See [definitions and coverage](../metrics.md#activity-and-flow-coverage).

The shell includes desktop/mobile navigation, the filter bar, freshness banner and floating
chat. [main.jsx](../../dashboard/web/src/main.jsx) renders
[ConfigBootstrap.jsx](../../dashboard/web/src/ConfigBootstrap.jsx) before mounting the router
or App. The gate fetches `/api/config` with a three-second deadline covering both the request
and JSON body. Loading, timeout, HTTP/network failure, invalid JSON and malformed config
remain unknown: Korean loading/error UI preserves the URL and prevents route data requests.
Retry starts a new request without reloading; cleanup aborts obsolete requests, and their
late results cannot change config or masking. StrictMode setup does not send duplicate
config requests.

Successful config must be a non-null, non-array object. Legacy objects without
`enabledClients` are accepted; when present, it must be a nonempty, duplicate-free array containing only `claude` or `codex`.
The gate passes the object unchanged and does not select a client or add routes.
Masking stays on until a validated config explicitly sets `piiMask` to false, before any
app content renders.
[ConfigContext.jsx](../../dashboard/web/src/ConfigContext.jsx) supplies group mode, default
range, cap, pricing assumptions and schema status. `GROUP_MODE=single` changes presentation;
it does not change SQL filtering.

[RangeContext.jsx](../../dashboard/web/src/RangeContext.jsx) supports presets, current UTC
month, and custom ranges from the calendar or drag zoom. Presets use hourly buckets for
at most two days, daily otherwise; calendar ranges use the same rule. Drag zoom chooses
from a resolution ladder targeting at most 96 buckets, with minute buckets limited to
four-hour windows. Month mode uses daily buckets.

[FilterContext.jsx](../../dashboard/web/src/FilterContext.jsx) debounces user, model and
project inputs by 300 ms. [urlState.js](../../dashboard/web/src/urlState.js) serializes one
range shape: `days`, `period=month`, or `from`/`to`. Masked-mode URLs omit user identity;
project URL state requires `schema.projectColumns === true`.

## Fetch and refresh behavior

[useApi.js](../../dashboard/web/src/useApi.js) forwards range, interval and filters, followed
by endpoint-specific overrides. Project forwarding has a second schema gate. Forwarding
does not imply that every endpoint honors every filter; consult the
[API filter scope](../api-reference.md).

Requests quantize the current time to 120-second boundaries after a 150-second grace
period for server warming. Custom ends later than that boundary are clipped, and a
nonpositive resulting window is extended by 120 seconds. Consequently the displayed
range and actual API window can differ near now. Storage, query bounds and bucket
identities remain UTC. Shared chart axes/tooltips, range captions and Codex trace
timestamps display the browser time zone. Time columns export matching local values
with an offset/zone marker. Parse timezone-less ClickHouse timestamps as UTC before
formatting; display conversion must not shift request or drag-zoom bounds.

Shared client trends use a continuous time axis over the API's effective range.
Missing buckets break lines, while isolated known values (including zero) remain
visible as points. Every shared chart series (area, bar, line, pie) disables its draw
animation, so refreshes and period changes update charts in place.
Primary token counts/charts use `observed_tokens` with `tokens_partial` disclosure.
Canonical token totals and incomplete ratios stay unavailable; observed counts never
silently replace analytical denominators. CSV retains numeric counts and coverage
status. Fallback to canonical tokens is only for an absent observed field, not explicit
null. See [ADR-014](../decisions/ADR-014-observed-token-subtotals.md).

The hook separates the selected view from its quantized request window. Polling advances
the window without replacing loaded charts or tables with a loading state. Unchanged
payloads keep their references; shared panels also keep stable client props and memoize
rendering. A background failure retains visible data and reports the refresh error.

A selection is an identity (path, filters, `linkedRange` and extra parameters other than
`from`, `to` and `intervalHours`) plus a period (days, current month and its month start,
interval, custom range, explicit extra `from`/`to`, and a page-local extra
`intervalHours` such as Cost's granularity, which it resyncs from the global range).
An identity change clears the previous selection to a loading state. A period-only
change with data on screen keeps that data, marks the request as refreshing, and
replaces the data when the new response arrives. If that load fails, including after
a window move replaced its request, the data clears to the error without a
refresh-failure report. Returning to the period the displayed data was fetched for
(for example 2 → 7 → 2 days before the 7-day response) is a refresh: no pending
period state remains, and a failure keeps the data and reports a refresh failure.
Until the response arrives, page values derived from the new range's duration are
computed over the retained data. Aborted or superseded requests cannot update either
data or error state.

`useApi` also returns `stale`, true while retained data from another period of the
same view waits for the new period's response. It is false after that response or a
failed period load, on identity changes, background refreshes, while disabled, and
after returning to the displayed period. It is computed during render, so it is
already true in the render that changes the period.

Codex details opt into `linkedRange` because their explicit `from`/`to` follow the
parent response's effective bounds; moving them is a refresh of the same view, not a
period change. Do not use `linkedRange` for independent user-selected bounds, which
are period changes. Request quantization and cache keys are unchanged. Codex details
also pass `hold: stale` of the overview hook. While held, the hook sends no request
and keeps its selection and state; an in-flight request still completes. After
release, a period change made during the hold is a period change requested with the
new bounds, so its failure clears. A parent `stale` set from an effect would be one
commit late: child effects run before parent effects, so the child would already have
requested the parent's old bounds.

[RefreshContext.jsx](../../dashboard/web/src/RefreshContext.jsx) defaults to 60 seconds,
persists the selected interval, pauses hidden tabs, refreshes when visible, and skips one
scheduled tick after a reported failure. Its UTC `dayKey` updates range-derived dates.
Retained-data requests report idempotent start/end status, including aborts. Status-only
updates use a separate context from data-cycle triggers. The refresh control reserves
a status row at every viewport for pending/failure disclosures; its timestamp labels
an attempt, never successful completion.
Page-local interval controls must resync from global range changes, as
[Cost.jsx](../../dashboard/web/src/pages/Cost.jsx) does. Executive and the shared model trend
instead key a manual pick to the range it was made in, so a range change restores the default
in the same render. Tables fed by a stale hook
pass `stale` to `DataTable`, which disables CSV export so previous-period rows are not
saved under the new range's filename. Every time-series `GroupAreaChart`,
`DualLineChart`, `SeriesBarChart` and `ModelCostTrend` passes `zoomDisabled` from the hook that feeds it, so
drag zoom is suspended while its rows are stale (a pending global period change, or Cost's
granularity change). The retained rows keep the previous bucket size, while the drag pads
its right edge with the new one: the global interval, or Cost's page-local `bucketHours`.
The label fallback is not a substitute: date-only labels get 24 hours, including weekly
buckets, and other labels use the global interval. Charts whose bucket size cannot change
(daily adoption series, shared client trends that take `bucket_hours` from their own
response) are suspended too, so no drag selects a range from the previous period's rows.
Categorical axes do not zoom, and `UserDrawer` clears to loading on range changes.
[zoomGuard.test.js](../../dashboard/web/src/zoomGuard.test.js) checks every call site.

## Model cost trend

`ModelCostTrend` ([component](../../dashboard/web/src/components/ModelCostTrend.jsx)) draws
partial-preserving stacked areas over the pure helpers in
[modelCostTrend.js](../../dashboard/web/src/modelCostTrend.js): `fromByModelDaily` adapts the
detail `/api/cost/by-model-daily` rows and `fromByModelTime` the shared `by_model_time` rows.
The frame keeps the top six series by known cost plus an Others segment with fixed membership.
Model colors are stable per name and theme: registered models use the trend palette,
other known Claude models/families keep `modelColorFor`, and remaining models use solid
vendor palettes. OpenAI and other-vendor fallbacks have six tones; Others has an exclusive
neutral. Series are monotone stacked areas; unavailable and no-data buckets are gaps (null,
never a drawn $0), as is a series whose cost is unavailable inside a partial bucket; a
series with no usage stacks as 0, and a positive point between gaps is drawn as a dot, and an invisible
zero-height bar carries the bucket state marks. Legends use matching solid swatches. Bucket states are known, zero, partial, unavailable, idle and no data: unavailable is
never drawn as zero, and idle is the
[ADR-015](../decisions/ADR-015-idle-chart-buckets.md) recorded-usage zero. The disclosure is a
persistent status naming each reason with model and channel/backend identities (including
Others members), a table view, a basis chip and a value-sorted tooltip. Detail pages pass no
`bounds`, so absent buckets collapse as before; the no-data state appears only with bounds.
Shared views also draw a per-client user cost trend from `by_user_time`
(`fromByModelTime(data, client, { dimension: "user" })`, `dimension="user"` on the component).
It shares the model trend's bucket pick; user labels are masked with `maskEmail` while keys stay
raw, user series take palette colors by rank (users have no stable color identity), and the
Others table drops the channel column.

Sibling rule: the shared Claude and Codex cards come from one response, share its effective
range and bucket origins, are never summed and keep separate y-scales. Client-colored
header accents identify the cards independently of model color, including when Codex uses
a Claude model. Texture never represents client identity or availability. Bucket defaults: Cost
uses the global interval; Executive renders 24h up to 30 days, else 168h. Shared charts
never render below `bucket_hours` and roll up so the first bucket is floored.
Shared Cost/Trends request their selected resolution; shared Executive requests the
global resolution and rolls up for display. These three pages send `modelTime=1`
with `view=cost`, sharing the default cost warming profile. Custom windows, filters
and resolutions may remain cold. Moving between these pages and the others is a
`useApi` identity change that reloads instead of retaining data.

Shared chart basis chips use the response's cost basis rather than assuming every Claude
amount is reported. `mixed` is a combination of known bases, not proof of a missing report.
The computed-fallback marker requires `computed_estimate` or a positive `cost_estimated`
count; AWS list estimates alone never receive a missing-report disclosure.

Shared Cost and Trends offer page-local resolution controls, including ten and thirty
minutes through one day. The one-day default stays hourly; range changes reset the pick.
The response's `bucket_hours` governs chart ticks, gaps and zoom. Cost table identity buttons
open an inline exact user or model drilldown, scoped to its client and existing filters;
model rows also retain their backend. Identities stay local and are never added to URLs.
User drilldowns show cost and model trends. Model drilldowns show each user's percentage
of known cost, labelling partial denominators and withholding ratios for missing/zero totals.
Parent bounds drive the detail request; stale periods disable selection and detail export.
The UI requires exact-filter acknowledgment before showing detail. Background linked-refresh
failures retain the last response with its actual bounds and the shared refresh warning.

## Spend and interpretation

[spend.js](../../dashboard/web/src/spend.js) adapts API `reported_cost` to display `cost`
and preserves original computed values. Cost, Executive, Productivity and Users use it
for spend views. The model cost trends instead read raw `/api/cost/by-model-daily` rows
through `fromByModelDaily` rather than `asSpendRows`.
Legacy Usage fields (`est_cost_usd`, `cost_usd`) and Reliability diagnostic
tables remain separate consumers; do not describe the adapter as a server response change.

Cost's `showComputed` starts false. It controls diagnostic columns and the comparison
section; those API requests are still made while the section is hidden.
User/model family averages use reported spend, including valid reports for models absent
from the server price table. [score.js](../../dashboard/web/src/score.js) folds a user's
channel rows before recomputing the activity heuristic, using `user_active_days` to avoid
double-counting days. See [metrics](../metrics.md) for the limits of these measures.
