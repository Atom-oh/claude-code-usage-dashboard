# Unified User Detail and Task Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One full-width user detail for Claude Code and Codex, opened from both Users pages, with a top-20 task list and a per-task subagent timeline showing tokens and cost.

**Architecture:** Phase 1 replaces `UserDrawer` with an in-page `UserDetail` built on the shared `/api/clients/overview` (`userExact`) plus existing Claude user endpoints and Codex tools insights. Phase 2 adds `taskTraces.js` (SQL builders + pure folds) behind two `route()` endpoints, and web `TaskList`/`TaskTraceOverlay` components fed by pure helpers in `taskTrace.js`.

**Tech Stack:** Node 22 Express server (`node --test`), ClickHouse 24.8 (bound params), React 18 + Vite + Tailwind, Recharts, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-06-user-task-trace-design.md` (mockup `/home/atomoh/.tmp/task-trace-mockup-v3.html`).

## Global Constraints

- Work in a fresh worktree from `origin/main` (the current checkout `feat/cost-model-user-breakdown` carries unrelated uncommitted work). Run `git fetch && git status -sb` first.
- All SQL uses bound parameters; all routes go through `route()` in `dashboard/server/index.js`; 500 bodies never contain error text.
- Claude spend basis: reported `cost_usd` (Anthropic models); non-Anthropic Claude models use the ADR-017 AWS list estimate per request, unknown when not computable; unmatched Anthropic calls use `computeCost()` labelled `computed`.
- Codex tokens/cost only from usage-bearing `response.completed` completions; Codex spans/metrics never contribute usage. Codex input includes cache subsets, output includes reasoning — never add subsets again (ADR-014).
- Unavailable ≠ zero: unknown values are `null` with partial flags; UI shows "미수집" / "trace 미수집", never 0.
- Never return or render `user_prompt`, `full_command`, `file_path`, `bash_argv0`, prompt/command/path/URL/tool-output text. Server-side attribute allowlist only.
- Exact user matching: `coalesce(nullIf(UserEmail,''), nullIf(EndUserId,''), '') = {userExact:String}` (same as `clientMetrics.js` `earlyUser`).
- `CLAUDE_ENABLED`/`CODEX_ENABLED`: clients outside `clientConfig.enabledClients` are rejected (400) or omitted, never queried.
- UI copy is Korean; code comments/docs English. Labels pinned by the spec: "부분 수집", "trace 미수집", "미수집", "연결 추정", "Claude Code에서만 수집".
- Checks before each commit: `(cd dashboard/server && npm test)`, `(cd dashboard/web && npm test && npm run build)`; before the final PR also `bash tests/run-all.sh`.
- No schema migration in this plan. If Task 9's measurement exceeds the budget, stop and report; a migration is a separate approved change.

## Review Focus

1. A user whose email is a substring of another's (`kim@x.com` vs `joakim@x.com`) — every new query and the Codex tools `userExact` path must return only the exact user. Tests: Task 1, Task 5.
2. A Claude task whose subagent spans start after the selected bucket ends (long tasks crossing the bucket/day boundary) — detail must still include them. Test: Task 7.
3. Codex completions duplicated by repeated delivery — attached once, not double-counted in task tokens/cost or the unattached note. Test: Task 6.
4. A task larger than the span bound — `truncated: true`, whole-task totals withheld (`null`), UI labels it. Tests: Task 7, Task 11.
5. Codex disabled (`CODEX_ENABLED=false`) or Claude disabled — the detail and task endpoints omit the disabled client without 500s; UI hides that client's sections. Tests: Task 3, Task 5.

---

## Phase 1 — Unified user detail

### Task 1: Exact-user filter for Codex tools insights

**Files:**
- Modify: `dashboard/server/index.js` (`/api/codex/insights` validate, ~line 367)
- Modify: `dashboard/server/codexDiagnosticSource.js` (`USER_MATCH`, `diagnosticSelection` params)
- Modify: `dashboard/server/codexInsightsLogs.js` (`logSelection` params and user predicate)
- Test: `dashboard/server/codexInsights.test.js`, `dashboard/server/codexDiagnosticSource.test.js`, `dashboard/server/codexInsightsLogs.test.js`

**Interfaces:**
- Produces: `GET /api/codex/insights?profile=tools&userExact=<id>` returns the existing tools payload restricted to that exact identity. `userExact` with any other profile still returns 400 `"unsupported filter"`.

- [ ] **Step 1: Write failing tests**
  - `codexInsights.test.js`: `"tools profile accepts userExact"` — validate passes for `{profile:"tools", userExact:"kim@x.com"}`; `"non-tools profile rejects userExact"` — `{userExact:"kim@x.com"}` throws `ValidationError` with message `"unsupported filter"`.
  - `codexDiagnosticSource.test.js` / `codexInsightsLogs.test.js`: `"userExact binds clientUserExact and compares by equality"` — returned `params.clientUserExact === "kim@x.com"` and SQL contains `{clientUserExact:String} = '' OR` with `=` (not `positionCaseInsensitive`) on the user identity.
- [ ] **Step 2: Run** `cd dashboard/server && node --test codexInsights.test.js codexDiagnosticSource.test.js codexInsightsLogs.test.js` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** — add `clientUserExact: filters.userExact || ""` to both selections' params and `AND ({clientUserExact:String} = '' OR <identity> = {clientUserExact:String})` beside the existing substring predicate; relax the route validate to allow `userExact` only when `raw.profile === "tools"`; pass `userExact` through `validateClientFilters` (already parsed).
- [ ] **Step 4: Run** the same command — Expected: PASS; then `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(server): exact user filter for Codex tools insights`; update `docs/api-reference.md` (Codex insights filters) in the same commit.

### Task 2: Pure helpers for the unified user detail

**Files:**
- Create: `dashboard/web/src/userDetail.js`
- Test: `dashboard/web/src/userDetail.test.js`

**Interfaces:**
- Consumes: shared overview rows (`by_user`, `timeseries` with `client`, `t`, `sessions`, `cost_usd`, `cost_partial`, `observed_tokens`, `tokens_partial`); `combineCostUsers` from `clientCost.js`.
- Produces:
  - `combineUsers(userRows, modelRows, clients) -> Array<{ user, clients: string[], sessions: number|null, observed_tokens: number|null, tokens_partial: boolean, cost_usd: number|null, cost_partial: boolean, parts }>` — one row per identity; cost fields from `combineCostUsers`; sessions summed across clients (client-scoped IDs are disjoint); tokens summed with partial OR; all-unknown → `null`.
  - `heatmapDays(timeseries, clients) -> Array<{ day: "YYYY-MM-DD", sessions: number|null, by_client: Record<string, number|null> }>` — 24h buckets keyed by UTC day.
  - `claudeOnlyFields(clients) -> { show: boolean, codexUnavailable: boolean }` — `show` when `clients` includes `"claude"`; `codexUnavailable` when it includes `"codex"`.

- [ ] **Step 1: Write failing tests** — `combineUsers merges claude and codex rows of one user` (sessions 3+2 → 5, tokens 100+null → 100 with `tokens_partial: true`); `combineUsers keeps all-unknown tokens null`; `combineUsers keeps unidentified rows per client` (empty `user` not merged across clients, as `combineCostUsers`); `heatmapDays groups by UTC day and keeps per-client values`; `claudeOnlyFields for codex-only selection` → `{ show:false, codexUnavailable:true }`.
- [ ] **Step 2: Run** `cd dashboard/web && npx vitest run src/userDetail.test.js` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the three functions in `userDetail.js`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): user detail helpers`.

