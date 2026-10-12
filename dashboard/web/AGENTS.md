# Web instructions

React 18/Vite 8/Tailwind 4/Recharts 3 SPA (Node 22.12+). Run `npm test` and `npm run build`.

## Display contracts

- `ClientContext` defaults all clients to nine shared routes via `Clients.jsx`.
  Claude `view=detail` retains advanced/A/B pages: [routing](../../docs/reference/frontend.md#routes-and-state).
  Shared views label `cost_usd` by `cost_basis`, preserve nulls/tiny positives and
  never render unsupported Claude measures as Codex zeros.
- Label known cost subtotals as partial in cards/charts/tables/CSV. Units use observed
  denominators; missing denominators/all-unknown costs stay `—`:
  [ADR-013](../../docs/decisions/ADR-013-known-cost-subtotals.md).
- Token displays/charts use labelled `observed_tokens` subtotals and `tokens_partial`;
  CSV keeps counts numeric with coverage status. Ratios use canonical fields.
  [ADR-014](../../docs/decisions/ADR-014-observed-token-subtotals.md).
- Common views do not forward Claude-only group/project filters. Client/backend selection
  survives range changes without leaking masked user IDs.
- Claude detail's `spend.js` selects `reported_cost` and retains computed diagnostics.
  Preserve null/unpriced totals/forecasts/charts/CSV; missing local prices do not invalidate reports.
- `showComputed` gates Cost's opt-in computed comparison: table/CSV columns, effort
  annotations, computed total and token-tier charts.
- Cost comparison changes remount affected `DataTable`s to reset sorting, including hidden columns.
- CSV follows displayed columns/order; `toCsv` uses `toText` or raw values, never JSX.
- With PII masking, `csv.js` masks `user` without `toText: maskEmail`; explicitly mask other
  identities. Formula-like values gain an apostrophe after masking: [CSV](../../docs/reference/ui.md#tables-and-csv).
- Cost USD accepts zero and at most two decimals. `DonutBody.valueFormatter` ignores
  `valuePrefix`; other charts keep their default formatting.
- Distinguish trace absence/loading/errors/unpriced values/measured zero.
  Shared chart empty-bucket zeros mean recorded usage; preserve explicit nulls/coverage:
  [ADR-015](../../docs/decisions/ADR-015-idle-chart-buckets.md).
- Activity/approval rates prove neither productivity nor quality. Do not invent saved hours or ROI.

## Filters, ranges, and refresh

- `RangeContext` owns range URLs; `FilterContext` owns filters. Hydrate once in state
  initializers; preserve each other's parameters.
- Never put masked users in URLs. Project filters need `/api/config` reporting
  `schema.projectColumns === true` for both URLs and requests.
- Session-scoped model filters are not precise attribution; follow the server's grain.
- Query buckets/calendar presets stay UTC. Parse timezone-less API timestamps as UTC;
  chart labels/timestamps/CSV display values use browser time.
  Derive rates from actual range duration, not the last preset; resync local chart
  granularity on global range changes.
- `useApi()` owns range/filters/refresh/aborts/payload identity.
  Align quantization/grace constants with the server warmer.
- Refreshes and period changes keep loaded data until replaced; a failed period
  load clears it. Unchanged payloads keep references; path/filter/client changes
  clear selection. Background failures retain data and signal refresh errors.
  `linkedRange` is only for parent-response bounds. `UserDrawer` does not auto-refresh.

## Components and channels

- `useGroupsShown()` owns visibility, including single mode/channel overrides;
  `GROUP_SEGMENT_ORDER` owns within-row splits.
- Channels are not emitting clients. Do not identify Codex from an OpenAI model name.
- Use Card/StatTile help/loading/error/empty conventions; absent subtitles/hints are `undefined`.
- Use one navigation element except with the mobile drawer open. Mobile navigation
  uses `Sidebar`'s NAV; keep route/navigation tests aligned.
- Time-series drag zoom changes the whole page; categorical axes do not zoom.
- UI is Korean-first with English names/identifiers. Engineering docs are English;
  documentation fixes must not translate runtime strings.

See [frontend reference](../../docs/reference/frontend.md),
[UI reference](../../docs/reference/ui.md), and [metric definitions](../../docs/metrics.md).
