# Unified user detail with task trace: token, cost and subagent timeline

Status: design, approved direction 2026-11-06. Mockup:
`/home/atomoh/.tmp/task-trace-mockup-v3.html` (local only, fabricated data).

## Intent

Users now run Claude Code and Codex side by side. Looking at one person's activity
in two places — the legacy Claude-detail drawer and the shared client views — is a
UX problem. There is to be one user detail, opened from every Users entry point,
showing both clients.

On top of it, when a user's activity shows unusually high token use, an operator
wants to find the tasks that consumed it and see why: which main-session calls and
which subagents did the work, when the spend happened, and how the context grew. A
*task* is one user prompt through the end of the response. Codex shows only what
its telemetry supports and converges as Codex emits richer spans.

## Delivery order

1. **Unified user detail** — one full-width, in-page user detail replacing the
   legacy drawer, used by both Users entry points.
2. **Task trace** — the top-20 task list and the timeline overlay inside it.

One design; the plan splits into these two phases, each shippable on its own.

## Goals — phase 1: unified user detail

- Entry points:
  - Shared Users page (`page === "users"` in
    `dashboard/web/src/pages/ClientPanels.jsx`, for All / Claude Code / Codex).
    Its user table follows the Cost page's pattern: one row per user combining
    per-client parts (`combineCostUsers`, `dashboard/web/src/clientCost.js`;
    `CostUsers` in `ClientCostPanels.jsx`), clicking a user opens the detail.
  - Legacy Claude-detail Users page (`dashboard/web/src/pages/Users.jsx`):
    leaderboard row click opens the same detail instead of `UserDrawer`.
- Presentation: full page width, in-page like `CostDetail` (heading, close
  button, scroll into view) — not a side drawer. The drawer's `max-w-xl` (~576px)
  leaves ~340px for a timeline axis, too narrow for 300+ calls per task.
- Sections:
  - **Common (per selected clients)**: summary (sessions, cost, tokens with
    partial flags), cost/token trend (the shared `/api/clients/overview` with
    `userExact`), activity heatmap, tool permission decisions, and (phase 2) the
    task list. Claude and Codex permission decisions are shown per client, never
    summed: Codex decisions include automatic approvals and are not code
    acceptance (`docs/reference/codex-observability.md`).
  - **Claude-only**: lines of code, commits/PRs, code-edit accept rate, activity
    index — labelled "Claude Code only". Codex has no LOC/commit/PR source;
    when Codex is selected these show "not collected", never 0.
- Filters: follow the page's client selection (respecting `CLAUDE_ENABLED` /
  `CODEX_ENABLED`) and exact user identity. When opened from the legacy
  Claude-detail leaderboard, carry that row's group (bedrock/enterprise) for
  Claude sections, as the drawer does today (`UserDrawer.jsx` passes
  `group: row.group`). Codex sections are not group-filtered. The shared overview
  rejects `group` (`validateClientFilters`, `dashboard/server/clientMetrics.js`),
  so common sections stay group-free and say so; the group applies to the
  Claude-only sections and Claude tasks.
- Remove `UserDrawer` once both entry points use the unified detail; keep its
  existing API endpoints only while referenced.

## Goals — phase 2: task trace

- In the user detail, clicking a time bucket in the trend lists that bucket's top
  20 tasks for the user. Default sort: most tokens. Toggle: slowest. Claude and
  Codex rows are mixed with a client badge, filtered by the detail's filters.
- Clicking a task row opens a wide overlay with:
  - KPIs: total tokens, cost, LLM calls, subagents, duration.
  - Timeline lanes (mockup option B): one lane per agent (main session plus each
    subagent), with name-based icons, per-lane call count and cost. LLM-call bars
    shade by context size; tool bars and permission-wait marks sit under the lane.
    Dashed connectors show where an Agent tool call spawned a subagent lane.
  - Clicking a bar shows its details in a side panel (fields below).
  - A cumulative-cost band under the timeline, stacked by agent with the same lane
    colours; hover shows per-agent cumulative cost at that time.
  - A rule-based "why it was expensive" summary.
- The task list replaces the drawer's duration-only `userInteractions` waterfall.

## Non-goals and anti-goals

- No fleet-wide trace explorer, no new top-level page, no productivity or ROI claim.
- No LLM-generated explanation; the summary is deterministic rules.
- Never show prompt text, full commands, file paths, URLs or tool output. Use an
  attribute allowlist; do not pass through raw `SpanAttributes`. Keys that exist and
  must stay hidden include `user_prompt`, `full_command`, `file_path`, `bash_argv0`.