### Task 3: `UserDetail` component

**Files:**
- Create: `dashboard/web/src/components/UserDetail.jsx`
- Move: `Heatmap` out of `dashboard/web/src/components/UserDrawer.jsx` into `UserDetail.jsx` (accept `heatmapDays` rows; per-client tooltip)
- Test: `dashboard/web/src/components/UserDetail.test.jsx`

**Interfaces:**
- Consumes: Task 1 endpoint; Task 2 helpers; `useApi` (`dashboard/web/src/useApi.js`); existing `/api/users/daily`, `/api/users/decisions-by-tool` (Claude, with `email`, `group`).
- Produces: `export function UserDetail({ user, clients, group = null, hours, parentRange, stale, onClose, onBucket = null, children })` — full-width `<section aria-label="사용자 상세">` with heading (masked user), "상세 닫기" button, scroll/focus on mount (same as `CostDetail`). `children` is the Phase 2 slot (task list). Requests:
  - overview: `/api/clients/overview` `{ client: clients.length > 1 ? "all" : clients[0], userExact: user, intervalHours: hours, from, to }` → summary tiles (세션, 비용, 토큰) + `Trend`-style cost/token chart; clicking a bucket calls `onBucket({ from, to })` (bucket bounds, UTC) when provided (used in Task 10).
  - heatmap: same endpoint with `intervalHours: 24` and the last 90 days ending at `to` (range cap is 90 days) → "활동 히트맵 · 최근 90일".
  - Claude-only (when `clients` includes `"claude"`): `/api/users/daily` (LOC, commits) and `/api/users/decisions-by-tool` with `group` → section titled "Claude Code에서만 수집"; when `clients` includes `"codex"`, these tiles show "Codex: 미수집".
  - Codex tools (when `clients` includes `"codex"`): `/api/codex/insights` `{ profile: "tools", userExact: user }` → separate "Codex 도구 권한 결정" card with the note that automatic approvals are included; never summed with Claude decisions.
  - When `group` is set: a note "그룹(<group>) 필터는 Claude 전용 영역에만 적용됩니다" above common sections.

