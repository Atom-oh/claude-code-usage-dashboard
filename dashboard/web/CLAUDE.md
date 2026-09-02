# Web Module

## Role
React 18 + Vite SPA rendering the dashboard's pages against `dashboard/server`'s API. Built
with `npm run build` into `dist/`, served as static files by the server (no separate hosting).

## Key Files
- `src/main.jsx`, `App.jsx` -- entry point, route table
- `src/RangeContext.jsx` -- global `from`/`to`/`intervalHours` state. Two modes: preset
  (`intervalHours = days <= 2 ? 1 : 24`) or custom (set via chart drag-zoom's `setRange()`,
  `intervalHours` derived from the zoomed span down to minute buckets, see
  `RESOLUTION_LADDER_MIN`)
- `src/FilterContext.jsx` -- global `group`/`user`/`model` filter state
- `src/useApi.js` -- shared fetch hook; auto-forwards range+filters to every endpoint call
- `src/pages/*.jsx` -- one file per dashboard page (Overview, Cost, Productivity, Users,
  Trends, Executive)
- `src/components/*.jsx` -- shared presentational components (`Card`, `StatTile`, `Badge`,
  `SegmentedControl`, `DataTable`, `GroupCharts`, `FloatingChat`, `PageHeader`, `RangePicker`)
- `src/components/ABScoreboard.jsx` / `LowerBoundNote.jsx` -- 2026-09-01 additions:
  the Executive hero split-band (one row per KPI, bedrock left / enterprise right around a
  center label, single 6px split bar — note `pct` format expects a 0-1 fraction, not a
  percentage) and the reusable "dashboard cost is a lower bound of real billing" warning
  callout, used on Executive and Cost respectively. Its causes are measured facts, keep them
  in sync with the data layer: un-instrumented launch paths (telemetry env missing),
  `--resume` counter resets lost by the session-boundary diff, the unpriced-model exclusion
  (models absent from the pricing table — Bedrock's non-Anthropic models — are excluded from
  computed cost and shown separately as `unpriced_tokens`; the old ">200K long-context premium
  not priced" claim was factually wrong and has been removed, see ADR-003/pricing.js), and
  non-instrumented channels. The causes are now conditional on the schema probe:
  `LowerBoundNote` fetches `/api/config` and drops the `--resume` cause only when
  `schema.segmentAwareSeriesKey === true`; any other value (`false`/`null`/undefined/failed or
  aborted fetch/older server with no `schema` key) fails safe to the full cause list. Thinking
  tokens ARE included in OTel output (measured 2026-09-02) — an earlier version of the copy
  claimed otherwise
- `src/pivot.js` -- reshapes flat `[{t, group, value}]` rows into one-row-per-x-tick for
  Recharts (`pivotByGroup`, `pivotByKey`)
- `src/fmt.js`, `colors.js`, `useChartColors.js` -- tick formatting, group color palette +
  model-family palette (`modelColorFor` — fixed per-family hues, single source `MODEL_COLOR`),
  CSS-variable-based chart colors

## Rules
- Any page-local granularity/interval control must re-sync from `RangeContext`'s
  `intervalHours` via `useEffect`, not just a `useState` initializer — otherwise switching the
  global range preset (e.g. 7일 -> 1일) leaves the page's chart stuck on the old bucket size
  (a real bug, fixed once already on the Cost page).
- Dragging on any time-series chart (`GroupAreaChart`/`DualLineChart`/`SeriesBarChart` in
  `GroupCharts.jsx`) zooms the **whole page**, not just that chart — it calls
  `RangeContext.setRange()` which sets a custom from/to and auto-picks a finer `intervalHours`
  (down to minute buckets). This is global by design, consistent with the global `RangePicker`.
  The drag no-ops on categorical axes (labels that don't parse as dates), so no opt-in is
  needed. Server `bucket()` handles `intervalHours < 1` as MINUTE buckets.
- New chart/table components should accept a `right` prop for a `SegmentedControl` if a page
  might want a per-card filter tab — this is the established pattern (see `DonutBreakdown` in
  `GroupCharts.jsx`), not a new `right`-less variant per page.
- No CSS modules, no component library beyond what's already imported (Tailwind + Recharts +
  lucide-react) — keep additions consistent with the existing minimal stack.
- `pivotByKey`'s x-axis sort assumes date-like `xKey` values; if a page passes a categorical
  `xKey` (e.g. tool name), the sort intentionally falls back to insertion order (see the
  comment in `pivot.js`) rather than guessing.
