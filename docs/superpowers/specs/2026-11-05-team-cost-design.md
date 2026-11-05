# Team cost view

Status: draft for user approval (2026-11-05).

## Intent

Operators want to see what each team spends, next to the existing per-user costs.
The team filter and the team column in user tables shipped in #200–#202
([team attribute design](2026-11-04-team-attribute-design.md)). That design excluded
team aggregation; this one adds it. The user's reference is the department token
dashboard of a separate project (summary card, distribution chart, department table,
department column in the user table), without its budgets.

## Goals

- A **team cost section on the Cost page**:
  - Summary cards: active teams in the range; share of cost with a known team.
  - Team cost distribution: one bar per team for the range total, and a trend chart with
    the same bucket as the existing "모델별 비용 추이" (`intervalHours`).
  - Team table: team, cost, share of total, tokens, requests, active users, sessions;
    sortable, CSV export, stale-gated like other Cost tables.
- The existing per-user cost tables keep their team column (no change needed).
- Honors the existing global filters (group, user, model, project, team) the way the
  other Cost sections do.

## Non-goals

- Budgets, limits or utilization (explicitly declined by the user).
- Any integration with other projects; the only team source is the OTel `team`
  attribute already read by `sessionTeamsSql`.
- Team drill-down views. Selecting a team in the filter already narrows every user
  table to that team.
- Codex cost by team in this change (see "Builder's calls").

## Anti-goals

- Guessing a team. Cost without team evidence is shown as its own "팀 없음" row, never
  spread across teams.
- Totals that disagree with the page: the sum of team rows plus "팀 없음" must equal the
  "총 비용" tile (`costSummary`) for the same filters and range.
- Treating team as verified identity (it is client-provided, like `user.email`).

## Constraints (project contracts)

- Spend is Claude `reported_cost` from counters, aggregated with `incFlat` (never summing
  cumulative samples). Keep the computed-cost diagnostics and the partial/unpriced
  disclosure exactly as the Cost summary does; all-unknown is unavailable, not zero.
- Team attribution is per **session**: each counter row's `SessionId` joins
  `sessionTeamsSql(["claude"], …)` (most frequent team value in the session's logs over
  the window plus the counter lookback; ties lexical). A user who changed teams has each
  session's cost on that session's team.
- Sessions without team evidence (no attribute, or counter-only beyond 90-day log
  retention) land in "팀 없음". The UI discloses why such cost can exist.
- Bound SQL parameters, shared `route()` wrapping (validation, cache, in-flight
  deduplication, no-store JSON), and the existing filter semantics. The new route accepts
  `team`: with a team selected the table shows that team's row only.
- Active users = distinct users with in-window usage in that team's sessions.
  Requests = `api_request` log events in those sessions over the window.

## Shape

- **Server:** one route, `GET /api/cost/by-team` (and `intervalHours` for the trend),
  returning per team: `team` (null = 팀 없음), `cost`, `cost_partial`, token subtotals and
  `tokens`, `requests`, `users`, `sessions`, plus per-bucket cost for the trend.
  Reuse `TOKEN_SUMS`/`withComputedCost` and `sessionTeamsSql`.
- **Web:** a "팀별 비용" section on Cost.jsx using the existing Card/DataTable/chart
  components and `useApi` stale handling.
- **Docs:** API reference row for the route, metrics/UI references for the section.

## Builder's calls (decided by the assistant, user may override)

- **Channel basis: include `unknown`.** Team cost is a total-type metric, so it follows the
  `filterCond` policy for totals (`excludeUnknown: false`, as `costSummary` and
  `activeUsers` do), not the A/B comparison default. Consequence: the team trend has its
  own query and is not bucket-for-bucket comparable with "모델별 비용 추이", which excludes
  `unknown`; the section subtitle says the basis matches "총 비용". An explicit
  `group=unknown` or other group filter still applies.
- **Many teams:** the bar chart and trend show the top 8 teams by known cost over the
  range plus one "기타" series (and "팀 없음"), like the user trend's top-N fold; the table
  and CSV list every team. The trend stays within the existing row limits.
- **Sessions:** distinct `SessionId`s with in-window usage per team. This does not
  reconcile with the "세션" tile (`claude_code.session.count`), and the column help says
  so.
- Claude only. The Cost page is Claude spend; Codex spend lives in the Clients views
  and uses different session ids and pricing adapters. Codex-by-team can follow the
  same pattern later.
- Placement on the Cost page rather than a new page or Overview.
- "팀 없음" is listed last regardless of sort, and excluded from the active-teams count.

## Left to the builder

Query structure and caching details, chart component choice within the existing set,
and exact copy, within the constraints above.