- [ ] **Step 1: Write failing tests** (mock `fetch` like `ClientPanels.test.jsx`): `renders combined summary for claude and codex`; `codex-only hides Claude fetches and shows 미수집 for LOC`; `claude-only does not request codex insights`; `group note appears and group is sent only to /api/users/* requests`; `never renders raw email when masking is on` (`setPiiMask(true)`).
- [ ] **Step 2: Run** `npx vitest run src/components/UserDetail.test.jsx` — Expected: FAIL.
- [ ] **Step 3: Implement** `UserDetail.jsx` per the interface.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): unified user detail`.

### Task 4: Wire both Users entry points; remove `UserDrawer`

**Files:**
- Modify: `dashboard/web/src/pages/ClientPanels.jsx` (`case "users"` ~line 456)
- Modify: `dashboard/web/src/pages/Users.jsx` (lines ~97–303: `selected` state and `<UserDrawer>`)
- Delete: `dashboard/web/src/components/UserDrawer.jsx`
- Modify tests: `dashboard/web/src/pages/ClientPanels.test.jsx`, `dashboard/web/src/zoomGuard.test.js` (drop drawer case), any `UserDrawer` references (`grep -rn UserDrawer dashboard/web/src`)
- Modify docs: `docs/reference/frontend.md`

**Interfaces:**
- Consumes: `UserDetail` (Task 3), `combineUsers` (Task 2).
- Produces: shared Users page table "사용자별 사용량" becomes one row per user (`combineUsers`) with a client-parts column; clicking the user cell calls `select({ kind: "user-detail", user })` and renders `<UserDetail user clients={selected} hours parentRange stale onClose />` below the table, reusing the `detailPick`/`rangeKey` pattern (range change closes it). Legacy `Users.jsx` row click renders `<UserDetail user={row.user} clients={enabledClients} group={row.group} ... />` in-page below the leaderboard instead of the drawer.

- [ ] **Step 1: Write failing tests** — `ClientPanels.test.jsx`: `users page shows one row per user across clients` and `clicking a user opens 사용자 상세`; a legacy Users test (`dashboard/web/src/pages/Users.test.jsx`, create): `leaderboard click opens UserDetail with group`.
- [ ] **Step 2: Run** `npx vitest run src/pages` — Expected: FAIL.
- [ ] **Step 3: Implement** the wiring; delete `UserDrawer.jsx`; keep `/api/users/heatmap` and `/api/users/interactions` server routes (Phase 2 removes `interactions`).
- [ ] **Step 4: Run** `npm test && npm run build` (web) — Expected: PASS, build succeeds.
- [ ] **Step 5: Commit** `feat(web): open unified user detail from both Users pages`. Phase 1 is shippable here.

---

## Phase 2 — Task trace

### Task 5: Claude task list (server)

**Files:**
- Create: `dashboard/server/taskTraces.js`
- Modify: `dashboard/server/index.js` (register route)
- Test: `dashboard/server/taskTraces.test.js`

**Interfaces:**
- Produces:
  - `validateTaskQuery(raw, enabledClients) -> { clients: string[], userExact: string, backend: string, group: string, sort: "tokens"|"duration" }` — `userExact` required (≤256 chars); `client` via `selectClients`; `group` allowed only when `clients` is `["claude"]` or includes claude (applies to Claude rows only); `sort` default `"tokens"`; else `ValidationError`.
  - `claudeTaskListSql(from, to, q) -> { sql, params }` — interactions of the exact user starting in `[from, to)`, joined to per-`TraceId` aggregates from spans in `[from, to + 24h)`: `llm_calls`, distinct non-empty `AgentId`, token sums from `SpanAttributes` (`input_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `output_tokens`), models, and per-request `request_id`s; group via `GROUP_CTE`/`session_group` when `q.group`.
  - `claudeCostSql(from, to, requestIds)` — `api_request` logs `cost_usd` by `request_id` in `[from, to + 24h)`.
  - `foldClaudeTasks(taskRows, costRows) -> Task[]`.
  - Route `GET /api/users/tasks` (`client: null`, `warm: false`) → `{ tasks: Task[] (≤20), unattached_codex: null | {...}, coverage: { claude: "observed"|"empty"|"not_requested", codex: ... }, partial: true }`.
  - `Task = { id: "claude:<TraceId>" | "codex:<conversationId>:<turnId>", client, started_at, duration_ms, duration_basis: "interaction_span"|"observed_span_window", models: string[], llm_calls, subagents, tokens: { input, cache_read, cache_write, output, observed_tokens, tokens_partial }, cost_usd: number|null, cost_partial: boolean, cost_basis: "client_reported"|"computed"|"aws_list_estimate"|"linked_estimate"|"mixed" }`.
  - Per-call Claude cost rule (used here and in Task 7): `claudeCallCost({ model, backend, tokens, reported }) -> { cost_usd, basis }` — Anthropic + reported → reported/`client_reported`; Anthropic without report → `computeCost()`/`computed`; `isNonAnthropicModel(model)` → per-request AWS list estimate exactly as `foldFactors` computes its numerator in `nonAnthropicCost.js` (`aws_list_estimate`), `null` when unpriced.

