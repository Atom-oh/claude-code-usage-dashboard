# Web instructions

React 18/Vite/Tailwind/Recharts static SPA. Run `npm test` and `npm run build` here;
use the existing component stack.

## Display contracts

- `ClientContext` defaults all clients to nine shared routes via `Clients.jsx`.
  Claude `view=detail` retains advanced/A/B pages; see [routing](../../docs/reference/frontend.md#routes-and-state).
  Common views label `cost_usd` by `cost_basis`, retain nulls/tiny positives, and never
  show unsupported Claude measures as Codex zeros.
- Shared costs display usable subtotals despite excluded records, marked as partial
  in cards, chart context, tables and CSV. Cost units use that subtotal over observed
  denominators; missing denominators remain unavailable. All-unknown costs stay `—`.
  This follows [ADR-013](../../docs/decisions/ADR-013-known-cost-subtotals.md).
- Common views do not forward Claude-only group/project filters. Client/backend selection
  survives range changes without leaking masked user IDs.
- Claude detail's `spend.js` selects `reported_cost`, retaining computed diagnostics.
  Preserve null/unpriced totals, forecasts, charts and CSV. Missing local prices do
  not invalidate valid reports.
- `showComputed` gates Cost's opt-in computed comparison: table/CSV columns, effort
  annotations, computed total and token-tier charts.
- Cost remounts affected `DataTable`s on comparison changes, resetting all internal
  sorting, including hidden computed columns.
- CSV schema follows displayed columns; export their current row order. `toCsv` uses
  `toText` or raw values, never JSX renderers.
- `csv.js` centrally masks `user` columns under PII masking; missing per-column
  `toText: maskEmail` alone is not a leak. Other identity columns need explicit masking.
- Cost USD accepts zero and at most two decimals. `DonutBody.valueFormatter` ignores
  `valuePrefix`; other charts keep their default formatting.
- Keep trace absence, loading, errors, unpriced values and measured zero distinct.
- Activity scores and permission-approval rates do not validate causal productivity
  or code quality. Do not invent saved hours or ROI.

## Filters, ranges, and refresh

- `RangeContext` owns range URL state; `FilterContext` owns filters. Hydrate once in
  state initializers; preserve each other's parameters.
- Never put masked users in URLs. Project filters need `/api/config` reporting
  `schema.projectColumns === true` for both URLs and requests.
- Model filters on session-scoped measures are not precise attribution; follow the
  server's documented measurement grain.
- Query buckets/calendar presets stay UTC. Parse timezone-less API timestamps as UTC,
  then display chart labels, timestamps and CSV display values in the browser time zone.
  Derive rates from actual range duration, not the last preset; resync local chart
  granularity on global range changes.
- Use `useApi()` for range/filter forwarding, refresh, aborts, and payload identity.
  Keep its quantization/grace constants aligned with the server cache warmer.
- Refresh retains loaded content as quantized windows move; unchanged payloads keep
  their references. Range/filter/client changes clear the selection. Background
  failures retain data and signal refresh errors. `linkedRange` is only for
  parent-response bounds. `UserDrawer` does not auto-refresh.

## Components and channels

- `useGroupsShown()` owns card visibility, including single mode/channel overrides.
  `GROUP_SEGMENT_ORDER` owns within-row splits; keep these roles distinct.
- Channels are not emitting clients. Do not identify Codex from an OpenAI model name.
- Use existing Card/StatTile help, loading, error, and empty-state conventions.
  Omit absent subtitles/hints with `undefined`, not an empty string.
- One navigation element, except with the mobile drawer open. Mobile navigation uses
  `Sidebar`'s exported NAV; keep route/navigation tests aligned.
- Time-series drag zoom changes the whole page; categorical axes do not zoom.
- UI is Korean-first with existing English names/identifiers; engineering docs are
  English-only. Do not translate runtime strings in documentation fixes.

See [frontend reference](../../docs/reference/frontend.md),
[UI reference](../../docs/reference/ui.md), and [metric definitions](../../docs/metrics.md).
