# Historical PR #9 review-response plan

- Historical reference: review round 12, commit `6d1bf0f`
- Original plan date: not recorded in this file
- Reconciled against current source: 2026-09-13
- Status: Archived, non-normative planning record

This was a proposed response to review findings, not a list of work still authorized or
required today. The reference commit identifies the historical review; unchecked tasks in
the earlier draft did not establish current defects or incomplete implementation. Root and
scoped AGENTS guidance, current code/tests, and operational runbooks govern new work.

## Original concerns and current evidence

| Historical concern and intended response | Current source evidence |
|---|---|
| `costByModelCompare()` used a different comparison window from sibling cost cards. Add a raw short-range path and raw baseline stitching for longer ranges. | [queries.js](../../../dashboard/server/queries.js) branches on `incFlatRaw(to - from)` (up to four hours), and longer-range SQL carries current/previous raw baseline stitches plus aligned previous bounds. This does not guarantee equality for all grains/windows. |
| `incBucketed()` dropped the first partial bucket, with a reported roughly 1.58% snapshot/timeseries difference. Add raw first-bucket correction while preserving aggregation/window/filter ordering. | The helper now unions first-bucket raw baseline/delta values and filters from the bucket start. [queries.test.js](../../../dashboard/server/queries.test.js) checks the first-bucket filter contract. The historical percentage is not a current expected error. |
| Distinct-user/presence queries could include activity before a non-hour-aligned start. Choose precision fixes or documented approximation per metric. | `activeUsers()` now uses raw session-count rows for ranges up to four hours. Longer-range and rolling adoption/heatmap/active-day measures retain their own hourly/day semantics; see the [API reference](../../api-reference.md). The plan's single shared-window description is not universal. |
| A review claimed the backfill script was absent. Verify the tracked file rather than inventing a replacement. | [scripts/backfill-hourly-rollup.sh](../../../scripts/backfill-hourly-rollup.sh) exists. A missing diff excerpt is not proof of a missing file. The draft's proposal for a scaffold-only existence test is not a standing requirement. |
| Executive custom zoom could describe a short interval as a whole day. Use actual duration labels. | [Executive.jsx](../../../dashboard/web/src/pages/Executive.jsx) derives duration from `to - from`, formats sub-day boundaries, and uses `formatDuration`. Existing Korean UI text is not translated by this record. |
| Cost chart interval did not always reset when a custom range changed without changing the default resolution. Include range identity in effect dependencies. | [Cost.jsx](../../../dashboard/web/src/pages/Cost.jsx) includes `from.getTime()` and `to.getTime()` along with the default interval and days. |

The original plan proposed a multi-agent decision gate and a rebuttal comment for the false
missing-file finding. Those were workflow intentions, not evidence that a panel ran, a
comment was posted, or a PR was merged. They do not require new model calls or comments.

## Historical validation plan

The draft called for server tests, a web build, and direct ClickHouse comparisons on
non-hour-aligned windows. The portable local commands are:

```bash
(cd dashboard/server && node --test *.test.js)
(cd dashboard/web && npm run build)
```

These commands were not executed as part of translating this record. Current code and test
presence show the implementation shape, not results of a fresh live comparison. Any renewed
investigation must match filters, unknown-channel inclusion, cost basis, baseline lookback,
and effective range/rollup alignment before comparing totals. Passing static/unit tests
cannot prove exact live equality across all consumers.

For operational migration/backfill work, use the
[rollup runbook](../../runbooks/rollup-rebuild-segment-key.md), including its actual range,
late-arrival, and delta-overlap limitations. Do not execute destructive data work from this
archived plan or treat source SQL as evidence of a completed deployment.