- [ ] **Step 1: Write failing tests** — `validateTaskQuery requires userExact`; `rejects sort=foo`; `omits disabled codex`; `claudeTaskListSql binds userExact and uses equality` (no `positionCaseInsensitive` on user); `claudeTaskListSql widens span window by 24h`; `foldClaudeTasks sorts by observed tokens and keeps 20`; `sort=duration orders by duration_ms`; `claudeCallCost uses reported cost for claude-opus`; `claudeCallCost uses AWS list estimate for non-Anthropic model and ignores reported`; `claudeCallCost returns null for unpriced non-Anthropic`; `task cost_basis is mixed when calls differ`; `all-unknown tokens stay null`.
- [ ] **Step 2: Run** `node --test taskTraces.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the functions and route (`validate: (raw) => validateTaskQuery(raw, clientConfig.enabledClients)`).
- [ ] **Step 4: Run** — Expected: PASS; `npm test` PASS.
- [ ] **Step 5: Commit** `feat(server): Claude task list endpoint`.

### Task 6: Codex tasks and completion attachment

**Files:**
- Modify: `dashboard/server/taskTraces.js`
- Test: `dashboard/server/taskTraces.test.js`

**Interfaces:**
- Consumes: Task 5 `Task` shape and route.
- Produces:
  - `codexTurnSql(from, to, q)` — spans with `ResourceAttributes['client'] = 'codex'` (same predicate as `buildTraceQuery` in `codexSignals.js`), exact user, grouped by `(conversation.id, coalesce(nullIf(turn_id,''), turn.id))`: window min start / max end, `codex.sampling` count as `llm_calls`, models. Turns without a conversation id are skipped (counted in coverage).
  - `codexCompletionSql(from, to, q)` — usage-bearing completions (`event.name IN ('codex.sse_event','codex.websocket_event') AND event.kind = 'response.completed'`) of the exact user in `[from, to + 24h)`, deduplicated with the same identity rule as `logSelection(..., distinct = true)` in `codexInsightsLogs.js`, with token fields, model, effort, `conversation.id`, `event.timestamp`.
  - `attachCompletions(turns, completions, { slackMs = 5000 }) -> { tasks: Task[], unattached: { completions: number, cost_usd: number|null, cost_partial: boolean } }` — a completion attaches to the turn of the same conversation whose `[start, end + slackMs]` contains its timestamp; if several, the latest start; each completion at most once. Tokens = input + output (ADR-014); cost via `priceCodexUsage(row, liveCodexPricing)`; `cost_basis: "linked_estimate"`, `duration_basis: "observed_span_window"`.
  - Route merges Claude and Codex tasks, re-sorts, keeps 20, sets `unattached_codex`.

- [ ] **Step 1: Write failing tests** — `attaches completion inside turn window`; `completion within slack attaches`; `completion outside every window is unattached`; `duplicate completion identity counts once` (Review Focus 3); `overlapping turns: latest start wins`; `codex tokens do not add cache or reasoning subsets`; `unpriced completion makes cost null with cost_partial`; `codexTurnSql uses client=codex predicate and exact user`; `merged list mixes clients sorted by tokens`.
- [ ] **Step 2: Run** `node --test taskTraces.test.js` — Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): Codex turns with linked completion cost`.

