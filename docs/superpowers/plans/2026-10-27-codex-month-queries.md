# Codex monthly query implementation plan

**Goal:** Reduce Codex monthly query work without changing ClickHouse, collection, storage, response semantics, or query deadlines.

**Architecture:** For a verified diagnostic interval, the effort profile reads finalized existing diagnostic identity states for intermediate stream events. The raw branch retains every other event, including prompt lengths, completion token strings and exact anonymous timestamps. Model-session evidence includes all existing diagnostic events before backend filtering. Diagnostic profiles aggregate only their consumed operation families. An ordered, bound rate catalog selects rates before evaluating one token pricing expression.

**Evidence:** Recent application reader queries use the raw effort source and hit the existing 25-second deadline. The cost fact and diagnostic cutovers are already configured. A fresh live monthly baseline was rejected by automatic approval review; historical query statistics are the baseline until a bounded post-change measurement is approved. The first hybrid candidate's metadata-only EXPLAIN exceeded a 10-second limit. After reducing repeated token pricing expressions from 154 to one, EXPLAIN completed in 2.196 seconds, including client transport. This is planning evidence, not end-to-end monthly latency.

## Constraints

- No DDL, new database, storage migration, collection changes, hardware changes or deadline increases.
- Keep canonical full-identity deduplication, pricing tiers, partial coverage and unknown values.
- Require the existing verified diagnostic cutover for the entire SQL interval.
- Preserve raw fallback for unverified intervals; database errors remain errors.
- Preserve full event coverage and independent family result limits.
- Preserve authentication, route caching and query admission.

## Tasks

- [x] Add failing SQL shape and isolated ClickHouse parity tests for the hybrid effort source.
- [x] Add selection options for early canonical bulk exclusion and diagnostic model evidence.
- [x] Assemble raw non-bulk and finalized diagnostic bulk rows before the existing aggregate pipeline.
- [x] Narrow tools/performance operation families without narrowing event coverage.
- [x] Select bound rates once while preserving backend priority, tier boundaries and Claude fallback.
- [x] Run approved query regression tests, including duplicate maps, anonymous scopes, prompts, token encodings and filters.
- [x] Check the candidate plan using bounded, metadata-only EXPLAIN.
- [ ] Measure the live monthly candidate only after explicit bounded-load approval; report measured and unmeasured outcomes separately.
- [ ] Obtain required independent latest-HEAD review, apply real findings, and follow existing release authorization.

## Owners

- Query selection: `dashboard/server/codexInsightsLogs.js`, `codexDiagnosticSource.js`.
- Aggregate composition: `dashboard/server/codexLogAggregates.js`.
- Rate catalog: `dashboard/server/codexLogPricing.js`.
- Regression coverage: `codexLogAggregates.test.js`, `codexDiagnosticSource.test.js`, `codexEffortSql.test.js`, `codexLogPricing.test.js`, existing `codexLogCompaction.test.js`.
- Operational explanation: `docs/reference/cost-query-performance.md`.

## Verification before PR

- Server: 701 passed, zero failed; seven opt-in/environment-dependent tests skipped.
- Isolated ClickHouse 24.8: existing compaction fixture 17 passed, hybrid effort fixture five passed, pricing matrix fixture three passed.
- New hybrid/pricing fixtures are invoked by `scripts/test-client-sql.sh` in CI.
- No live monthly latency claim or schema rollout is established by these checks.
