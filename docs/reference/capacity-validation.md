# Synthetic capacity validation

[benchmark-capacity.py](../../scripts/benchmark-capacity.py) owns the isolated
HTTP/SQL workload; [capacity-proxy.mjs](../../scripts/capacity-proxy.mjs) supplies
private transport. These measurements contribute to
[product acceptance](../product-readiness.md), not commercial-release approval.

## Run

Use an ARM64 host with Docker and enough existing capacity for the full envelope.
The script requires an already-present registry digest or immutable local image ID. It does not
pull customer data, use caller database URLs, invoke models or change AWS resources.

```bash
python3 scripts/benchmark-capacity.py \
  --dashboard-image "$DASHBOARD_IMAGE_DIGEST" \
  --users 140 --requests-per-user 720 --resource-bytes 2048 \
  --report /tmp/capacity-observations.json
```

The report must be new. Reports, generated Basic/reader credentials and diagnostics
are private; keep them outside version control. Docker resources have a unique
ownership label and cleanup deletes only resources bearing that label.
All containers use an internal network. The host connects directly to its owned
private transport; there are no published ports or ambient HTTP proxies.
No production credentials are consumed and authentication remains enabled.

`--fixture-user-projection` adds and materializes a six-column projection only on
owned synthetic log tables. It preserves timestamps, full resource/log attributes,
event names and promoted identities, ordered by resolved user/event/time.
The report records this option. It is not a production migration, materialization
proof, retention/backup validation or deployment approval. Inspect actual projection
selection through query-log/plan evidence when interpreting it.

To exercise the product's actual bounded GET retry policy alone, add
`--scenario product_retry`. This imports the frontend fetch module and records
initial admission failures, all HTTP attempts and final per-user outcomes.
It does not redefine rejected attempts as immediate successes.

## Workload and checks

- Three independent ClickHouse 24.8 copies, each limited to 3.5 CPUs and 13 GiB.
  The reader has readonly, execution, memory, result-byte and read-row bounds.
- Two actual dashboard processes, each limited to 0.5 CPU and 256 MiB.
  Record the image's actual ARM64 architecture and application revision.
- A closed previous UTC day, synthetic identities and both coding clients.
  Defaults produce 1,008,000 Codex log events per database, including complete usage
  and intermediate streams; Claude counters span four days at 30-second cadence.
  Cumulative values are increments with a real prior boundary, never summed exports.
  Codex diagnostic series retain unit, full identity and process-start boundaries.
- Cost views request ten-minute buckets. Each distinct exact-user baseline must
  match both client rows from the shared baseline, including amounts and coverage,
  before concurrent requests are admitted. Empty filtered responses fail validation.
- Shared cold/warm requests and distinct cold/follow-up requests use simultaneous barriers.
  Distinct follow-up does not guarantee every key is warm on every replica: rejected
  work and load-balancer redistribution can still cause cache misses.
  Successful responses must match their semantic baselines, ignoring incidental
  row order and float noise while preserving null, zero, tiny values and population.
- Record status counts, p50/p95/max latency, coded admission rejections, unexpected
  responses, running-state/OOM/restarts and container CPU/memory samples.
  `completed` means the experiment ended, not that all users succeeded.

## Limits

The synthetic fixture is not evidence that customer data has the same distribution.
HTTP-cold runs restart API caches; they do not flush database/storage caches.
Independent database copies omit Keeper, replication and network overhead.
Basic authentication omits real customer OIDC, cookies and browser rendering.
The cost endpoint/drilldown workload does not cover every product page, assistant,
ongoing ingestion or a complete customer installation.

Valid `capacity_exhausted` responses demonstrate bounded admission, not capacity for
every arrival. A success rate below the requested population or an OOM is an unresolved
fleet limit. Do not infer a production SLO, continuous 140-user capacity, restore RTO,
complete telemetry or employee productivity from this experiment.
Use [query performance](cost-query-performance.md#capacity-validation) and the private
customer workload/acceptance packet for further evidence.

## Recorded experiment: 2026-10-15

The private reports used 140 distinct exact users, ten-minute cost buckets,
1,008,000 log events and 17,137,400 total rows per database. Every successful
response matched its sequential semantic baseline. These are individual
synthetic trials, with the resource envelope above:

| Candidate and scenario | Final 200 / coded 503 | Initial 503 | HTTP attempts | p95 |
|---|---:|---:|---:|---:|
| Bounded frontend retry, no projection | 118 / 22 | 40 | 242 | 29.0 s |
| Retry plus private query cancellation, no projection | 127 / 13 | 38 | 226 | 42.3 s |
| Promoted-user PREWHERE plus synthetic projection, retry and cancellation | 140 / 0 | 39 | 186 | 8.0 s |

No trial observed a container OOM or automatic restart. API containers were
intentionally restarted to clear their caches. Product-retry resource samples
were added after these trials; their reports prove recorded running/OOM/restart
state, not peak resource usage. Do not infer a cancellation-only speedup from
the slower second trial. The projection result combines multiple changes and
still includes admission/retry delay. The projection is not installed in production.

Separate sequential SQL measurements retained identical 144-row fingerprints.
Promoted-user PREWHERE reduced logical read bytes from about 4.64 GB to 3.62 GB.
A six-column projection actually selected by ClickHouse reduced those bytes to
41 MB and read rows from 2,016,000 to 17,824. These single-user query-log values
are not concurrent fleet measurements or ingestion/merge/restore evidence.

A subsequent full-scenario repetition with resource sampling returned 140/140
shared and follow-up successes, but 100/140 successes plus 40 coded 503s for bare
distinct cold requests. Actual product retry returned 140/140 final successes,
39 initial 503s and 185 HTTP attempts, with p95 7.8 s. Sampled maxima during that
retry were about 1,276 MiB per database and 128 MiB per API process; samples do not
prove absolute peaks. All successful semantic comparisons passed, with no observed
OOM/automatic restart. The all-scenario success flag remained false because the
bare cold arrivals exceeded admission. This repetition preceded the stronger
shared-to-exact-user baseline check above.