### Task 7: Task detail endpoint

**Files:**
- Modify: `dashboard/server/taskTraces.js`, `dashboard/server/index.js`
- Test: `dashboard/server/taskTraces.test.js`

**Interfaces:**
- Produces:
  - `SPAN_ATTRIBUTE_ALLOWLIST = { llm: ["model","input_tokens","output_tokens","cache_read_tokens","cache_creation_tokens","ttft_ms","attempt","error_class","status_code","stop_reason","query_source_safe","effort","speed"], tool: ["tool_name","subagent_type","skill_name","anthropic.mcp.server.name","bash_command_class","success","error_class"], wait: ["decision","source"], codex: ["model","tool_name","aborted"] }`.
  - `SPAN_BOUND = 5000`.
  - `parseTaskId(id) -> { client: "claude", traceId } | { client: "codex", conversationId, turnId }` — strict formats (hex TraceId; identifier-safe ids), else `ValidationError`.
  - `claudeDetailSql(from, to, traceId)` / `codexDetailSql(from, to, q, conversationId, turnId)` — spans in `[from, to + 24h)`, newest `SPAN_BOUND` plus a total count; selected columns are ids, parent, `SpanType`/name, start, duration, `AgentId`, and only allowlisted attributes (never `SpanAttributes` whole).
  - `foldTaskDetail(task, spanRows, costRows | completions) -> { task, lanes: Lane[], spans: Span[], truncated: boolean, why: WhyRule[] }`.
    - `Lane = { id: "main" | <agentId>, label, kind: "main"|"general-purpose"|"Explore"|"fork"|"custom", spawned_by: <spanId>|null, llm_calls, cost_usd, cost_partial }` — Claude lanes by `AgentId` (empty → main); `label/kind` from the spawning `tool` span's `subagent_type` (the `tool.execution` parent of the lane's first `llm_request`); Codex: single `main` lane.
    - `Span = { id, parent, lane, kind: "llm"|"tool"|"wait", name, start_ms (offset from task start), duration_ms, attrs, tokens?, cost_usd?, cost_basis? }` — Codex `llm` spans are `codex.sampling`, carrying the attached completion's tokens/cost when linked.
    - `WhyRule = { rule: "cache_read_share"|"context_growth"|"top_lane_share"|"most_expensive_call"|"retries"|"permission_wait", value }` — omit a rule whose inputs are unavailable.
    - When truncated: `task` totals that depend on all spans (`llm_calls`, `cost_usd`, `tokens`) become `null`.
  - Route `GET /api/users/tasks/detail?id&from&to&userExact` — verifies the task belongs to `userExact` (else 404 `{ error: "not found" }`).

