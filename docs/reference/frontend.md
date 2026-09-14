# Frontend Implementation

The React 18/Vite SPA is built into the same image as the Express server.
See [web/AGENTS.md](../../dashboard/web/AGENTS.md) for developer instructions and
[UI](ui.md) for component and export contracts.

## Routes and state

[App.jsx](../../dashboard/web/src/App.jsx) retains these nine Claude detail routes:

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
| `/analytics` | Analytics chat |

All-client and Codex modes use the common usage/cost page at `/`; other detail URLs
redirect there with supported filters preserved. `ClientContext` owns activation
selection. Common views expose backend filtering, omit Claude channel/project filters,
and hide Claude-specific chat. No Codex enterprise comparison is created.

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
range and actual API window can differ near now.

The hook aborts obsolete parameter requests and reuses data identity for unchanged payloads.
A same-parameter refresh preserves visible data on failure and reports a refresh error;
a changed-parameter failure clears it. A tick that changes the quantized range is a new
parameter load. Do not promise that every refresh avoids the loading state.

[RefreshContext.jsx](../../dashboard/web/src/RefreshContext.jsx) defaults to 60 seconds,
persists the selected interval, pauses hidden tabs, refreshes when visible, and skips one
scheduled tick after a reported failure. Its UTC `dayKey` updates range-derived dates.
Page-local interval controls must resync from global range changes, as
[Cost.jsx](../../dashboard/web/src/pages/Cost.jsx) does.

## Spend and interpretation

[spend.js](../../dashboard/web/src/spend.js) adapts API `reported_cost` to display `cost`
and preserves original computed values. Cost, Executive, Productivity and Users use it
for spend views. Legacy Usage fields (`est_cost_usd`, `cost_usd`) and Reliability diagnostic
tables remain separate consumers; do not describe the adapter as a server response change.

Cost's `showComputed` starts false. It controls diagnostic columns and the comparison
section; those API requests are still made while the section is hidden.
User/model family averages use reported spend, including valid reports for models absent
from the server price table. [score.js](../../dashboard/web/src/score.js) folds a user's
channel rows before recomputing the activity heuristic, using `user_active_days` to avoid
double-counting days. See [metrics](../metrics.md) for the limits of these measures.
