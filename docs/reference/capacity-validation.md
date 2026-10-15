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
  preserve population before concurrent requests are admitted.
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
