# Changelog

Notable changes follow the categories of Keep a Changelog and Semantic Versioning.
All changes recorded here are under **Unreleased**. Entries describe changes at their
recorded dates, not proof that infrastructure or migrations are deployed. Later entries
supersede earlier behavior; current contracts live in [AGENTS.md](AGENTS.md), the
[API reference](docs/api-reference.md) and [metrics glossary](docs/metrics.md).

In particular, the September 10-11 reported-spend changes supersede earlier computed-primary
UI behavior and billing-lower-bound wording. Neither reported nor computed estimates are
invoices, guaranteed billing bounds or evidence of complete telemetry.

## [Unreleased]

### Changed (2026-09-13 documentation and review context)

- Establish concise English documentation, canonical root/scoped AGENTS instructions and
  adjacent CLAUDE bridges under the [documentation policy](docs/documentation-policy.md)
  and [ADR-010](docs/decisions/ADR-010-english-documentation-and-review-context.md).
- Reconcile architecture, API, metrics, operational references and dated history against
  current code. Preserve runtime UI localization; change no runtime calculations, SQL,
  pricing, counter aggregation or productivity formula as part of this reconciliation.
- Supply bounded, trusted base-revision context to PR review, distinguishing existing
  conventions from the proposed diff. No-tools restrictions, coverage checks, severity gates
  and latest-HEAD review remain required.

### Changed (2026-09-11 cost display basis)

- Show reported amounts by default on Cost. Computed totals, token-tier charts, comparison
  columns and effort annotations require the `showComputed` opt-in.
- Preserve cents in monetary Cost donuts, matching the summary formatter. Comparison mode
  retains original computed values; it does not allocate reports by estimated tier shares.

### Fixed (2026-09-10 reported spend and cache TTL)

- Use existing client-reported spend in Cost, Executive, Productivity, Users and their CSV
  views; base `costEfficiency.js` ratios `cost_per_loc` and `cost_per_commit` on reports.
- Treat zero reports with positive tokens as unpriced at those consumers. Retain computed
  TTL/price diagnostics, including valid reports for models without a server rate.
- Preserve SQL, `TOKEN_SUMS`, pricing, rollup aggregation and the productivity formula.
  Positive aggregates do not establish complete underlying reports.
- Keep long token/currency values readable on mobile and avoid rendering unavailable
  amounts as zero in A/B comparisons or stacked charts.

### Added (2026-09-04 auto-refresh + range presets)

- Add selectable refresh intervals: off, 15 seconds, 30 seconds, one minute and five minutes,
  defaulting to one minute. Persist `ccdash.refreshMs`, pause hidden tabs, skip one tick after
  failure and provide manual refresh. Same-parameter refreshes retain visible data; the
  original unconditional no-loading claim does not cover a changed quantized request range.
  See [RefreshContext.jsx](dashboard/web/src/RefreshContext.jsx) and
  [useApi.js](dashboard/web/src/useApi.js).
- Add 1/2/7/30-day presets, plus a distinct server `defaultRangeDays` when needed, current UTC
  month (`period=month`) and a calendar range picker capped by `rangeCapDays`.
- Make old `days=14` and `days=90` links fall back to the server default, like other unsupported
  presets. The server-configured default can itself remain an allowed preset.

### Changed (2026-09-04 effort/agent cost basis)

- At this date, change Effort/Agent panels to computed-primary cost, with reports secondary.
  Replace reported-only `cost_usd` responses from `/api/cost/effort-mix` and `/api/cost/by-agent`
  with `cost`, `reported_cost`, `tokens`, `unpriced_tokens`. The September 3 investigation
  recorded `claude-fable-5-1` reports around half the configured list estimate on client
  2.1.251 (using the opus-5 rate), near list on 2.1.258, and a `claude-fable-5` control ratio
  near one. These are dated observations, not billing facts. **The display choice was
  superseded September 10-11; the computed API fields remain diagnostic.**
- Add unit-tested `rollupComputedCost` to [pricing.js](dashboard/server/pricing.js): apply
  `withComputedCost` at model grain before folding into effort/agent keys. This keeps the
  existing JavaScript price lookup model-specific before aggregation removes that dimension.

### Changed (2026-09-04 UI copy)

- Revise SPA labels, titles and subtitles in Korean, moving formulas, telemetry identifiers,
  enums and methodology into help text or removing duplicate detail. Standardize the concepts
  of cost, channel, user, added lines, unclassified, unspecified effort, missing rate and error.
  This runtime-language decision is separate from English-only engineering documentation.
- Add optional `Card.help`, using the Info affordance also used by StatTile; forward it through
  DataTable and Card-wrapping GroupCharts so page methodology has a consistent location.
- Add [labels.js](dashboard/web/src/labels.js) with `effortLabel`, `unclassifiedLabel` and
  `decisionLabel`, pairing known-value render mappings with `toText` for CSV. Reliability
  adopts the shared effort helper. These mappings do not translate every unknown enum value.
