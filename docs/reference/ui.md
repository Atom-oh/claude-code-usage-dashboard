# UI Components and Display Contracts

The UI uses Tailwind utilities and shared React components. Product labels remain primarily
Korean; this documentation describes their meaning in English and identifies the responsible
symbols. See [frontend state](frontend.md) and [web/AGENTS.md](../../dashboard/web/AGENTS.md).

| Source | Contract |
|---|---|
| [Card.jsx](../../dashboard/web/src/components/Card.jsx) | Card shell, help, header actions, loading/error states |
| [StatTile.jsx](../../dashboard/web/src/components/StatTile.jsx) | KPI label, value, hint and variant |
| [Badge.jsx](../../dashboard/web/src/components/Badge.jsx) | Positive, negative or neutral status |
| [SegmentedControl.jsx](../../dashboard/web/src/components/SegmentedControl.jsx) | Local group/interval selection |
| [DataTable.jsx](../../dashboard/web/src/components/DataTable.jsx) | Column rendering, sorting, row actions and optional CSV |
| [GroupCharts.jsx](../../dashboard/web/src/components/GroupCharts.jsx) | Group lines/areas/bars, series bars, donuts, paired panels and ranked lists |
| [PageHeader.jsx](../../dashboard/web/src/components/PageHeader.jsx), [RangePicker.jsx](../../dashboard/web/src/components/RangePicker.jsx) | Page context, freshness and date selection |
| [colors.js](../../dashboard/web/src/colors.js), [useChartColors.js](../../dashboard/web/src/useChartColors.js), [index.css](../../dashboard/web/src/index.css) | Channel/model colors and CSS-variable theme values |
| [labels.js](../../dashboard/web/src/labels.js) | `effortLabel`, `unclassifiedLabel`, `decisionLabel` display mappings |

## Spend formatting

Use [spend.js](../../dashboard/web/src/spend.js) before aggregating display spend.
`asSpendRow` selects `reported_cost` and `prev_reported_cost`, preserves server values as
`computed_cost` and `prev_computed_cost`, and marks unusable reports with
`reported_unpriced`. Missing, blank, negative or nonfinite reports are unusable; zero with
positive tokens is also unpriced at this consumer. Zero without token evidence remains
valid. `sumSpend` returns null if any supplied amount is invalid; an empty input sums to zero.

The page-local `usd` formatters must receive a valid zero as `$0`, not a missing-data state.
An unpriced row is handled before formatting. Positive API aggregates cannot reveal all
missing underlying reports, so a displayed amount is not evidence of complete collection.

`DonutBody` and `DonutBreakdown` accept `valueFormatter`, which **replaces** default
formatting, including `valuePrefix`. Cost supplies its own USD formatter so large totals
and legend values retain cents. Without an override, the default dollar formatter keeps
two decimals below $10 and rounds larger values. `DonutBody` shows an empty state when
the total is nonpositive; this is distinct from `usd(0)`'s valid formatting.

`SeriesBarChart` suppresses the entire chart if any supplied value is missing or nonfinite,
showing affected entries instead of silently drawing a partial total. This guard is
component-specific; it is not a guarantee shared by every chart.

## Tables and CSV

`DataTable` sorts using raw column values with numeric-aware string comparison; null and
empty values sort last. An `exportName` adds a CSV button. It exports the current `columns`
and `sortedRows`, so hidden computed columns stay out until the comparison option enables
them. This is a table export, not a separate all-data endpoint.

[csv.js](../../dashboard/web/src/csv.js) uses column labels for headers and `toText(value,row)`
when supplied; otherwise it exports the raw field. It does **not** scrape rendered JSX.
Provide `toText` when badges or derived cells need a textual equivalent. CSV uses a UTF-8 BOM,
CRLF rows and standard quote escaping.

When masking is enabled, `toCsv` centrally applies `maskEmail` to the `user` column after
`toText`, preventing custom formatters from bypassing that display policy. It is not a
general PII scanner for every column. [fmt.js](../../dashboard/web/src/fmt.js) holds the
shared masking state and UTC timestamp parsing. See [security](security.md) for the raw
API-data boundary.
