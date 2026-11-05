# Team attribute: display and filter

Status: approved by the user 2026-11-04 (display + filter; no team aggregation views).

## Data

Clients send `team` as an OTel resource attribute (the collector keeps it, see
`collector-config.yaml`). Observed 2026-11-04 (30 days): every event that carries it has
`ResourceAttributes['team']`; `LogAttributes['team']` is present on a subset. One value today
(`fsi-realtest`, 4 users); 2 users send none; no user switched teams. The hourly rollup
`otel_metrics_sum_hourly` has no team column; raw `otel_logs` and `otel_metrics_sum` carry it.

Team is client-provided attribution, not verified identity (same caveat as `user.email`).

## Resolution

- **Session → team:** from `otel_logs` (`LogAttributes['session.id']`,
  `coalesce(nullIf(ResourceAttributes['team'],''), nullIf(LogAttributes['team'],''))`),
  scanning the query window plus the existing lookback. A session with several values keeps
  the most frequent (ties: lexical); none → no team.
- **User → team** (for display): the team of the user's most recent session in the window
  that has one; users with several teams in the window expose all of them (`teams: []`,
  primary first). No team → `null`, rendered "—".
- Logs are retained 90 days; older counter-only sessions have no team and are disclosed as
  such, never assigned a guessed team.

## Filter

- New query parameter `team` (exact match, same validation as other filters in `http.js`),
  carried by `FilterContext` and URL state like `project`, preserved across range changes.
- Server: `filterCond()` gains `teamViaSession` (session semi-join against the session→team
  set, mirroring `modelViaSession`); endpoints whose grain has a session column apply it.
  Endpoints that cannot apply it must not silently ignore it: return the existing
  "filter not applied" signal pattern (see how model/project filters disclose
  non-applicability) or reject, consistent with current conventions.
- Codex and shared client views: apply where the source carries the resource attribute
  (Codex completion logs live in `otel_logs` too); otherwise do not forward the filter and
  show it as not applicable, per the existing rule that common views never forward
  Claude-only filters.
- The filter control lists teams observed in the window (`GET /api/teams`); hidden when
  none exist.

## Display

- `GET /api/users/teams` → `{ users: [{ user, team, teams }] }` for the window (shared
  `route()` wrapping, bound params, PII rules unchanged: user IDs follow existing masking).
- Web joins it into every user-level view: Users page tables, Cost per-user tables and
  per-user panel, top-user charts (tooltip/label suffix), UserDrawer header. Team column is
  sortable and included in CSV after the user column.

## Tests

Server: session→team resolution (frequency, tie, none, two teams), filter semi-join SQL
with bound params, `/api/teams` and `/api/users/teams` routes, non-applicable endpoints
disclose. ClickHouse integration via the existing disposable harness. Web: filter control
URL round-trip and hidden-when-empty, team column/CSV in each listed view, "—" for none.
Keep the PR under 90,000 diff bytes / 2,800 lines.