- Never add Codex metrics or spans to usage/cost. Codex tokens and cost come only
  from usage-bearing completion logs (AGENTS.md contracts;
  `docs/reference/codex-observability.md`).
- Unavailable is not zero: missing trace collection shows "trace not collected", never 0.

## Data facts (verified against production ClickHouse, 2026-11-06)

- `claude_code.otel_traces`: ~110M rows, TTL 45d hot / 90d delete. Claude spans
  since 2026-09-04; only users with the traces beta enabled emit them (5 distinct
  `user.email` overall). Codex trace users and Codex log users: 4 each (7d).
- Claude span types (`SpanType` column): `interaction`, `llm_request`, `tool`,
  `tool.execution`, `tool.blocked_on_user`. Promoted columns already exist:
  `SessionId`, `SpanType`, `DurationMs`, `TtftMs`, `AgentId`, `ParentAgentId`,
  `Model`, `Decision`, `UserEmail` (`clickhouse-schema.sql` ~line 478).
- Claude task = the `interaction` span's `TraceId`. Use span `Duration` for the
  interaction (its `duration_ms` attribute is absent).
- Claude subagents: `llm_request` spans with non-empty `agent_id`; 12,279 of them
  (7d) have a `tool.execution` parent and 62 an `interaction` parent. The spawning
  `tool` span carries `subagent_type` (e.g. `general-purpose`, `Explore`, `fork`,
  custom names such as `co-agent:pr-autofix-implementer`). `query_source_safe`
  distinguishes `repl_main_thread`, `agent.builtin.*`, `agent.custom`,
  `agent_summary`, etc. About 12% of subagent `llm_request` spans in a 7-day
  window had no `interaction` in the same window — fetch a task's spans by
  `TraceId` with a wider time bound than the task's start day.
- Claude `llm_request` span attributes include `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_creation_tokens`, `ttft_ms`, `attempt`,
  `error_class`, `status_code`, `stop_reason`, `query_source_safe`, `effort`,
  `speed`, `request_id`. Tool spans include `tool_name`, `subagent_type`,
  `skill_name`, `anthropic.mcp.server.name`, `bash_command_class`;
  `tool.blocked_on_user` has `decision`, `source`.
- Claude cost: `api_request` logs carry `cost_usd` and `request_id`; span
  `request_id` matched 8,609 of 8,662 spans (2d). Reported cost is the Claude
  spend basis for Anthropic models; unmatched calls fall back to the existing
  computed estimate, labelled as such. Non-Anthropic models on Claude Code follow
  ADR-017 per request (`dashboard/server/nonAnthropicCost.js`): AWS list estimate,
  unknown when it cannot be computed — never the reported `cost_usd`, which
  overstates them.
- Largest Claude task in 7 days: 342 LLM calls, ~173M tokens (mostly cache read).
- Codex: no turn-root span. Spans with `turn.id`/`turn_id` include
  `codex.sampling` (one per model call; has `conversation.id`), `exec_command`,
  `codex.tool_blocking`, `unified_exec.exec_command`, `run_sampling_request`.
  Spans carry no token counts.
- Codex completion logs (`codex.sse_event`/`codex.websocket_event`,
  `event.kind = response.completed`) carry token fields, `model`,
  `model_reasoning_effort`, `conversation.id`, `ttft_ms`, `duration_ms`, but no
  turn id. In 2 days there were 16,235 completions versus 8,588 `codex.sampling`
  spans, so many completions have no matching trace.
- Codex multi-agent spans (`thread_spawn`, `multi_agent_v1*`) exist, but no
  attribute links a child thread to its parent turn.

## Decided behaviour

### Task list (phase 2; per user, per selected trend bucket)

