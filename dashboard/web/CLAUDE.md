# Web Module

## Role
React 18 + Vite SPA rendering the dashboard's pages against `dashboard/server`'s API. Built
with `npm run build` into `dist/`, served as static files by the server (no separate hosting).

## Key Files
- `src/main.jsx`, `App.jsx` -- entry point, route table
- `src/RangeContext.jsx` -- global `from`/`to`/`intervalHours` state (`intervalHours = days
  <= 2 ? 1 : 24`)
- `src/FilterContext.jsx` -- global `group`/`user`/`model` filter state
- `src/useApi.js` -- shared fetch hook; auto-forwards range+filters to every endpoint call
- `src/pages/*.jsx` -- one file per dashboard page (Overview, Cost, Productivity, Users,
  Trends, Executive)
- `src/components/*.jsx` -- shared presentational components (`Card`, `StatTile`, `Badge`,
  `SegmentedControl`, `DataTable`, `GroupCharts`, `FloatingChat`, `PageHeader`, `RangePicker`)
- `src/pivot.js` -- reshapes flat `[{t, group, value}]` rows into one-row-per-x-tick for
  Recharts (`pivotByGroup`, `pivotByKey`)
- `src/fmt.js`, `colors.js`, `useChartColors.js` -- tick formatting, group color palette,
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
