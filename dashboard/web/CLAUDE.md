# Web Module

## Role
React 18 + Vite SPA rendering the dashboard's pages against `dashboard/server`'s API. Built
with `npm run build` into `dist/`, served as static files by the server (no separate hosting).

## Key Files
- `src/main.jsx`, `App.jsx` -- entry point, route table
- `src/RangeContext.jsx` -- global `from`/`to`/`intervalHours` state. Three modes: preset
  (`intervalHours = days <= 2 ? 1 : 24`), month (이번 달 -- current UTC month to now, 24h
  buckets), and custom (a from/to pair carrying a `source` flag: `"zoom"` from chart drag-zoom,
  `intervalHours` derived from the zoomed span down to minute buckets via
  `RESOLUTION_LADDER_MIN`; `"calendar"` from the date-range popover, which follows the preset
  rule instead so the Cost page's granularity control still has a matching option)
- `src/FilterContext.jsx` -- global `group`/`user`/`model` filter state
- `src/useApi.js` -- shared fetch hook; auto-forwards range+filters to every endpoint call
- `src/RefreshContext.jsx` -- auto-refresh state: a selectable interval
  (`REFRESH_OPTIONS`, persisted in `localStorage` under `ccdash.refreshMs`), a `tick` counter
  `useApi.js` depends on, a `dayKey` that changes at most once per UTC day (`RangeContext.jsx`
  depends on that one instead of `tick`), and failure/backoff state consumed by
  `RefreshControl.jsx`
- `src/components/RefreshControl.jsx` -- the manual-refresh button + interval `<select>` +
  last-refreshed/failed label mounted at the right edge of `FilterBar`
- `src/components/DateRangePopover.jsx` -- the calendar popover behind `RangePicker`'s
  `CalendarDays` trigger; two `<input type="date">`s, UTC-day arithmetic, and the
  `rangeCapDays` check mirrored from the server's `parseRange`
- `src/pages/*.jsx` -- one file per dashboard page (Overview, Cost, Productivity, Users,
  Trends, Executive)
- `src/components/*.jsx` -- shared presentational components (`Card`, `StatTile`, `Badge`,
  `SegmentedControl`, `DataTable`, `GroupCharts`, `FloatingChat`, `PageHeader`, `RangePicker`)
- `src/components/ABScoreboard.jsx` / `LowerBoundNote.jsx` -- 2026-09-01 additions:
  the Executive hero split-band (one row per KPI, bedrock left / enterprise right around a
  center label, single 6px split bar — note `pct` format expects a 0-1 fraction, not a
  percentage) and the reusable "dashboard cost is a lower bound of real billing" warning
  callout. `ABScoreboard` is Executive-only; `LowerBoundNote` is mounted on the Cost page and,
  since 2026-09-02, on the Executive page's Cost section too — the two places a spend figure is
  stated as if it were exact. Its causes are measured facts, keep them
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
- `src/FreshnessContext.jsx` / `src/components/FreshnessBanner.jsx` -- 2026-09-02 additions:
  the provider polls `GET /api/health/data` every 60s and exposes
  `{status: "loading"|"ok"|"stale"|"unknown", latest, ageMinutes, staleAfterMinutes}` via
  `useFreshness()`. It parses the JSON body on **503 as well as 200**, because the endpoint
  deliberately answers 503 for `stale`/`unknown` — treating 503 as a network error would make
  the banner permanently say "unknown" and never show a real staleness age. A genuine fetch
  failure or non-JSON body folds to `unknown`; an `AbortError` (next poll, or unmount) leaves
  the state alone, same convention as `useApi.js`. The banner renders `null` for `ok` **and**
  `loading` (so nothing flashes before the first response), takes a `className` rather than
  being wrapped at the call site (a wrapper would leave a 12px gap on every healthy page,
  since the component renders nothing), and reuses `LowerBoundNote`'s warning-callout classes
- `src/pivot.js` -- reshapes flat `[{t, group, value}]` rows into one-row-per-x-tick for
  Recharts (`pivotByGroup`, `pivotByKey`)
- `src/urlState.js` -- pure URL-search-param <-> `{range, filters}` mapping
  (`parseUrlState`/`serializeUrlState`), unit-tested in `urlState.test.js`. `RangeContext` owns
  the `days`/`from`/`to` params and `FilterContext` owns `group`/`user`/`model`; each preserves
  the other's keys when it writes (except `user` while `piiMask` is on -- see the rule below),
  and both write with `replace: true` so the history stack is not filled by preset clicks.
  `permalink.test.jsx` mounts the real providers inside a `MemoryRouter` to pin this
  round-trip; `urlState.test.js` only covers the pure mapping. `PRESET_DAYS` (`[1, 2, 7, 30]`)
  lives here as the single source -- `RangePicker.jsx` appends `defaultRangeDays` to it rather
  than keeping its own copy. The URL range is one of three shapes: `days` for a preset,
  `period=month` for 이번 달, or `from`/`to` for a custom (drag-zoom or calendar) range.
- `src/fmt.js`, `colors.js`, `useChartColors.js` -- tick formatting, group color palette +
  model-family palette (`modelColorFor` — fixed per-family hues, single source `MODEL_COLOR`),
  CSS-variable-based chart colors. `colors.js` also exports `GROUP_SEGMENT_ORDER` (bedrock ->
  enterprise -> unknown, fixed), the order used wherever group segments are drawn *inside one
  row* (a stacked bar and its legend) — distinct from `GROUP_ORDER`, which answers "which
  groups get a card" and so has no `unknown`
- `src/components/MobileNav.jsx` -- the `lg:hidden` top bar + slide-over drawer that renders
  below the `lg` (1024px) breakpoint, where `Sidebar`'s `hidden lg:flex` leaves the SPA with
  no navigation at all. Reuses `Sidebar.jsx`'s exported `NAV`/`NavItem` rather than
  duplicating the active-state classes. Closes on backdrop click, the `X` button, `Escape`,
  or any route change
- `src/csv.js` -- pure `toCsv`/`csvFilename`/`downloadCsv`, client-side only, no server
  involvement, unit-tested in `csv.test.js`. `toCsv` never calls a column's `render` — a
  `render` can return JSX, and even a string-returning one (thousand separators) stops a
  spreadsheet reading the column as numeric — so the cell is `col.toText(v, r)` when present,
  otherwise the raw value

## Rules
- Any page-local granularity/interval control must re-sync from `RangeContext`'s
  `intervalHours` via `useEffect`, not just a `useState` initializer — otherwise switching the
  global range preset (e.g. 7일 -> 1일) leaves the page's chart stuck on the old bucket size
  (a real bug, fixed once already on the Cost page).
- **The `user` filter never enters the URL while `piiMask` is on.** Its value is the raw text the
  operator typed and the server matches it against `UserEmail`, so it is an address --
  `serializeUrlState` omits the key and `parseUrlState` refuses to read it back, which also stops
  a hand-crafted link from populating the filter, and `RangeContext`'s writer does not carry an
  incoming `user` key over either -- both providers write the URL in the same tick at mount and
  the outer one's `navigate` wins, so a blind "preserve the other side's keys" there resurrected
  the address (measured 2026-09-03 in jsdom). Masking off (a workshop account, where emails
  are synthetic `{accountid}@ws` addresses) is the only case where it is written.
- URL state is hydrated **once, in a `useState` initializer**, not in an effect. Re-parsing on
  every render would let the URL's stale value overwrite a selection the user just made.
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
- **`PageHeader`'s `live` pill is gated on data freshness, not just the `live` prop.**
  `live && status === "ok"` renders the 실시간 badge; `live && status === "stale"` renders a
  warning-toned `수신 중단` pill instead; `loading`/`unknown` render neither (the
  `FreshnessBanner` already states that case, and two simultaneous warnings read as two
  problems). The stale pill is a hand-rolled `span` rather than a `Badge`, because `Badge` has
  no `warning` tone and `cn()` is a plain string join, not `tailwind-merge`, so a tone class
  cannot be overridden through `className`. Two pages pass `live`: `Overview` and `Trends`.
- **`groupsShown(groupMode, rows)` (`pivot.js`) is the single rule for which groups get a card.**
  `ab` always renders both, deliberately -- an empty card distinguishes "no data yet" from "this
  org has no such channel". `single` renders only the groups present in the response, falling back
  to the first group so the card (and its empty state) still exists. Never iterate `GROUP_ORDER`
  or a literal `["bedrock", "enterprise"]` directly in a page; the chart layer already derives its
  own series from the response via `groupsPresent`. The one legitimate neighbour of this rule is a
  **within-row** group split (the Cost page's 그룹 비중 stacked bar) -- that is not a
  card-visibility question, so it orders its segments by `colors.js`'s `GROUP_SEGMENT_ORDER`,
  still a shared constant and never a literal in the page, and the column is dropped entirely
  when `groupMode === "single"`.
- **`FilterBar` hides the channel `SegmentedControl` in `single` mode** for the same reason a
  single-channel org gets one card: offering two channel names to an org that has one is a
  false affordance. The `group` param itself is untouched -- `FilterContext`, `useApi.js` and
  `urlState.js` are unchanged, so a hand-typed `?group=bedrock` still applies server-side.
  This hides the control, it does not change the API contract.
- **`unknown`-group exclusion is a server policy and `groupMode` does not change it.** Most A/B
  endpoints exclude `unknown` while the "총계" endpoints (`activeUsers`, `adoptionLevels`,
  `adoptionTimeseries`, `kpiSummary`, `costSummary`) include it -- see `queries.js`'s `filterCond`
  policy comment. A single-channel org therefore still sees an `unknown` share in the totals, and
  that is correct, not a bug in single mode.
- **The Cost page's Effort and Agent panels show the token×price COMPUTED cost**, like every
  other card on that page, with Claude Code's reported `cost.usage` beside it as a secondary
  contrast column — `effortMix`/`agentCost` return `rollupComputedCost()` output (`cost` +
  `reported_cost` + `tokens` + `unpriced_tokens`) server-side. This reverses the earlier rule
  that these two panels were the reported-cost pair: reported cost is priced client-side from
  the client's own table, so it moves with the Claude Code version (measured 2026-09-03:
  v2.1.251 prices `claude-fable-5-1` off the opus-5 row → ≈0.5× of list, v2.1.258 at list,
  while `claude-fable-5` is ≈1.00 on every version), whereas tokens × `pricing.js` is
  client-independent. Do not flip these two panels back to reported-only.
  The per-user table's `unknown 그룹 포함` checkbox is display-only: it re-fetches
  `/api/cost/by-user-model` with `includeUnknown=1` for that table alone, while the spend
  ranking above it keeps the default (unknown-excluded) view because it is an A/B-join
  consumer (see the policy comment on that route in `server/index.js`).
- **There is exactly one `<nav>` in the DOM unless the mobile drawer is open.**
  `App.test.jsx`'s `container.querySelector("nav")` picks the **first** `<nav>` to assert the
  route↔nav-link set, and `MobileNav` renders before `Sidebar` — so `MobileNav` renders its own
  `<nav>` only inside its `open` branch. Rendering it while closed does **not** fail the suite
  (실측 2026-09-03: deleting the `open &&` guard leaves `App.test.jsx` green, because
  `MobileNav` reuses the same `NAV` and the two link lists are identical); it silently
  re-points that assertion at the drawer and the sidebar stops being covered at all. That is
  the failure mode to protect against — a lost assertion, not a red test. The same test pins
  `main.children.length === 2` on every route, which is why `MobileNav`'s top bar is a sibling
  of `<main>`, never a child.
- **The CSV export shows what the table shows.** A `DataTable` gains the button only when
  its call site passes `exportName` (opt-in) — `toText` is added to a column only where the
  raw value cannot reproduce the cell shown on screen, and a raw email is never exported
  while `piiMask` is on: masking is applied inside `toCsv` for `key === "user"` and gated a
  second time by `fmt.js`'s module flag, so a new user-bearing column must use the key
  `user` to be covered. Group-split cards put the group in the `exportName` template (e.g.
  `` `usage_tool_mcp_${g}` ``) so two cards do not collide on one filename.
- **A dashboard day is a UTC day.** Both 이번 달's month start and the calendar popover's two
  bounds are built with `Date.UTC`, because the server's buckets and `fmt.js`'s tick labels are
  UTC -- a local month start renders a half-width first bucket.
- **`RangeContext`'s `to` must not depend on the refresh tick.** It recomputes at most once per
  UTC day via `dayKey` (`RefreshContext.jsx`); making the memo depend on `tick` instead would
  reset `Cost.jsx`'s local granularity every minute.
- **A tick-driven refetch never flips `loading`, never blanks populated data**, and is skipped
  while a params load for the same key is already in flight; a byte-identical payload keeps the
  previous `data` reference so Recharts does not re-animate and `DataTable`'s sort does not
  reset.
- **`period=month` is a range key and `FilterContext` must preserve it** alongside
  `days`/`from`/`to` -- `setSearchParams(fn)` does not merge, so a range key `FilterContext`
  fails to copy over is dropped the first time a filter changes.
- **`useApi.js`'s `QUANT_MS`/`WARM_GRACE_MS` must still equal the server's.** They are what let
  every session's request land on the same cache key and hit the server's cache warmer.
- **`UserDrawer` is deliberately outside auto-refresh:** it calls `apiGet` directly with
  un-quantised bounds and is a transient drill-down, not a page that should keep polling.
