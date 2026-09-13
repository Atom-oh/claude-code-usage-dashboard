# ADR-003: Include StartTimeUnix in the counter SeriesKey

- Status: Accepted
- Date: 2026-09-02
- Reconciled: 2026-09-13

## Historical evidence

The 2026-09-02 investigation recorded zero negative `Value` steps within a `StartTimeUnix`
segment and 334 across 399 segment switches. For 14 days of `cost.usage`, 155 of 1,030
`(SessionId, SeriesKey)` pairs (15.05%) had multiple start times. The seven-day per-metric
negative-step counts were:

| Metric | Within segment | Across segments |
|---|---:|---:|
| `token.usage` | 0 | 370 |
| `lines_of_code` | 0 | 46 |
| `active_time` | 0 | 97 |
| `commit` | 0 | 15 |
| `pull_request` | 0 | 2 |
| `code_edit_tool.decision` | 0 | 58 |
| `session.count` | 0 | 0 |

The sample also showed a roughly 572K-token context being cached again (571,705 then
572,938 cache-creation tokens). Together, these observations supported a fresh process
counter rather than simple re-export of one continuing counter. They support this decision
for the observed data; they are not proof that every future reset or telemetry defect has
been identified.

The legacy `cityHash64(toString(Attributes))` key merged counter segments with the same
labels. A resumed session could retain `session.id` while its cumulative counters restarted;
max/difference aggregation then discarded post-reset increments until the old high-water
mark was exceeded.

## Decision

Use the process start as part of the counter key, except for the session-count metric:

```sql
if(MetricName = 'claude_code.session.count',
   cityHash64(toString(Attributes)),
   cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix)))
```

`StartTimeUnix` is `DateTime64(9)`; the nanosecond integer retains its precision. Keep the
expression aligned in [migration 003](../../clickhouse-migration-003.sql),
[reference schema](../../clickhouse-schema.sql),
[replicated schema](../../infra/files/clickhouse-schema-replicated.sql), and
[backfill helper](../../scripts/backfill-hourly-rollup.sh). Queries read the stored key;
the backfill helper explicitly computes it so raw materialization progress does not affect
backfill keys.

Rebuild the hourly rollup through a shadow table and `EXCHANGE TABLES`. The rebuild also
includes `StartType` and `AppVersion` in the intended sorting key; migration 002 had added
them as columns on existing tables without that key change. Folding the segment into an
existing query key avoids adding a separate dimension to every consumer. It does not mean
the physical rollup's old and rebuilt definitions are identical.

## Rationale and alternatives

- Keep `session.count` keyed by labels: the session KPI is not a process count. In the
  historical 30-day comparison, 441 distinct session IDs produced a legacy KPI of 455;
  an unconditional segment key would have produced 684, roughly 50% above that KPI.
- A separate `SegmentStart` column in shared grouping keys would broaden every consumer's
  contract, the risk documented by [ADR-001](ADR-001-local-diff-over-shared-incflat-extension.md).
- Value-drop detection alone loses resets that drop and recover within one hourly bucket.
  The observed start timestamp supplied information already lost by bucket-level maxima.
- In-place delete/reinsert would create a visible history gap and would not itself resolve
  the desired sorting-key change. The shadow table permits verification before exchange.

## Consequences and deployment boundary

Historical 30-day recalculations recovered these increments:

| Quantity | Legacy key | Segment key | Recorded change |
|---|---:|---:|---:|
| Reported cost counter | $24,394 | $27,492 | +12.7% |
| Tokens | 34.12B | 39.29B | +15.16% |
| Lines of code | 590,891 | 642,057 | +8.66% |
| Active time | 4,360,270 s | 4,715,018 s | +8.14% |

These are dated telemetry comparisons, not invoices or expected changes for another dataset.
The session-count key is intentionally unchanged. `uniqExact(SeriesKey)` now measures
segments for other metrics; use the attributes-only hash when investigating label cardinality.

During cutover, **both raw data and the old live rollup can mix legacy and segment keys**.
Raw materialization completes separately from the shadow backfill/exchange. After forward
exchange, the live-named rollup uses the `_hourly_v2` Keeper path and the old table is retained
for the rollback window. Those are intended outcomes, not assertions that a live cluster
has completed the procedure.

Use the [rollup rebuild runbook](../runbooks/rollup-rebuild-segment-key.md) for ordering,
late arrivals, overlapping delta backfills, all-replica checks, rollback limits, and cleanup.
The [schema runbook](../runbooks/schema-migrations.md) distinguishes ledger evidence from
recent-row probes. Neither this accepted ADR nor SQL file presence proves deployment.