- [ ] **Step 1: Write failing tests** — `parseTaskId rejects injection-shaped ids`; `detail SQL never selects whole SpanAttributes or forbidden keys` (assert SQL lacks `user_prompt`, `full_command`, `file_path`, `bash_argv0`); `foldTaskDetail builds lanes from AgentId with subagent_type labels`; `subagent spans after the bucket end are included` (Review Focus 2: span at `to + 2h`); `truncated detail withholds totals` (Review Focus 4); `why omits rules with missing inputs`; `why context_growth reports first and last call context`; `detail for another user's task returns 404`.
- [ ] **Step 2: Run** `node --test taskTraces.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; `npm test` PASS.
- [ ] **Step 5: Commit** `feat(server): task trace detail endpoint`; document both endpoints in `docs/api-reference.md` and the data rules in `docs/reference/data.md` (do not edit `docs/reference/codex-observability.md` while another session is changing it — add a pointer later).

### Task 8: Remove the duration-only interactions endpoint

**Files:**
- Modify: `dashboard/server/index.js` (drop `/api/users/interactions`), `dashboard/server/queries.js` (`userInteractions`), related tests/docs (`grep -rn "users/interactions\|userInteractions" dashboard docs`).

- [ ] **Step 1:** Remove route, function and their tests/docs references.
- [ ] **Step 2: Run** server and web `npm test` — Expected: PASS.
- [ ] **Step 3: Commit** `refactor(server): drop interaction waterfall superseded by task traces`.

### Task 9: Real ClickHouse regression and query budget

**Files:**
- Modify: `scripts/test-client-sql.sh` (add a task-trace section with fixture spans/logs)

- [ ] **Step 1:** Add fixtures: two users `kim@x.com` / `joakim@x.com`; one Claude interaction with main + `general-purpose` subagent spans, one subagent span 2h after the interaction day; matching `api_request` logs (one non-Anthropic model); one Codex turn with two completions plus one duplicate delivery and one unattached completion.
- [ ] **Step 2:** Assert via the real SQL builders: kim gets 1 Claude + 1 Codex task, joakim's rows absent; subagent lane present; duplicate counted once; `unattached.completions === 1`.
- [ ] **Step 3: Run** `bash scripts/test-client-sql.sh` — Expected: PASS.
- [ ] **Step 4:** Measure against production read-only (clickhouse-investigate skill) for the heaviest trace user over 1 day and 7 days: list ≤ 2 s and detail ≤ 2 s. Record numbers in the PR description; if over budget, stop and report.
- [ ] **Step 5: Commit** `test: task trace SQL regression`.

### Task 10: Task list in the user detail (web)

**Files:**
- Create: `dashboard/web/src/components/TaskList.jsx`
- Modify: `dashboard/web/src/components/UserDetail.jsx` (bucket click → `TaskList`)
- Test: `dashboard/web/src/components/TaskList.test.jsx`

**Interfaces:**
- Consumes: `/api/users/tasks` (Task 5/6), `UserDetail` `onBucket`.
- Produces: `export function TaskList({ user, clients, group, from, to, onOpen })` — table per mockup step ②: 시작, 클라이언트 배지, 모델, LLM 호출, 서브에이전트, 토큰 구성 바, 총 토큰, 비용 (basis label; "연결 추정" for Codex), 소요; sort toggle "토큰 많은 순 / 느린 순"; "부분 수집" badge always; unattached Codex note "trace와 연결되지 않은 Codex completion N건 · $X"; empty → "trace 미수집". Row click → `onOpen(task.id)`.

- Buckets starting more than 90 days before now (trace TTL) render "trace 보관 기간(90일) 경과 · 미수집" without a request.

- [ ] **Step 1: Write failing tests** — `clicking a trend bucket loads tasks for that bucket` (request has bucket `from/to`); `bucket older than 90 days shows retention notice without fetching`; `sort toggle requests sort=duration`; `codex row shows 연결 추정`; `unknown cost renders 미수집 not $0`; `empty response shows trace 미수집`; `unattached note renders count`.
- [ ] **Step 2: Run** `npx vitest run src/components/TaskList.test.jsx` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): task list in user detail`.