- Remove the historical `LowerBoundNote` component and its schema-driven callout. At that
  date its lower-bound wording moved into Executive period-cost and Cost total-cost help.
  **That wording is superseded by September 10-11 and the current estimate policy above.**
  `schema.segmentAwareSeriesKey` no longer drives the callout; corresponding runbook steps
  promising automatic callout updates were removed.
- Rename the user-cost checkbox to the UI equivalent of "include unclassified," replacing
  its raw unknown-group wording. Update the three tests pinning that label without changing
  their assertions' meaning.

### Added (2026-09-03 production decisions)

- Add outbound staleness alerts in [alerting.js](dashboard/server/alerting.js): a pure planner
  with two-tick debounce, repeat interval and recovery message, configured by
  `ALERT_WEBHOOK_URL`/`ALERT_REPEAT_MINUTES`; keep the URL in a Secret and out of logs.
- Add Terraform `alert_webhook_url` (sensitive/nullable), `alert_repeat_minutes`, optional
  `alert_email`-gated CloudFront `5xxErrorRate` alarm/SNS email and `alert_topic_arn` output.
  Optional alert resources are absent when their enabling variables are null.
- Add the [alerting runbook](docs/runbooks/alerting.md), covering both alert paths, enabling
  them, three message types, responses and why two replicas can send duplicate notifications.
- Add ADR-004: Basic Auth baseline, edge-side SSO upgrade path and no self sign-up.
- Add ADR-005: outbound freshness webhook and edge 5xx alarm, including the uncovered
  backup-CronJob failure case.
- Add ADR-006: client-side email masking baseline; record and defer server-side pseudonyms.
- Add ADR-007: Korean-first UI, with i18n deferred to a string table. ADR-010 later supersedes
  its bilingual documentation rule only.
- Add proprietary, all-rights-reserved `LICENSE` and `"license":"UNLICENSED"` to both
  application package manifests.

### Fixed (2026-09-03 production decisions)

- Hide the bedrock/enterprise control in FilterBar for `GROUP_MODE=single`; an explicit
  `group` URL parameter still applies server-side.
- Fix UserDrawer's transparent background by replacing nonexistent `bg-page` with `bg-paper`
  (recorded commit `d761cba`).
- Correct the architecture's translated rollup-retention description: 180-day delete-only
  TTL, not a 90-day cold move (recorded commit `6454c01`).

### Added (2026-09-03 mobile nav, CSV export, schema ledger, org onboarding)

- Add mobile navigation below `lg` (1024px): top bar and slide-over drawer share Sidebar's
  `NAV` table through [MobileNav.jsx](dashboard/web/src/components/MobileNav.jsx).
- Add opt-in client CSV export across Overview, Users, Reliability, Cost, Usage and
  Productivity. Export supplied table columns in current sort order; use `toText` or raw
  fields, not JSX scraping, and honor central masking of the `user` column.
- Add `claude_code.schema_migrations` through migration 004, including evidence-based
  backfill for 002/003; mirror it in both schema copies and expose `schema.migrations` in config.
- Add schema-migration and backup/restore runbooks: migration headers and verification,
  recorded RPO/retention, explicitly unmeasured RTO and quarterly restore-drill guidance.
- Add [deployment for another organization](docs/deploying-for-your-org.md), reusing the
  repository's operational commands.
- Expose `group_mode`, `default_range_days`, `range_cap_days` in Terraform with validation
  matching server boot rules. Applying changed environment entries can roll the Deployment;
  source changes alone are not rollout evidence.

### Changed (2026-09-02 data correctness)

- Add process-start time to metric `SeriesKey` through migration 003/ADR-003, preserving the
  `session.count` exception, and expose the runtime probe as `schema.segmentAwareSeriesKey`.
- Correct the built-in price table and add `PRICING_JSON`/`PRICING_CACHE_WRITE_TTL` overrides.
  Prices remain configured diagnostic estimates, not proof of current contract rates.
- Merge normalized model variants into user/channel/model rows, removing duplicate spend
  rows caused by differing model-ID forms.

### Added (2026-09-02 observability and resilience)

- Add the raw-data freshness probe and `/api/health/data`, returning `ok`, `stale` or `unknown`
  and HTTP 503 for the latter two.
- Add `/readyz` separately from always-200 `/healthz`, plus SIGTERM draining. Readiness can
  fail on open connections; closing the listener can refuse new ones. This does not guarantee
  that every in-flight request receives a not-ready response.
- Add the SPA freshness banner backed by that health endpoint.

### Changed (2026-09-02 security and request validation)

- Fail startup without both Basic Auth credentials unless `AUTH_ALLOW_INSECURE=1` explicitly
  permits local unauthenticated use.
