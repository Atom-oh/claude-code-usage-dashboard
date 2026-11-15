# Codex turn rollup

Status: approach approved by the owner (2026-11-15); written design for review.

## Intent

Codex task reads aggregate raw `otel_traces` turn spans over the page range on every request.
The list scans 30 days plus 24h either side to build turn rows. The detail repeats that scan for
one conversation, then scans the same range again for the turn's spans, completions and owner.
The work is CPU-bound Map decoding. A long Codex session's detail already takes about 22 s
against a 25 s load budget. The pre-0.166 subagent lineage fix
(`2026-11-15-codex-legacy-lineage-design.md`) adds subagent pricing and pushes that page past
the budget. A per-turn rollup gives each turn's exact window, so every detail read can cover
that turn instead of the page.

## Evidence (production, read-only, 2026-11-15)

- **Detail reads.** Detail of a 22-hour orchestrator turn (31.7K model calls, one 8M-span
  trace), page range 2026-10-16..11-15. Uncompressed bytes and time per read:
  - turn read 30 GB, 9.9 s
  - span read 32 GB, 5.6 s
  - completion read 25 GB, 7.7 s
  - owner read 22 GB, 4.3 s
  - total wall time 22.2 s on `main`, 27.5 s with the lineage fix
- **CPU, not disk.** OS disk reads are 0 MB and IO wait is 0 ms; data comes from the page
  cache. One read uses 6-7.4 of 8 cores, and three concurrent reads share the cores. The same
  query after the c9g → m8g node change uses 29% more CPU (24.0 s → 31.0 s).
- **Turn ids carry their start.** 30 days of Codex data hold 18,064 turns (about 600/day).
  Of these, 18,059 have UUIDv7 turn ids. The id's millisecond time is within 60 s of the turn's
  first span for all but 2. Median turn: 7 turn spans. Largest: 60,613.
- **Retention.** `otel_traces` and `otel_logs` move to cold storage after 45 days and are
  deleted after 90.

## Goals

- **Detail.** A Codex task detail reads its turn row, owner and same-conversation competitors
  from the rollup. Its span and completion reads cover the turn's own window, not the page.
  Target: the orchestrator turn above (lineage fix included) under 10 s.
- **List.** The Codex task list reads turn rows from the rollup instead of raw turn spans.
- **Agents.** The subagent lineage reads (`codexAgents.js`) read subagent conversations' turns
  from the rollup.
- **Parity.** Task rows, details and costs keep their meaning: the same linking rule
  (`linkCompletions`), the same completion source, and the same unavailable-not-zero rules.

## Non-goals and anti-goals

- **Non-goals:** Claude tasks, a typed span table, a v2 of `codex_cost_events_v1`, ClickHouse
  sizing.
- **Anti-goal:** a detail that disagrees with its list row.
- **Anti-goal:** a window the rollup does not cover read as empty.
- **Anti-goal:** an activation without raw/rollup verification.

## Approaches

- **A. Per-turn rollup, narrow detail reads (chosen).** Small table: one row per turn, merged
  from aggregate states. It serves list, detail and agents, and follows the existing typed-table
  procedure.
- **B. Typed span table.** Rejected: storage and work far larger. Once A narrows the span read
  to the turn's window, that read is cheap.
- **C. Turn-id time only.** Rejected: the id gives the start, not the end. Reads still had to
  run to the page end + 24h, about a 10% saving here.

## Design

### Table `codex_turns_v1` (migration 012)

`ReplicatedAggregatingMergeTree`, `PARTITION BY toYYYYMM(TurnHour)`,
`ORDER BY (UserIdentity, TurnHour, TurnId)`. TTL matches the raw tables: cold after 45 days,
delete after 90, `storage_policy = 'hot_cold'`.

| Column | Meaning |
|---|---|
| `TurnHour DateTime` | UTC hour of the turn id's UUIDv7 time. A non-v7 id uses the span's hour, so its spans may land in several rows. |
| `UserIdentity String` | The list's exact-user value: `coalesce(nullIf(UserEmail,''), nullIf(EndUserId,''), '')`. |
| `TurnId String` | `coalesce(nullIf(turn_id,''), turn.id)`. |
| `Conversations AggregateFunction(groupUniqArray, String)` | Non-empty `conversation.id` values. |
| `StartTs SimpleAggregateFunction(min, DateTime64(9))` | Earliest span start. |
| `EndTs SimpleAggregateFunction(max, DateTime64(9))` | Latest span start + Duration. |
| `SamplingSpans`, `LegacySpans AggregateFunction(uniqExact, UInt64)` | `cityHash64(TraceId, SpanId)` of `codex.sampling` / `run_sampling_request` spans. Counted per span id, as the raw read's `LIMIT 1 BY TraceId, SpanId` dedupes duplicate deliveries. |
| `SamplingModels`, `LegacyModels AggregateFunction(groupUniqArray, String)` | Non-empty model per kind (`model`, else `gen_ai.request.model`). |

