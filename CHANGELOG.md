# Changelog

Notable changes follow the categories of Keep a Changelog and Semantic Versioning.
Each version is an annotated `vX.Y.Z` Git tag described in the
[release runbook](docs/runbooks/releases.md); **Unreleased** holds changes merged since
the latest tag. The dashboard's `/changelog` page shows the user-facing subset of each
release. Entries describe changes at their recorded dates, not proof that infrastructure
or migrations are deployed. Later entries supersede earlier behavior; current contracts
live in [AGENTS.md](AGENTS.md), the [API reference](docs/api-reference.md) and
[metrics glossary](docs/metrics.md).

In particular, the September 10-11 reported-spend changes supersede earlier computed-primary
UI behavior and billing-lower-bound wording. Neither reported nor computed estimates are
invoices, guaranteed billing bounds or evidence of complete telemetry.

## [Unreleased]

## [1.8.0] - 2026-11-14

### Added

- The shared period picker accepts exact start/end dates and times, down to seconds,
  in the browser time zone. Shared links preserve that mode, including UTC-midnight
  boundaries; UTC calendar-day selection remains available. (#262)

### Changed

- Collector installation is one terminal command, `curl -fsSL <dashboard>/api/ingest/install.sh | sh`
  (Linux prefixes `sudo loginctl enable-linger`), instead of downloading the archive in the
  browser, moving it to the device and extracting it. The script prompts on the terminal
  for the attribution ID and device token, downloads the package from the new
  device-token route `GET /api/ingest/package/:platform` (ten per device per hour) and runs
  the installer with a private token file; the token stays out of process arguments. The
  page drops its download button; `/api/collector/package/:platform` remains for manual
  installs. Package token checks share the ingest gateway's eight in-flight slots; the
  runbook and security reference record the anonymous, credential-free bootstrap. (#260, #264)
- AI PR review no longer caps trusted context (24,000 and 20,000 bytes) or specialist
  instruction templates (22,000 bytes). A change touching several owner areas failed
  review on these policy budgets although every model call was far below its transport
  guards. Context now counts toward the remaining framed-request guards (below 640,000
  bytes for Codex/Claude, below 120,000 for Kiro), Claude's instruction argument and the
  legacy lens prompt argument (both below 120,000 bytes, under the measured 131,071-byte
  single-argument limit). `REVIEW_CONTEXT_CAP` and `role_review.py prepare --context-cap`
  are removed; an empty context reports `context_empty`. (#263)

### Fixed

- User detail stays open when the period changes. Its top-20 task list defaults to
  the overview's effective period and follows chart drag zoom; a point click still
  narrows it to one bucket, with a control to restore the full period. (#262)
- Unit-economics charts connect observations across unknown buckets with labelled
  dashed guides. Unknown values remain unavailable in tooltips and calculations. (#262)

## [1.7.0] - 2026-11-13

### Added

- The task detail shows the session environment of a Claude Code task: MCP servers by
  latest status (connected, failed) with their names, loaded plugins with their skill,
  agent and command counts, and the first call's input context. `/api/users/tasks/detail`
  adds `environment`, read from the session's `mcp_server_connection` and `plugin_loaded`
  events up to 14 days before the task. OTel carries no tool-definition count or size, so
  the card says so instead of estimating; Codex emits no such events and shows not
  collected. (#257)

## [1.6.1] - 2026-11-13

### Fixed

- Task detail lanes of the same subagent type (several `general-purpose` lanes, say) are
  numbered (`general-purpose #1`, `#2`, ...) and drawn in their own shade of the type's
  colour in the timeline, cost band, context chart and side panel, instead of sharing one
  name and colour that made separate lanes read as one. (#255)
- The task detail's context chart joins only a lane's main call source. Side requests in
  the same lane, such as a subagent's Haiku `agent_summary` with a much smaller context,
  are drawn as unconnected points instead of pulling the lane's line down to near zero. (#255)

## [1.6.0] - 2026-11-13

### Added

- The task detail's cost-explanation panel ends with a per-model summary (calls, known
  cost and share of the summed LLM-call costs, most expensive first), so a task with dozens
  of calls reads as "Haiku ×N, Sonnet ×M" without opening each bar. Unknown cost stays
  "not collected"; a partly known cost is marked as a partial sum, and the panel notes when
  unknown costs or Codex completions without a span are outside the share base. (#253)
- User task lists show each Claude Code task's workflow runs as badges; a badge narrows the
  list to that run (`workflowRunId`, Claude Code only) until the filter is cleared or the
  user, bucket, clients, group or backend changes. The
  task detail header names the task's workflow runs. A run without a valid name shows its
  run id. (#253)

### Changed

- Token-economics exemplar users chart each lever instead of listing it in a table: up to
  ten eligible users per lever (was three) are drawn against the eligible users' median,
  with the better direction always to the right. Rate levers (cache hit rate, small-model
  share) differ in percentage points, the others in percent of the median. Sessions, turns
  and commits stay on hover; the CSV keeps the median and adds the charted difference.
  The median still covers every eligible user, and the card remains a contact list, not a
  performance ranking. (#252)

### Fixed

- The task list's cost-descending sort failed with HTTP 500 for users with many calls: the
  request ids of the 100 candidate interactions (7,716 ids, 239 KB in one measured case)
  exceeded ClickHouse's 128 KiB HTTP form-field limit. Cost lookups for task lists and
  task details now run in chunks whose percent-encoded id list stays below 96 KiB. (#253)

## [1.5.1] - 2026-11-12

### Added

- Migration 010 adds `session_turns_v1`, exact per-session-hour turn/request key sets with an ingestion view, bounded backfill and a read-only raw-log comparison (`clickhouse-verify-010.sql`) that gates activation. Token economics (below) reads it; see [Session turns](docs/runbooks/schema-migrations.md#session-turns-migration-010) in the schema migrations runbook.
- Shared Productivity opens with token-economics sections from the new
  `GET /api/clients/token-economics`: the cost equation (users × sessions/user ×
  turns/session × requests/turn × tokens/request × cost/token, with change against the
  preceding window and matched-session coverage), an LMDI driver waterfall with
  growth/waste/price subtotals, unit-cost and request-efficiency trends, model economics,
  outcome cost (Claude Code only; Codex shows it as not collected) and exemplar users to contact about
  their habits. Requires migration 010, its verified backfill, a latency check and
  `SESSION_TURNS_READ_FROM` (Terraform, compose and `.env`); until then every section shows its
  unavailable reason, never zero. Each window is gated on its own: when only the preceding
  window is before the boundary or beyond log retention, the current sections stay and only
  the comparison and decomposition are unavailable. With both clients, a client without a
  decomposition is named and each client's own waterfall is shown instead of the combined one.
  Observed telemetry activity, not employee productivity, verified outcomes or ROI
  ([token economics](docs/metrics.md#token-economics)).
- Filter a user's task list by Claude Code workflow run with `workflowRunId` or
  `workflowName` on `/api/users/tasks` (`client=claude`); Claude tasks and task details
  list their `workflows` (run id and name). Device collectors now keep span
  `workflow.name` when it is a short label. Migration 011 adds
  `otel_traces.WorkflowRunId`/`WorkflowName` for direct queries; existing installations
  must apply it before schema-init verification passes. Only trace-enabled clients emit
  workflow attributes.

### Changed

- Simplify the Codex detail heading and move its cost explanation and exact query
  period into the heading's information tooltip.
- Remove the shared client cost-quality banner and repeated missing-cost
  explanation. Metric-level cost basis, partial amounts and token coverage remain.

## [1.5.0] - 2026-11-11

### Changed

- Refresh the bundled AWS Price List snapshot used before the first successful
  runtime refresh, including additional Bedrock model rates such as
  `openai.gpt-6.1-terra`. Prices remain list-price estimates, not invoices.

### Fixed

- Load the 90-day user activity heatmap from daily session aggregates instead of
  full cost and tool detail. Busy users no longer hit the overview's row limit
  while loading their activity calendar; the existing request bounds remain (#244).

## [1.4.0] - 2026-11-10

### Added

- Unify the shared Productivity page for Claude Code and Codex: client summary,
  per-model efficiency, activity, code-result, per-tool permission decision, per-tool
  result, response/wait latency and activity-index top-user sections use the same
  columns for every client, backed by the new `GET /api/clients/productivity`. Per-tool
  lists show the top ten tools plus a remainder row. Values a client cannot provide
  show a not-collected, not-aggregated or not-derived label instead of zero. The Codex
  efficiency/effort block moves off Productivity; it remains on Cost (#241, #242).

### Changed

- Add Amazon Polly English narration, matching captions and original background
  music to the documentation walkthrough, with a pinned Remotion audio composition (#240).

### Fixed

- Expand the 90-day user activity heatmap across its card, with larger responsive
  day cells, month/weekday labels and an activity legend. Preserve UTC boundaries
  and observed-session counts, including unavailable values (#239).
- Treat scored activity-index users as Productivity evidence, so a window whose only
  observations are scored top users is not shown as empty; unscored users (lookback-only
  counter samples) are not evidence (#243).

## [1.3.1] - 2026-11-10

### Fixed

- Price Bedrock models whose AWS model card uses the flat Standard-tier table (one
  table without context tiers, Global CRIS and Geo CRIS rows, `bedrock-runtime` only),
  such as `moonshotai.kimi-k3.1`, which the Price List does not list yet. These were left
  unpriced because the model-card fallback accepted only the context-tiered format (#238).

## [1.3.0] - 2026-11-10

### Added

- The task detail shows a context-size chart on the timeline's axis: per-call input
  context by lane, Claude Code compactions (linked by `prompt.id`, pre → post tokens) and,
  for Codex, the auto-compaction limit and context window the conversation reported.
  `/api/users/tasks/detail` adds `context`; Claude reports no context window, so no share
  of it is shown (#234).
- Task details have a copy-link button: `/tasks/<task id>/<from>/<to>` opens that task's
  detail for any signed-in reader, without a user in the URL.
  `/api/users/tasks/detail` accepts a missing `userExact`, resolves the task's owner (404
  when none, or for two Codex identities) and returns `owner` (#235).

### Changed

- Provide English, Korean, Japanese and Simplified Chinese versions of all five
  documentation-site guides and media credits, with Luna translation provenance.
  Document source builds, platform deployment options, ClickHouse schema setup
  and the required OTel backend, alongside Task Trace guidance and a current
  synthetic screenshot. Replace the overview's Korean video with a newly rendered
  48-second English HyperFrames walkthrough and an English caption track.
  Deliver generated media from a pinned snapshot with size/SHA256 checks before
  Pages upload; keep composition, captions and provenance as reviewed source.

## [1.2.0] - 2026-11-10

### Added

- A user guide link under the sidebar and mobile navigation, and on the `/changelog` page,
  opens the public documentation site in a new tab.

## [1.1.1] - 2026-11-10

### Security

- Install Alpine OS `zlib=1.4-r0` in the runtime image for `CVE-2026-4738`, the
  Critical finding of the ECR enhanced scan on the 1.0.0 and 1.1.0 images (fixed in
  `1.4-r0`), and require that version in actual image package metadata. Node's bundled
  zlib is recorded separately; package inspection is not CVE clearance.

### Changed

- PR review guidance distinguishes published model context and verified CLI
  transport behavior from repository policy budgets, with dated sources and
  validation rules for budget changes. Existing review limits remain unchanged (#231).

## [1.1.0] - 2026-11-09

### Added

- In-app release notes at `/changelog`, reached from a version link under the sidebar
  and mobile navigation that marks a release the browser has not opened yet. Notes ship
  in the web bundle (`dashboard/web/src/releaseNotes.js`); tests keep them aligned with
  this file and both package versions. Release tags follow the
  [release runbook](docs/runbooks/releases.md).
- `GET /api/users/tasks` and the task list accept `sort` = `tokens` (default), `cost`,
  `subagents` or `duration`. `cost` orders the top 100 Claude interactions by tokens and
  all Codex turns; the response discloses `sort_candidates` (#229).
- The task detail groups LLM calls by model and call source (lanes, calls, known cost with
  partial flag, tokens); selecting a row highlights that model in the timeline (#229).

### Fixed

- Name subagent lanes from the request log's `agent.name` when the spawning `Agent` span has
  no `subagent_type`, then from the `agent.builtin.<type>` query source. Parallel lanes of
  one type still share a name because task descriptions are not in telemetry (#228).

## [1.0.0] - 2026-11-08

First tagged release, tagged retroactively on `714fc3b`, the revision deployed on
2026-11-08. It contains every entry below; the dated headings record when each change
landed on `main`.

### Added (2026-11-08 user task traces)

- One full-width user detail for Claude Code and Codex replaces the legacy drawer on both
  Users pages. Claude-only sections are labelled and show not-collected for Codex (#215).
- `GET /api/users/tasks` lists the top 20 tasks of an exact user in a trend bucket: Claude
  interaction traces and UUID-identified Codex turns with completions linked by
  conversation and time. `GET /api/users/tasks/detail` returns main/subagent lanes,
  allowlisted span attributes, per-call and cumulative cost and rule-based cost reasons,
  bounded at 5000 spans. `/api/users/interactions` and `/api/users/heatmap` are removed (#215).

### Added (2026-11-08 resizable floating chat)

- Resize the floating chat from its top-left handle (pointer or arrow keys) or expand it
  up to 960 px; the size is clamped to the viewport and remembered per browser. Charts show
  their effective time range (#223).

### Changed (2026-11-08 chat and analysis agents)

- Split `POST /api/chat` into a conversation agent (`CHAT_MODEL_ID`, default
  `global.anthropic.claude-haiku-5-5`) that delegates data questions once per turn to a
  separate analysis agent (`ANALYSIS_MODEL_ID`, default `global.anthropic.claude-sonnet-5-5`).
  Terraform `chat_model_id`/`analysis_model_id` scope the Bedrock invoke grant to both IDs;
  an installation on the previous default loses the old model's grant in the same apply.
- Add `chart` SSE events built from stored query results (`show_chart`) and render them as
  fixed Recharts templates in both chat surfaces. Only the analysis agent requests adaptive
  summarized thinking.

### Added (2026-11-07 user cost channel bars)

- Shared Cost views combine identical emitted user IDs and show per-channel model bars
  (CCB, C4E, unclassified, Codex) beside each amount; unknown-only lines stay unpriced (#214).

### Changed (2026-11-06 dashboard security hardening)

- Read dashboard secrets from read-only `*_FILE` mounts as well as environment values and
  harden authentication, ClickHouse and health handling; the Basic failed-credential limit
  stays keyed on the client address and is configurable (#209, #211).

### Changed (2026-11-06 ClickHouse node)

- Run ClickHouse on `c9g.2xlarge` without a CPU limit (request 6) and require replica
  anti-affinity (#212).

### Added (2026-11-05 team attribute and team cost)

- Filter by the OTel `team` attribute, show a team column in every user view and add
  `GET /api/cost/by-team` and `GET /api/cost/by-team-daily` with a team cost section on
  the Claude detail Cost page (#200, #201, #202, #208).

### Added (2026-11-05 Claude session providers)

- Record reported Claude session providers (migration 009) and, with
  `CLAUDE_PROVIDER_GROUPS=true`, prefer them when inferring session channels (#203, #204).

### Added (2026-11-05 Bedrock price discovery)

- Price newly observed Bedrock models from public AWS model-card Standard-tier rates in the
  background; unsupported formats stay unknown and `AWS_PRICE_LIST=off` disables it (#207).

### Added (2026-11-04 AWS Price List rates)

- Merge AWS Price List rates (runtime refresh every `AWS_PRICE_REFRESH_HOURS`, build
  snapshot fallback) under `PRICING_JSON`/`CODEX_PRICING_JSON` overrides for list-price
  estimates; `/api/config` reports `pricing.priceList` metadata (#179, #184, #185).

### Added (2026-11-04 session turns and daily insights)

- `GET /api/overview/session-turns` and a Claude detail Overview card for turns per
  session, cost per turn and top users/sessions with coverage counts (#186).
- Optional daily Overview insights generated once per UTC day from pseudonymized
  aggregates on `INSIGHTS_MODEL_ID` and stored in DynamoDB (#187).

### Changed (2026-11-04 specialist review coverage)

- Require independent Codex and Claude reviews and Kiro when applicable, covering all
  changed paths. Binary and oversized input blocks until a complete review is available.

### Changed (2026-11-04 AI review panel)

- Run the AI PR review as a Codex lens panel (L2-L5) with a tool-less Claude chair and
  retire the Kiro cells; the specialist protocol remains available behind `ROLE_REVIEW=1`.
- Review the pinned merge-base diff and block oversized diffs instead of truncating them.
- Run each Codex cell and the chair without tools in an empty HOME/cwd with an allowlisted
  environment; a Codex cell that uses a tool is discarded and fails coverage.

### Changed (2026-10-24 documentation site)

- Refresh the public site for combined Claude Code/Codex costs, completion-scoped
  efficiency, cost drilldowns, device installation and configurable OIDC sessions.
- Add the Collector installation guide with attribution, migration and workshop
  boundaries. Link the complete API and operational runbooks.
- Replace the historical workshop demo/captures with a captioned synthetic-data demo;
  retain historical video provenance through immutable Git references.

### Fixed (2026-10-18 runtime OS zlib)

- Install the authenticated Alpine OS zlib fix for `CVE-2026-85091` and verify
  its pinned version in actual image package metadata before publication.
  Record Node's bundled zlib separately; package inspection is not CVE clearance.

### Changed (2026-10-18 schema lifecycle)

- Separate empty ClickHouse bootstrap from read-only compatibility verification of existing
  installations. Freeze schema inputs, stop automatic partial-bootstrap retries and check
  schema/ledger drift before explicit upgrades.

### Added (2026-10-18 backup health observation)

- Observe backup Job failures, stalls, suspension and success age independently of
  the dashboard, with bounded read-only Kubernetes access and one regional metric.
- Declare a CloudWatch alarm covering unhealthy and missing monitor signals, a
  regional SNS topic and optional confirmed email delivery.
- Bound new backup Jobs by a configurable deadline and two-retry backoff limit.
  Job completion remains distinct from complete objects and a usable restore.
- Refresh the observer image on every release, preserve it across Terraform applies
  and record its rollback image independently from the dashboard.

### Added (2026-10-18 cache TTL split cost)

- `/api/reliability/reported-vs-computed` rows now include `cache_write_5m_tokens`, `cache_write_1h_tokens`, `cache_split_coverage`, `cost_split` and `ratio_split`, using the `cache_creation_5m_tokens`/`cache_creation_1h_tokens` `api_request` attributes (Claude Code 2.1.300+). Unsplit tokens keep the `PRICING_CACHE_WRITE_TTL` assumption.
- Reliability's reported-vs-computed table shows the split coverage, split cost and split ratio. Reported spend, the metric-based computed costs and `PRICING_CACHE_WRITE_TTL` are unchanged.

### Fixed (2026-10-18 India Bedrock routing)

- Recognize `in.` profiles as Bedrock Runtime in backend inference and normalize
  them consistently for prices, SQL, Grafana and model labels. Preserve request
  tiers, regional rate policy, unknown prices and unsupported GovCloud scopes.
- Strip supported commercial geography prefixes from chat foundation-model IAM
  ARNs while retaining full inference-profile IDs.

### Changed (2026-10-18 runtime distribution)

- Refresh the immutable official Node 24 base and remove npm/Yarn from the final
  runtime while retaining OS package metadata and application notices.
- Inspect the actual ARM64 image's nonroot revision, runtime versions, license,
  notices and lock hashes before publication. Verify the published ARM64 config
  against the local image ID and record its manifest digest separately from the index.
- Exercise committed-source ARM64 image inspection in CI without registry publication.
  Vulnerability clearance, live authentication and production rollout remain separate.

### Changed (2026-10-18 channel fallback)

- Sessions with an observed model and no `organization.id` are now classed `bedrock`
  instead of `unknown`; sessions with no observed model stay `unknown`. Live rollup
  effect: 4 sessions moved from `unknown` to `bedrock`.
- No collection, schema or cost-basis change; backend resolution (ADR-017) is unchanged.

### Changed (2026-10-15 distinct cache admission)

- Let up to 64 distinct cold views per process wait up to 30 seconds for an
  existing cache-load slot. Preserve 64 active loads, database/request limits,
  single-flight sharing, result quotas and explicit overload errors.
- Start at most two private overview queries at once, preserving result order,
  cancellation and the first error.
- Share immutable JSON bytes and one gzip operation while responses are active;
  release representations after the last response/compression settles.

### Fixed (2026-10-15 mobile cost tables)

- Make model/user cost trend tables horizontally scrollable and keyboard-focusable
  so narrow screens can reach totals, coverage states and overflow details.

### Changed (2026-10-15 shared factor lookup)

- Coalesce equal non-Anthropic factor windows with bounded pending/settled caches
  and independent subscriber cancellation; preserve pricing, unknown values and
  the private counter-query signal.

### Changed (2026-10-15 constrained capacity)

- Prioritize shared full/cost cache profiles and stop warming unused legacy views.
  Recent authenticated default-window demand retains legacy warming.
- Retry only explicit capacity-exhausted GET responses with bounded delay, jitter
  and cancellation; preserve authentication/error handling and runtime limits.
- Cancel private sibling queries when an overview fails, preserving the original
  error classification and shared-cache ownership.
- Use promoted user identities to reject unrelated Codex log maps in PREWHERE,
  retaining original deduplication and final filters.
- Add isolated ARM64 synthetic HTTP/SQL capacity validation with immutable images,
  ownership-checked cleanup, exact-user baselines and honest admission/latency results.

### Changed (2026-10-14 cumulative diagnostic baselines)

- Group Codex cumulative baseline timestamps before full-point deduplication,
  retaining complete series/start identity and every conflicting latest tie.
  Preserve the three-day lookback, result limits and unavailable/partial semantics.
- Detect already oversized non-DELTA windows before baseline work and diagnostic
  payload transfer; report the existing limited state without hiding log usage.

### Changed (2026-10-14 focused diagnostic queries)

- Cost/productivity Effort detail queries omit unrequested metrics, traces,
  diagnostic breakdowns and quantiles. Preserve usage, denominators, scope coverage
  and full event identity; distinguish unqueried signals from absent collection.

### Changed (2026-10-14 log body collection)

- Clear unconsumed Claude log bodies before export while preserving structured
  identity and measurements. Provide a private body-only draft helper for standalone
  receivers; validate and drain queues before a separate controlled rollout.

### Changed (2026-10-13 cost query profile)

- Add a validated cost profile for shared cost/executive/trend requests and exact
  drilldowns. Preserve cost/token coverage, populations and observed request counts;
  skip diagnostic calculations and project/tool response folds.
- Compact stream-delta evidence without representative attribute maps, retaining
  scope identity and full completion deduplication. Hardware and capacity limits remain.
- Document schema accelerator proposals and distinguish shared-cache arrivals from
  distinct pending requests; no database-engine replacement or capacity guarantee.

### Changed (2026-10-12 model cost chart styling)

- Replace fallback-model hatching with stable solid palettes and matching legend swatches.
  Add GPT-6.1 Sol, GPT-6 Sol and GPT-6 Luna colors, broaden vendor fallbacks, and improve
  dark-surface contrast for the registered Fable/Opus shades.
- Refine model bar spacing, width and segment corners; shared Claude/Codex cards have
  explicit client-colored header accents. Availability marks, partial totals, price
  bases, independent scales, tables and tooltips retain their measurement semantics.

### Fixed (2026-10-11 telemetry coverage)

- Match commercial geography model prefixes consistently in Codex shared/detail pricing,
  including Haiku 5.5's request context tiers. GovCloud remains unsupported.
  Existing geography-prefixed pricing override keys must be renamed before rollout;
  see the [upgrade notes](docs/runbooks/codex-telemetry.md#dashboard-cost-and-query-contract).
- Retain model-less Claude cost reports in model, user/model, trend and comparison results.
- Expose per-metric observation evidence for outcome counters and user/CLI active time;
  detail cards preserve unavailable values and measured zero separately.
- Withhold the activity index without a permission-decision denominator and withhold means
  when any returned user lacks an index. Rankings omit unavailable indices.

### Changed (2026-10-11 price table sync)

- Claude table: `claude-haiku-5-5` at its <=100K-prompt rates (computed diagnostics cannot apply
  the per-request >100K tier); `claude-sonnet-5-5` cache read $0.20 -> $0.10 (now 0.05x).
- Codex table: `deepseek.v3.2`, `minimax.minimax-m2.5` and `moonshotai.kimi-k2.5` In-Region rates
  (inferplane model comparison data, AWS Price List, 2026-10-11), and a tiered
  `anthropic.claude-haiku-5-5` entry so Haiku 5.5 through Codex is priced per request at 100K.
  At that revision, `eu.`/`apac.` Haiku 5.5 ids missed the tiered entry; the telemetry
  coverage fixes above correct that lookup.

### Changed (2026-10-11 more Codex models)

- Codex table: GPT-5.4 and GPT-5.5 (with the >272K tier), Grok 4.3, Kimi K2 Thinking, GLM 4.7 Flash,
  MiniMax M2 and M2.1, Devstral 2 123B, gpt-oss-120b and 20b, Qwen3 32B, Qwen3 Coder 30B A3B,
  Qwen3 VL 235B A22B, Gemma 4 26B A4B and Gemma 4 E2B at In-Region list rates. Models that
  bedrock-runtime and bedrock-mantle publish under different ids are priced under both; the
  `openai.gpt-oss-20b-1:0` runtime id is inferred from the verified gpt-oss-120b pattern, not a model
  card. A `CODEX_PRICING_JSON` override of the canonical id applies under every alias id (runtime ids
  containing `:` fail the key pattern and cannot be overridden directly). Qwen3 Coder 480B
  and Qwen3 235B 2507 are omitted: the price data lists them only outside the US Regions.

### Changed (2026-10-08 Codex price table for open-weight models)

- Add AWS list rates to `codexPricing.js` for Kimi K3, Grok 4.7, Qwen3 Coder Next, Qwen3 Next 80B A3B,
  GLM 5, GLM 4.7 and Gemma 4 31B / Gemma 3 27B, 12B, 4B, so Codex sessions routed to them through a
  gateway are priced instead of reported as `unknown_model`. Kimi K3 and Grok 4.7 carry regional
  and global rates; the others are regional only, so a `global.`-prefixed id stays unpriced
  (`scope`). Models whose card publishes no cache rates price cache reads and writes as ordinary input.
- Share one SQL query parameter per distinct rate in the log-aggregate price expression. Parameters
  travel in the request URL and the price table already used about 15.5 KB of a 16 KiB header
  budget; the same table now needs about 4.2 KB.

### Changed (2026-10-07 non-Anthropic Claude cost)

- Price non-Anthropic models used through Claude Code (OpenAI, xAI, Z.ai on Bedrock) at AWS
  list rates instead of Claude Code's report, which uses default Opus rates (measured up to
  18x over). A per-session factor from `api_request` logs rescales the cost counters; an unknown
  factor (no logs, including past the 90-day log retention) makes every total containing it
  unavailable, including that group's Anthropic spend. Anthropic models keep their reports. See
  [ADR-017 amendment](docs/decisions/ADR-017-backend-cost-fallback.md#amendment-2026-10-07-non-anthropic-models-used-through-claude-code).

### Changed (2026-10-05 pricing coverage, model lists and Productivity ranking)

- Client views follow the selected range's bucket size (hourly up to two days, daily beyond,
  finer on zoom; sized from Claude's trimmed end) instead of always hourly. Trends compare
  cost, tokens, sessions and users with the preceding window of the same effective length
  (stale or partial baselines are labelled, never compared as complete), add the per-model
  cost trend, and move the periods table caveats into its help text.

- Add Bedrock pricing-page rates for `zai.glm-5.3` (2026-10-07): US and global CRIS, one
  flat tier across the 1M window, 30-minute cache-write rate.
- Add AWS model-card rates for `openai.gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`,
  `gpt-5.6-sol`, `gpt-5.6-terra` and `xai.grok-4.6` (Codex table, 272K tiers where
  published) and `claude-sonnet-5-5` (Claude table). Grok cache writes use the input rate
  because no cache-write rate is published.
- Price the documented 10% Bedrock regional premium for Claude 4.5+ models on the Codex
  Claude-table fallback (`us.`/`eu.`/`apac.`/`jp.`/`au.` and bare `anthropic.*`). Codex-table
  regional rates already include the fee. Claude client rows and legacy diagnostics reach
  pricing with normalized model ids and stay at global rates.
- Productivity's Top 10 ranks users once, using the same per-user fold as the user table;
  users active in both channels show the channels after their name instead of appearing
  once per channel.
- Hide models with a complete known-zero token total, nothing partial or unpriced, and no
  positive cost from model usage/cost lists. Totals still include them; reliability and
  diagnostics tables keep them.

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
