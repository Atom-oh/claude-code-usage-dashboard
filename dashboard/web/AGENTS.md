# Web instructions

React 18, Vite, Tailwind, and Recharts form a static SPA. Run `npm test` and
`npm run build` here. Keep additions within the existing component stack.

## Display contracts

- `ClientContext` defaults all clients to nine shared routes via `Clients.jsx`.
  Claude `view=detail` retains advanced/A/B pages; see [routing](../../docs/reference/frontend.md#routes-and-state).
  Common views label `cost_usd` by `cost_basis`, preserve nulls/tiny positive amounts,
  and never display unsupported Claude measures as Codex zeros.
- Common views do not forward Claude-only group/project filters. Client/backend selection
  survives range changes without leaking masked user IDs.
- Claude detail uses `spend.js` to select `reported_cost`, retaining original computed
  values for diagnostics. Preserve null/unpriced states through totals, forecasts,
  charts, and CSV exports. A missing local price does not invalidate a valid report.
- Cost's computed comparison is opt-in. Its columns, CSV columns, effort annotations,
  computed total, and token-tier charts follow `showComputed`.
- `DataTable` has internal sort state. Cost remounts affected tables when comparison
  mode changes, which resets all their sorting, including hidden computed columns.
- CSV exports the displayed columns and their current row order. This intentionally
  permits the export schema to follow the table. `toCsv` uses `toText` or raw values,
  never JSX renderers.
- `csv.js` centrally masks columns keyed `user` when PII masking is enabled; absence
  of a per-column `toText: maskEmail` is not itself a leak. Other identity-bearing
  columns need explicit masking.
- Cost's USD formatter accepts zero and uses at most two decimal places. With
  `DonutBody.valueFormatter`, `valuePrefix` is ignored; it is not added twice.
  Other charts retain their existing default formatting.
- Trace absence, loading, errors, unpriced values, and measured zero are distinct states.
- Existing activity scores and permission-approval rates are not validated causal
  productivity or code-quality measures. Do not invent saved hours or ROI.

## Filters, ranges, and refresh

- `RangeContext` owns range URL state; `FilterContext` owns filter state. Hydrate once
  in state initializers and preserve the other provider's parameters.
- A masked user filter must never enter the URL. Project filters enter neither URLs
  nor requests unless `/api/config` reports `schema.projectColumns === true`.
- Model filtering of session-scoped measures is not precise model attribution.
  Follow the documented server contract rather than assuming all measures share a grain.
- Query buckets and calendar presets remain UTC; chart labels, timestamps and their CSV
  display values use the browser time zone. Parse timezone-less API timestamps as UTC.
  Use actual range duration for derived rates, not the last
  selected preset. Resync local chart granularity when the global range changes.
- Use `useApi()` for range/filter forwarding, refresh, aborts, and payload identity.
  Keep its quantization/grace constants aligned with the server cache warmer.
- Automatic refreshes retain loaded content even when the quantized window moves.
  Actual range/filter/client changes clear the previous selection; background failures
  retain it and signal the refresh error. Unchanged payloads retain their references.
  Dependent panels may opt into `linkedRange` for response-derived bounds only.
  `UserDrawer` does not auto-refresh.

## Components and channels

- `useGroupsShown()` owns card visibility, including single mode and selected-channel
  overrides. Within-row splits use `GROUP_SEGMENT_ORDER`; do not conflate the two.
- Channels are not emitting clients. Do not identify Codex from an OpenAI model name.
- Use existing Card/StatTile help, loading, error, and empty-state conventions.
  Omit absent subtitles/hints with `undefined`, not an empty string.
- There is one navigation element unless the mobile drawer is open. Mobile navigation
  reuses `Sidebar`'s exported NAV. Keep route and navigation tests aligned.
- Time-series drag zoom changes the whole page; categorical axes do not zoom.
- Product UI is Korean-first with existing English names/identifiers. Engineering
  documentation is English-only; do not translate runtime strings as a documentation fix.

See [frontend reference](../../docs/reference/frontend.md),
[UI reference](../../docs/reference/ui.md), and [metric definitions](../../docs/metrics.md).