- Return 400 for invalid `from`, `to` or `intervalHours` before a wrapped data query runs.
- Replace underlying ClickHouse/SQL exception text in 500 bodies with an opaque error ID.
- Probe and gate the chat session's readonly setting before allowing `/api/chat` execution.
- Protect the collector-account password from shell tracing in `user-data.sh`.
- Add CloudFront security headers and scope collector credentials to INSERT plus the SELECT
  privileges required by the materialized view.

### Changed (2026-09-01 infrastructure resilience)

- Add dashboard readiness/draining settings, preferred anti-affinity and a disruption budget.
- Declare immutable ECR tags and commit the Terraform provider lockfile.
- Add a backend configuration template and a bounded schema-init Job with
  `wait_for_completion` gating. These declarations do not certify a live rollout.

### Changed (2026-08-31 build and CI reproducibility)

- Require committed lockfiles and use `npm ci` for server/web installation.
- Pin the container base image by digest; add HEALTHCHECK and package engine floors.
- Add CI for server tests, web build, harness checks and Terraform formatting/validation on
  main/feature pushes and PRs. Missing gitignored `.claude/` tooling is an expected harness
  skip. Current CI also runs web tests.
- Add a web-build smoke test.

### Added (2026-09-03 adoptability)

- Add boot-validated runtime `GROUP_MODE`, `DEFAULT_RANGE_DAYS`, `RANGE_CAP_DAYS`, exposed
  through `/api/config`.
- Add single-channel presentation so an organization does not require a permanently empty
  second A/B card; this does not change query populations.
- Add range/group/user/model URL permalinks. Omit user filters when masking is on, including
  values arriving in pasted links; cover the behavior in `permalink.test.jsx`.
- Add shared empty states for no known telemetry versus no data in the selected range,
  integrated with charts, tables and Executive sections.
- Add [metrics definitions](docs/metrics.md), with help affordances and README navigation.
- Add the local Compose database/dashboard stack with schema-before-seed initialization.
- Add `infra/terraform.tfvars.example` and require explicit cluster/domain/hostname inputs
  rather than silently defaulting to a particular deployment.
- Add the collector's bounded on-disk `file_storage` queue through `OTELCOL_QUEUE_DIR`,
  preserving queued batches across restarts and longer outages within queue capacity.

### Added (2026-08-11 telemetry spec sync)

- Add cost/token attribution dimensions for effort, agent, plugin, marketplace, MCP server/tool,
  speed, start type and source, plus EndUserId and AppVersion from resource attributes.
  The original notes called the version key `app.version`; the source key is `service.version`.
  The work used a telemetry attribute census rather than relying only on public documentation.
- Add beta `otel_traces` and permission-wait/TTFT panels, alongside a log-based subagent-fanout
  panel that does not itself require traces.
- Add skill activation, compaction, refusal, exhausted-retry and plugin-inventory panels from
  log events, plus version-cohort integrity checks for channel comparisons.
- Add migration 002 using additive `ADD COLUMN IF NOT EXISTS` operations without table drops.

### Changed (2026-08-11)

- Record exclusion of `agents_view` (the agents dashboard process) from session panels.
  The original entry described this as universal; current queries do not universally enforce
  it, so consumers must check the specific query rather than treat this history as a guarantee.
- Introduce EndUserId fallback when email is absent. Its current scope is query-specific,
  not a universal retrofit of user measures; see [ADR-002](docs/decisions/ADR-002-bedrock-identity-fallback.md).

### Fixed (2026-08-11)

- Fix empty tool/MCP Panel 8 results by matching bare `EventName='tool_result'`, rather than
  the prefixed `claude_code.tool_result`.

### Added

- Add the initial Claude Code telemetry pipeline, dashboard and EKS workload infrastructure.
- Add adoption/engagement panels and per-user/model cost breakdowns.
- Add cost-efficiency tables, adoption activity series and token-tier donuts; split input
  and output token totals on Overview.
- Add the dashboard favicon.
- Add shared group/user/model filter controls and hour/day/week chart resolution selection;
  actual filter application remains endpoint-specific.
- Add Analytics and preset prompts for the Ask Claude assistant.

### Changed

- Redesign the dashboard using the awsops cobalt visual system.
- Move channel inference from user to session grain so a user's sessions on different auth
  paths are not all assigned to one channel.
- Normalize Bedrock region/date/version model variants into shared usage/cost rows.

### Fixed

- Correct cumulative-counter double counting and introduce token-priced computed costs in
  place of reports at that time. **The computed-primary display was later superseded by the
  September 10-11 entries; the diagnostic calculation remains.**
- Fix infrastructure issues recorded during a Terraform apply; this entry is historical,
  not a claim that the current configuration has been applied.
- Correct LOC efficiency denominators to use added lines, and stop unknown-price-only users
  appearing falsely efficient at `$0/LOC`. The later reported-cost policy now permits valid
  reports without server rates and marks missing reports separately.

[Unreleased]: https://github.com/Atom-oh/claude-code-usage-dashboard/compare/9442d29...HEAD
