# Usage and reliability read paths

## Goal and evidence

Reduce the 30-day shared Usage and Reliability page latency within the existing
hardware. Preserve every displayed measure, scope rule, missing-data state and
authorization boundary.

Both pages request the full client overview. Its Codex branch still scans raw
logs even when the verified typed cost tables cover the range. Both pages also
request all Codex diagnostic sources although each displays only one section.
Recent production query logs show expensive raw-log and trace reads. Those logs
do not identify individual browser navigation timings.

## Design

- Use the existing verified `CODEX_COST_READ_FROM` boundary for both cost and
  full Codex overview queries. Retain raw fallback and Claude's existing source.
- Keep explicit event identity deduplication. For full views only, recover log
  attributes from the retained identity tuple after grouping. Scope rows carry
  an empty typed map. No schema migration or historical data rewrite is needed.
- Preserve full-view context tiers, tool names, errors, duration validity,
  rejection counts, token subsets, model/session matching and coverage.
- Add validated `tools` and `performance` insights profiles. Include the
  normalized profile in cache identity. Keep default and effort behavior.
- Tools request logs only. Performance requests its displayed log and metric
  families, preserving cumulative baselines and all metric storage types.
  Omitted sources are not requested, rather than observed zero.
- Real-data evidence ruled out query compaction alone: diagnostic profiles still
  read every stream duration and exceed the application deadline. Add migration
  008 with second-grain exact identity aggregate states and compact diagnostic
  attributes. Preserve weighted latency, rates and all-event coverage.
- Select states only for tools/performance ranges wholly covered by an explicit
  verified `CODEX_DIAGNOSTIC_READ_FROM`. Keep raw fallback and default/effort.
  Backfill is bounded, repeatable and independent of schema installation.

## Plan

- [x] Trace both routes, SQL sources, diagnostic consumers and cache behavior.
- [x] Independently review facts reuse against the schema and raw query.
- [x] Add failing source-selection and full SQL/fold parity regressions.
- [x] Implement typed full overview and targeted diagnostic profiles.
- [x] Run focused and package tests; build the frontend.
- [x] Compare real closed-window full-view results and bounded query timings.
- [x] Implement and prove diagnostic state parity in native ClickHouse.
- [ ] Backfill and measure diagnostic profiles within existing reader limits.
- [x] Complete independent latest-change review; fix findings.
- [ ] Commit, push, open PR, resolve required AI/CI feedback, merge and deploy.
- [ ] Check the deployed revision and runtime behavior.

The separate actual-data S3 experiment remains a comparison only. It does not
change production storage. Finish its CPU-sensitive timed runs before running
local tests or builds.