### Task 11: Task trace overlay (web)

**Files:**
- Create: `dashboard/web/src/taskTrace.js`, `dashboard/web/src/components/TaskTraceOverlay.jsx`, `dashboard/web/src/components/taskIcons.jsx`
- Test: `dashboard/web/src/taskTrace.test.js`, `dashboard/web/src/components/TaskTraceOverlay.test.jsx`

**Interfaces:**
- Consumes: `/api/users/tasks/detail` payload (Task 7).
- Produces:
  - `laneOrder(lanes) -> Lane[]` — main first, then by first span start.
  - `cumulativeByLane(spans, lanes, buckets = 120) -> Array<{ t_ms, total: number|null, by_lane: Record<laneId, number|null> }>` — stacked cumulative cost; a lane with any unknown cost becomes `null` from that point (not dropped).
  - `iconFor(kindOrToolName) -> IconKey` — `main|general-purpose|Explore|fork|custom|Bash|Read|Edit|Write|Grep|Glob|WebFetch|WebSearch|mcp|wait`; tool names starting `mcp__` → `mcp`; unknown → `custom` (agents) / `tool` (tools).
  - `export function TaskTraceOverlay({ taskId, user, from, to, onClose })` — full-screen overlay (`role="dialog"`, Esc closes): KPI row, lane timeline (mockup v3: icon + label + "N 호출 · $X" per lane, LLM bars shaded by context size, tool bars, wait marks, dashed spawn connectors), click a bar → side panel with allowlisted fields (Codex missing fields "미수집"), stacked cumulative cost band with hover tooltip, "왜 많이 썼나" list from `why`, "부분 수집" badge, truncated banner "일부 span만 표시 — 전체 합계 미표시".
  - Lane colours: add `lane` palette entries in `dashboard/web/src/colors.js` (main, general-purpose, Explore, fork, custom) reused by bars and band.

- [ ] **Step 1: Write failing tests** — `laneOrder puts main first`; `cumulativeByLane stacks lanes and is monotonic`; `cumulativeByLane marks unknown lane null`; `iconFor maps mcp__slack__x to mcp`; overlay: `renders one lane per subagent with labels`; `clicking an llm bar shows tokens and cost basis`; `codex bar shows 미수집 for TTFT breakdown`; `truncated detail shows banner and hides totals`; `no forbidden fields rendered even if present in payload` (inject `full_command` into attrs → not in DOM).
- [ ] **Step 2: Run** `npx vitest run src/taskTrace.test.js src/components/TaskTraceOverlay.test.jsx` — Expected: FAIL.
- [ ] **Step 3: Implement** (SVG like the mockup or Recharts; follow `ModelCostTrend.jsx` patterns for tooltips).
- [ ] **Step 4: Run** web `npm test && npm run build` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): task trace overlay with subagent lanes`; update `docs/reference/frontend.md`.

### Task 12: Final verification

- [ ] Run every check in `AGENTS.md` (server/web tests, web build, `bash tests/run-all.sh`, `terraform fmt -check -recursive infra/`, `terraform validate`) — redirect output to log files under `/home/atomoh/.tmp` and grep for failures.
- [ ] Manually open the app (run skill) with a trace-enabled user: Phase 1 detail from both Users pages; Phase 2 list → overlay; Codex-only and Claude-only selections.