- **Ingestion view.** A view on `otel_traces` takes Codex spans with a turn id (the raw read's
  `TURN_SPAN` filter).
- **Merge safety.** Every state merges safely when repeated, so a backfill may overlap the live
  view.
- **Read semantics.** A turn's row equals the raw `codexTurnSql` row:
  - conversation: the smallest of `Conversations`, deterministic (raw `anyIf` is not). No turn
    had two conversations in 30 days (2026-11-15). The detail accepts a turn whose
    `Conversations` contains the link's conversation, so a link minted from a raw `anyIf`
    choice still opens (builder's call).
  - `llm_calls`: sampling count if > 0, else legacy count.
  - models: from the same kind.

The rollup row is unclipped. Raw turn rows are clipped to the read range, so a turn running past
`to + 24h` shows its true end in the rollup.

### Subagent calls: known zero versus not collected (owner request, 2026-11-15)

Today the list always shows Codex subagents as not collected (`subagents: null`). The detail
shows zero links as not collected even when the turn made no spawn call.

- **Rollup columns:**
  - `SpawnCalls AggregateFunction(uniqExact, UInt64)`: span ids of the turn's spawn tools
    (`SPAWN_SPANS`: `collaborationspawn_agent`, `collaborationfollowup_task`,
    `multi_agent_v1spawn_agent`).
  - `NamesTurnOnTools SimpleAggregateFunction(max, UInt8)`: 1 when the span's Codex version
    names the turn on tool spans (0.166+). Parse `service.version` numerically, not as a string.
- **List:** a new "subagent calls" value per Codex task: the spawn-call count when
  `NamesTurnOnTools = 1`, else not collected. It is labelled as calls, not subagents. A
  follow-up to an existing agent is a call, not a new subagent conversation.
- **Detail:** `subagents` is a known 0 when `spawn_calls` is 0, the turn's spans were read
  complete (not truncated), and the turn names its turn on tool spans (0.166+, or a legacy call
  resolved by call id). Otherwise zero links stay not collected.

### Retries and compactions (owner request, 2026-11-15)

The detail claims "Codex has no retry evidence" and shows compactions as not collected. Both
are wrong. Turn-tagged spans carry both:

- **Retries.** `try_run_sampling_request` (one per attempt) and `run_sampling_request` (one
  per request) both carry `turn_id`. In 7 days of production, tries were never fewer than runs.
  33 of 1,961 turns had retries, 85 in all. Retries = tries - runs.
- **Compactions.** `codex.compaction` spans carry `turn.id`, from 0.163 on.

Changes:

- **Rollup columns:** `SamplingTries AggregateFunction(uniqExact, UInt64)` (try span ids) and
  `Compactions AggregateFunction(uniqExact, UInt64)` (compaction span ids).
- **Raw path:** `codexTurnSql` returns the same two counts from its existing scan, so the
  detail shows them before activation.
- **Detail:**
  - The "why" retries rule applies to Codex: retries known when the turn has run spans.
  - `context.compactions` becomes the count, not null.
  - A turn whose version emits neither span stays not collected.
- `codex.api_request` `attempt` is per request and has no turn id; it is not used here.

### `codex.agent_communication` fallback lineage (moved to a follow-up)

Moved out of this change by owner decision (2026-11-15); a later PR carries it. `codex.agent_communication`
logs are observed on 0.167.1-0.168.0 (`kind`, `state`, `sender_thread_id`, `receiver_thread_id`;
thread ids are conversation ids). Until then a turn without trace lineage keeps unknown
subagents, and a known zero rests on span evidence alone.

### Reads

- **Gate.** `CODEX_TURNS_READ_FROM` is a verified, hour-aligned UTC timestamp (Terraform
  `codex_turns_read_from`, compose/`.env`). Unset means today's raw path everywhere.
  Validation follows `parseTurnsReadFrom`.
- **List.** The rollup is used when `from - 7 days >= CODEX_TURNS_READ_FROM`; otherwise raw.
  - Bucket turns: start in `[from, to)`.
  - Context turns, for linking: rows with `TurnHour` in `[from - 7 days, to + 24h)`, start
    `< to + 24h`, and end + `COMPLETION_SLACK_MS` `>= from`.
  - A UUIDv7 turn with a row in that range also merges its id-hour row before the range (one
    keyed lookup), since spans starting over 7 days after the id keep their own hours. A turn
    running past its id + 7 days therefore keeps its true start: context on a later page, never
    a fragment task, and listed once in the bucket of its start. The detail and agents turn
    reads merge the same rows.
  - A non-v7 turn (no id hour), or a v7 turn whose first spans precede its id by over a day,
    that started before the lookback is read from its rows in the range only.
- **Detail.** The rollup is used when the task turn id is UUIDv7 and its time is
  `>= CODEX_TURNS_READ_FROM`; otherwise raw. With turn window `[s, e]`:
  - Turn row and owner: from the rollup by `TurnHour` (from the id) and `TurnId`. Without
    `userExact`, one owner is required, else 404, as `codexOwnerSql` does now.
  - Competitors: same-conversation turns with start in
    `[s, min(e + COMPLETION_SLACK_MS, to + 24h))`. Earlier turns cannot win a completion from a
    later-starting turn under `linkCompletions`.
  - Completions: conversation completions with `Timestamp` in `[max(s - 1h, from), to + 24h)`.
    Link time is `event.timestamp` else `Timestamp`, and collector time can lag by any amount
    (a buffering device collector), so the upper bound is the list's own: the list links every
    such completion it reads.
  - The upper bounds are clamped to the list's own reads (completions `[from, to + 24h)`,
    context turns starting before `to + 24h`). A detail therefore never links what its list row
    did not read, including on one-hour links (`linkWindow`).
  - Spans: the turn's spans with `Timestamp` in `[s - 1 min, min(e + 1 min, to + 24h))`,
    still `SPAN_BOUND`-capped.
  - Codex skill events (`codexSkillsSql`, added by #303): the same window as the spans.
  - The detail must still require `in_bucket` (start in the page's `[from, to)`).
- **Agents.** Subagent and parent conversations' turns come from the rollup, filtered by
  conversation, with `TurnHour` from the lineage start minus 7 days (the list lookback). A
  parent turn that started a day or more earlier therefore keeps its true start and stays a
  `containingTurn` candidate. This applies when that start minus 7 days
  `>= CODEX_TURNS_READ_FROM`; otherwise the current raw read runs.

### Migration, backfill, verify

Generated by a new `scripts/generate-codex-turns-schema.mjs`, the same way as
`generate-session-turns-schema.mjs`. No hand-edited SQL.

- **`clickhouse-migration-012.sql`:** guarded by ledger 004. Table, view, column-type check,
  ledger record.
- **`clickhouse-backfill-012.sql`:** bound `[backfillFrom, backfillTo)`, at most one day per
  call, repeatable.
- **`clickhouse-verify-012.sql`:** hour-aligned window, read-only. For turns with a row in
  the window, both sides group the same turn hours, `[verifyFrom, verifyTo + 8 days)`: rollup
  rows by `TurnHour`, raw spans by the same derived turn hour. A span keyed to an earlier id
  hour therefore never joins a later fragment's row (a v7 span past the id age has its own
  hour). Raw spans are read from `[verifyFrom - 1 day, verifyTo + 7 days)`: the id lead and
  age allowances of the turn hour rule, so every row in the window is compared whole. A turn
  is compared in each window holding one of its rows, over its rows from that window on.
  - A turn whose rollup end is at or after `verifyTo + 7 days` may have spans past the raw
    range. It is excluded from the comparison and reported as a count; it does not block.
  - Every other turn is compared on conversation set, start, end, both counts and both model
    sets. Any difference blocks activation, including a turn with two conversations.
  - A non-v7 turn is compared after grouping its hour rows by `TurnId`.
- **Also:** the replicated and local schema files, the schema contract build, the
  schema-lifecycle tests, `docs/runbooks/schema-migrations.md` (an "012" section in the
  migration-010 style), and `docs/api-reference.md` where read behavior is described.

### Rollout

The rollup is built on the lineage fix branch and ships in the same PR. The schema contract
(`infra/files/clickhouse-schema-contract.sql`) requires the ledger to equal its version list,
so migration 012 runs only from merged `main`.

1. Merge the PR with `CODEX_TURNS_READ_FROM` unset. Do not roll out the image yet: on the raw
   path the lineage fix pushes long-session details past the budget.
2. Migration 012 from `main` through one pod. The view starts filling; reads are unchanged.
3. Backfill the retained 90 days, one day per call.
4. Verify every backfilled hour.
5. Set `CODEX_TURNS_READ_FROM` to the verified start, together with the image rollout (release
   or explicitly accepted untagged deploy), per the runbooks.

Each production step needs the owner's go-ahead.

## Acceptance

- Unit tests cover the generator output, the gate, and list/detail/agents SQL. Both the rollup
  path and the raw path must keep today's tests.
- Read-only production check before activation: the rollup list for a 30-day page equals the
  raw list in task count and per-task calls, models and cost. The only exceptions are listed
  clipped-end turns.
- The orchestrator and subagent turn details above equal their raw values and run in under 10 s.

## Left to the builder

Exact SQL; state functions where the table above leaves a choice; test fixtures; the
verify query's shape. The owner decides when the 7-day list lookback is too short: it shows as
unattached completions near the bucket start.
