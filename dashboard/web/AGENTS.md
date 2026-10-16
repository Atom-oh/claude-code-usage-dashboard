# Web

React 18/Vite 8/Tailwind 4/Recharts 3 SPA, Node 22.12+. Run npm test/npm run build.

## Display

- ClientContext: all clients default to nine shared routes via Clients.jsx; Claude view=detail: advanced/A/B pages, [routing](../../docs/reference/frontend.md#routes-and-state). Label shared cost_usd by cost_basis; keep nulls/tiny positives. Unsupported Claude measures never become Codex zeros.
- Known cost subtotals: partial cards/charts/tables/CSV. Units: observed denominators; missing denominators/all-unknown costs: —, [ADR-013](../../docs/decisions/ADR-013-known-cost-subtotals.md).
- Token displays/charts: label observed_tokens subtotals/tokens_partial; CSV: numeric counts/coverage. Ratios use canonical fields: [ADR-014](../../docs/decisions/ADR-014-observed-token-subtotals.md).
- Common views never forward Claude-only group/project filters. Preserve client/backend selection across ranges; never leak masked user IDs.
- Claude detail spend.js: reported_cost/computed diagnostics; keep null/unpriced totals/forecasts/charts/CSV. Valid reports survive missing local prices.
- showComputed gates Cost's opt-in comparison: table/CSV columns, effort annotations, computed total/token-tier charts.
- Comparison changes: remount affected DataTables, reset sorting including hidden computed columns.
- CSV follows displayed columns/order; toCsv: toText/raw values, never JSX.
- PII masking: csv.js masks user without toText: maskEmail; mask other IDs explicitly. Prefix formula-like values with apostrophe after masking: [CSV](../../docs/reference/ui.md#tables-and-csv).
- Cost USD accepts zero/≤2 decimals. DonutBody.valueFormatter ignores valuePrefix; other charts keep defaults.
- Distinguish trace absence/loading/errors/unpriced/measured zero. Shared empty-bucket zeros: recorded usage only; keep nulls/coverage, [ADR-015](../../docs/decisions/ADR-015-idle-chart-buckets.md).
- Activity/approval rates prove neither productivity nor quality; never invent saved hours/ROI.

## State

- RangeContext: range URLs; FilterContext: filters. Initializers hydrate once; preserve each other's parameters.
- No masked users in URLs. Project URLs/requests require /api/config schema.projectColumns ===true.
- Session-scoped model filters are not precise attribution; follow server's documented grain.
- Buckets/calendar presets: UTC; parse timezone-less API timestamps as UTC. Chart labels/timestamps/CSV: browser time zone. Rates: actual duration, not last preset; resync local granularity on global range changes.
- useApi(): range/filter requests/refresh/aborts/payload identity; match server quantization/grace.
- Refresh/period changes: retain data until replaced; period failures clear it. Unchanged payloads: same references. Path/filter/client changes: clear selection. Background failures: retain data/show refresh errors. linkedRange: parent-response bounds only; UserDrawer: no auto-refresh.

## UI

- useGroupsShown(): card visibility/single mode/channel overrides; GROUP_SEGMENT_ORDER: within-row splits.
- Channels ≠ emitting clients; never infer Codex from OpenAI model names.
- Card/StatTile: help/loading/error/empty conventions; absent subtitles/hints: undefined.
- One nav element except mobile drawer open; mobile: Sidebar NAV. Align route/navigation tests.
- Time-series drag: whole-page zoom; categorical axes never zoom.
- UI Korean-first, technical names/IDs English; engineering docs English. Never translate runtime strings in doc edits.

[Frontend](../../docs/reference/frontend.md),
[UI](../../docs/reference/ui.md); [Metrics](../../docs/metrics.md).