- Claude row: one `interaction`. Codex row: one `(conversation.id, turn.id)`,
  with the time window = min start .. max end of its spans ("observed span
  window"; never sum overlapping durations).
- Columns (per mockup): start, client, model, LLM calls, subagents, token
  composition bar, total tokens, cost, duration.
- Tokens follow ADR-014 semantics. Claude: input + cache read + cache write +
  output. Codex: input + output from usage-bearing completions (input already
  includes cache, output already includes reasoning; do not add subsets again).
  Unknown stays null with partial flags.
- Codex cost and tokens per turn: attach completion logs by `conversation.id`
  whose timestamp falls within the turn window, priced with the existing Codex
  pricing path (`codexPricing.js`, per-completion tier/routing). Label the cost
  "estimated linkage" (estimated linkage). The user approved this accuracy.
- Show, for the day, how many Codex completions (and their cost) could not be
  attached to any traced turn, so the table is not mistaken for the full day.
- Always show a "partial collection" badge: only trace-enabled users and clients appear.
  Users with no traces see "trace not collected". Dates older than trace retention (90d)
  are unavailable.
- Filter scope (designer's call): follow the shared view's existing filter
  semantics — client selection (respecting `CLAUDE_ENABLED`/`CODEX_ENABLED`),
  exact user (same identity fallback as shared views: `user.email`, else
  `enduser.id`), and backend where the row has backend evidence. A group carried
  from the legacy Claude-detail leaderboard filters Claude tasks only (via
  `session_group`, `dashboard/server/grouping.js`); Codex tasks are not
  group-filtered. The unattached-completion note counts the user's Codex
  completions in the bucket.
- A user with only one client's traces still gets the task list; a user with no
  traces sees "trace not collected" while the cost trend above still works.

### Task detail overlay (phase 2)

- Lanes: Claude — one per `agent_id` (empty = main session), labelled by the
  spawning tool span's `subagent_type`; connectors from the spawning
  `tool.execution` span. Codex — main lane only; `thread_spawn`/`multi_agent_v1*`
  appear as tool bars on it. No Codex child lanes until a parent–child key is
  verified in data.
- Icons by name: main session, `general-purpose`, `Explore`, `fork`, generic
  custom agent; tools Bash, Read, Edit/Write, Grep/Glob, WebFetch/WebSearch,
  MCP (with server name), permission wait. Unknown names use a generic icon.
- LLM-call detail: model, start offset, duration, TTFT, context (input total),
  token composition, cost (reported or computed, labelled), query source, stop
  reason, attempt/retry, error class. Codex: model, effort, tokens, cost
  ("estimated linkage"), TTFT/duration from the completion log; missing fields show
  "not collected".
- Tool detail: tool name, start offset, execution time, permission wait and
  decision/source, success/error class, `bash_command_class`, MCP server, skill.
- Cumulative cost band: stacked per lane, same colours; hover tooltip with
  per-agent cumulative values.
- "Why expensive" rules (all from the task's own data): cache-read share of
  tokens; context size first call → last call; top agent's cost share; most
  expensive call; retry count; total permission-wait time. Omit a rule whose
  inputs are unavailable rather than showing zero.

### Server

- New endpoints through the existing `route()` wrapper in
  `dashboard/server/index.js`, with bound parameters and exact user matching
  (as `userExact` in `/api/clients/overview`): a task list (user, client
  selection, bucket range, sort) and a task detail. Mixed-client results keep
  client, backend and model separate (AGENTS.md contracts).
- Detail payloads are bounded; if a task exceeds the bound, return the most recent
  spans, flag `truncated`, and withhold whole-task totals that would be wrong.
- UI masking is not access control; the attribute allowlist is enforced server-side.

## Left to the builder

- Phase 1 data sources for Codex in the common sections (sessions, activity
  heatmap, permission decisions) — reuse existing shared/Codex insights queries
  where they exist; a section with no supported Codex source shows "not collected".
- Whether the unified detail is reached by URL (deep link) and how its state
  survives refresh — follow the Cost detail's existing behaviour.
- Endpoint paths, payload shapes, detail identifier format for Claude vs Codex.
- Span bound for the detail view (largest observed task ≈ 342 LLM calls plus
  tool spans) and the wider lookback for fetching a task's spans.
- Whether new MATERIALIZED columns are needed. Default: none — per-user, per-day
  scans filtered on `UserEmail` and `Timestamp` should be small. Measure first; if
  a migration is needed, use the next free number at implementation time (009 is
  contested by in-flight work) and treat production application as a separate,
  user-approved step.
- Overlay component structure, chart library use (follow existing web patterns),
  colour tokens, icon artwork.
- Exact matching tolerance for Codex completion → turn windows.
- Tests: server unit tests, a real-ClickHouse regression in the style of
  `scripts/test-client-sql.sh`, web render tests; run the checks in `AGENTS.md`.
