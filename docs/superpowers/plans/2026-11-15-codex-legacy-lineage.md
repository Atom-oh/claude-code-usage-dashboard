# Codex legacy subagent lineage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link Codex subagent turns for Codex before 0.166, whose lineage spans carry no
`turn.id`/`conversation.id`.

**Architecture:** `codexAgents.js` gains a resolution pass between the lineage read and
`walkLineage`. Spawn/follow-up spans without a turn are resolved from their `call_id`'s
`codex.tool_result` log (parent conversation) plus the conversation turn containing the log
time (parent turn). Child turns without a `run_turn` conversation are resolved from their own
turn spans. The 0.166+ path keeps its current reads.

**Tech Stack:** Node 22 ESM, `node:test`, ClickHouse SQL with bound parameters.

**Spec:** `docs/superpowers/specs/2026-11-15-codex-legacy-lineage-design.md`

## Global Constraints

- A 0.166+ detail (every spawn span has a turn) issues exactly today's reads: one lineage read,
  one turn read, at most one completion read.
- Every read filters the exact owner (`EXACT_USER` / `{userExact:String}`) with bound
  parameters; no call id, trace id or tool argument leaves the API.
- An unresolvable edge stays unlinked (counted in `unlinked_calls`), never guessed.
- Existing limits (`AGENT_DEPTH`, `AGENT_LIMIT`, `LINEAGE_SPAN_LIMIT`, `CODEX_TURN_LIMIT`,
  `CODEX_COMPLETION_LIMIT`) still set `limited` when exceeded.

## Review Focus

- A call log whose time falls in no turn of its conversation (clock skew past the slack): edge
  dropped, call counted unlinked.
- Two turns of the conversation overlapping the call time: the latest turn starting at or
  before the call wins.
- Mixed traces (some spawn spans with turns, some without): both kinds link in one walk.
- Legacy task turn that is itself a subagent: the parent link appears, with the parent's start.
- Legacy spawn calls of the task turn: `spawn_calls`/`unlinked_calls` count them even though the
  detail's own span read cannot see them (no turn id).

---

### Task 1: Pure legacy resolution in `codexAgents.js`

**Files:**
- Modify: `dashboard/server/codexAgents.js`
- Test: `dashboard/server/codexAgents.test.js`

**Interfaces:**
- Produces:
  - `codexLineageSql` also selects `SpanAttributes['call_id'] AS call_id`.
  - `export const LEGACY_CALL_SLACK_MS = 1000;`
  - `export function legacyNeeds(rows) -> { callIds: string[], childTurns: string[] }` —
    `callIds`: `call_id` of SPAWN_SPANS rows with empty `turn` and a `call_id` matching
    `/^[A-Za-z0-9_-]{1,128}$/`; `childTurns`: `session_task.turn` turns (TURN_ID) with no
    `run_turn` row carrying a conversation for that turn. Both deduped, sorted.
  - `export function codexCallLogSql(owner, callIds, startMs, endMs) -> { sql, params }` —
    `otel_logs`, `PREWHERE` time in `[startMs - LINEAGE_LEAD_MS, endMs + SPAN_SLACK_MS)`,
    `EventName = 'codex.tool_result'`, `EXACT_USER`; `WHERE LogAttributes['call_id'] IN
    {callIds:Array(String)}`; returns `call_id, conversation, at_ms`
    (`coalesce(parseDateTime64BestEffortOrNull(event.timestamp), Timestamp)` in ms is fine; use
    `Timestamp` if simpler); `LIMIT 1 BY call_id`.
  - `export function codexTurnConversationSql(owner, turnIds, startMs, endMs) -> { sql, params }`
    — `otel_traces`, same window/owner PREWHERE, `TURN_SPAN` turn id `IN {turnIds:Array(String)}`
    and `SpanAttributes['conversation.id'] != ''`; `GROUP BY turn_id`, returns
    `turn_id, any(conversation) AS conversation`.
  - `export function containingTurn(turns, conversation, atMs) -> turnRow | null` — among
    `turns` (codexTurnSql rows) of `conversation` with `start_ms - LEGACY_CALL_SLACK_MS <= atMs
    <= end_ms + LEGACY_CALL_SLACK_MS`, the one with the latest `start_ms <= atMs`, else the
    earliest; none → null.
  - `export function resolveLegacy(rows, callLogs, turnConversations, turns) -> { rows, conversations }`
    — returns new rows where each unresolved SPAWN_SPANS row with a matching call log gets
    `conversation` = log conversation and `turn` = `containingTurn(...)?.turn_id` (left empty
    when null), and `conversations: Map(turn_id → conversation)` from `turnConversations`.
  - `walkLineage(rows, turnId, conversations = new Map())` — child conversation falls back to
    `conversations.get(child_turn)` when no `run_turn` names one.

- [ ] **Step 1: Write the failing tests** (add a `legacy` chain helper: like `chain` but the tool
  span has `turn: ""`, `conversation: ""`, `call_id: "call_<tag>"`, and no `run_turn` row)

```js
test("legacy spans need their call logs and child conversations", () => {
  const rows = [...legacyChain("t", 1, C1), ...chain("t", 2, P, C2, "sub2")];
  assert.deepEqual(legacyNeeds(rows), { callIds: ["call_1"], childTurns: [C1] });
  assert.deepEqual(legacyNeeds(chain("t", 3, P, C2, "sub2")), { callIds: [], childTurns: [] });
});

test("call log and turn-conversation SQL bind the owner, ids and lineage window", () => {
  const a = codexCallLogSql("kim@x.com", ["call_1"], ms("2026-11-05T01:00:00Z"), ms("2026-11-05T02:00:00Z"));
  assert.ok(a.sql.includes("EventName = 'codex.tool_result'") && a.sql.includes("{callIds:Array(String)}"));
  assert.ok(a.sql.includes("LIMIT 1 BY call_id") && !a.sql.includes("kim@x.com") && !a.sql.includes("call_1"));
  assert.deepEqual(a.params, { spanFrom: "2026-11-05 00:50:00", spanTo: "2026-11-06 02:00:00", userExact: "kim@x.com", callIds: ["call_1"] });
  const b = codexTurnConversationSql("kim@x.com", [C1], ms("2026-11-05T01:00:00Z"), ms("2026-11-05T02:00:00Z"));
  assert.ok(b.sql.includes("{turnIds:Array(String)}") && b.sql.includes("GROUP BY turn_id"));
  assert.deepEqual(b.params.turnIds, [C1]);
});

test("the containing turn of a call is the latest turn of its conversation started by then", () => {
  const turns = [turn("up", uuid(7), "2026-11-05T00:00:00Z", { end_ms: String(ms("2026-11-05T02:00:00Z")) }),
    turn("up", uuid(8), "2026-11-05T01:00:00Z"), turn("other", uuid(9), "2026-11-05T00:30:00Z")];
  assert.equal(containingTurn(turns, "up", ms("2026-11-05T01:00:05Z")).turn_id, uuid(8));
  assert.equal(containingTurn(turns, "up", ms("2026-11-05T01:30:00Z")).turn_id, uuid(7));
  assert.equal(containingTurn(turns, "up", ms("2026-11-05T00:00:00Z") - LEGACY_CALL_SLACK_MS).turn_id, uuid(7));
  assert.equal(containingTurn(turns, "up", ms("2026-11-05T03:00:00Z")), null);
  assert.equal(containingTurn(turns, "nope", ms("2026-11-05T01:00:05Z")), null);
});

test("resolved legacy spans link like 0.166 spans, and unresolved ones stay unlinked", () => {
  const rows = [...legacyChain("t", 1, C1), ...legacyChain("t", 2, C2), ...chain("t", 3, P, G1, "sub3")];
  const turns = [turn("root", P, "2026-11-05T01:00:00Z")];
  const logs = [{ call_id: "call_1", conversation: "root", at_ms: String(ms("2026-11-05T01:00:01Z")) },
    { call_id: "call_2", conversation: "root", at_ms: String(ms("2026-11-05T05:00:00Z")) }];
  const resolved = resolveLegacy(rows, logs, [{ turn_id: C1, conversation: "sub1" }], turns);
  const { links } = walkLineage(resolved.rows, P, resolved.conversations);
  assert.deepEqual(links.map(l => [l.child_turn, l.child_conversation, l.parent_conversation]).sort(),
    [[C1, "sub1", "root"], [G1, "sub3", "root"]].sort());
  assert.equal(walkLineage(resolved.rows, C1, resolved.conversations).parent.parent_turn, P);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd dashboard/server && node --test codexAgents.test.js`
Expected: FAIL (`legacyNeeds` / `codexCallLogSql` … not exported).

- [ ] **Step 3: Implement the Interfaces above in `codexAgents.js`**; extend the top-of-file
  comment with the pre-0.166 path in two or three lines.

- [ ] **Step 4: Run to verify they pass**

Run: `cd dashboard/server && node --test codexAgents.test.js`
Expected: all pass, including the existing tests (lineage SQL test still passes with `call_id` added).

- [ ] **Step 5: Commit** `fix(tasks): resolve pre-0.166 Codex lineage spans by call id`

### Task 2: Wire resolution into `codexAgents`, docs and CHANGELOG

**Files:**
- Modify: `dashboard/server/codexAgents.js` (`codexAgents`)
- Modify: `docs/reference/codex-observability.md:77`, `CHANGELOG.md` (Unreleased → Fixed)
- Test: `dashboard/server/codexAgents.test.js`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `codexAgents(owner, turn, task, spawnSpanIds, opts)` unchanged signature. When
  `legacyNeeds` is non-empty:
  1. run `codexCallLogSql` (if `callIds`) and `codexTurnConversationSql` (if `childTurns`) in parallel;
  2. run one `codexTurnSql(from, to, q, { conversationIds })` over the sorted union of call-log
     conversations, resolved child conversations and `run_turn` conversations (IDENT-valid);
  3. `resolveLegacy`, `walkLineage(rows, turnId, conversations)`;
  4. completions for linked child conversations; a second turn read only for linked/parent
     conversations missing from step 2.
  `spawnSpanIds` (when not null) becomes the union with resolved legacy SPAWN_SPANS span ids
  whose resolved `turn === turn.turnId`.

- [ ] **Step 1: Write the failing tests**

```js
test("a legacy turn links its subagents through call logs with one turn read", async () => {
  const seen = [];
  const run = async (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes("op.dispatch")) return legacyChain("t", 1, C1);
    if (sql.includes("codex.tool_result")) return [{ call_id: "call_1", conversation: "root", at_ms: String(ms("2026-11-05T01:00:01Z")) }];
    if (sql.includes("{turnIds:Array(String)}")) return [{ turn_id: C1, conversation: "sub1" }];
    if (sql.includes("GROUP BY turn_id")) return [turn("root", P, "2026-11-05T01:00:00Z"), turn("sub1", C1, "2026-11-05T01:00:02Z")];
    if (sql.includes("otel_logs")) return [completion("sub1", "2026-11-05T01:00:05Z")];
    throw new Error("unexpected SQL");
  };
  const turnInfo = { turnId: P, startMs: ms("2026-11-05T01:00:00Z"), endMs: ms("2026-11-05T01:00:10Z"), traceIds: ["t"] };
  const out = await codexAgents("kim@x.com", turnInfo, rootTask, [], { from, to, run, prices: DEFAULT_CODEX_PRICING });
  assert.deepEqual(out.children.map(c => [c.id, c.depth]), [[`codex:sub1:${C1}`, 1]]);
  assert.deepEqual([out.spawn_calls, out.unlinked_calls], [1, 0]);
  assert.ok(Math.abs(out.children[0].cost_usd - unitCost) < 1e-12);
  assert.equal(seen.filter(s => s.sql.includes("GROUP BY turn_id") && !s.sql.includes("{turnIds")).length, 1);
  assert.ok(seen.every(s => s.params.userExact === "kim@x.com"));
});

test("a legacy subagent turn gets its parent link from its call log", async () => { /* task turn = C1,
  legacyChain("t", 1, C1) whose call log names "root" at a time inside turn P: out.parent.id === `codex:root:${P}` */ });

test("a 0.166 detail issues no legacy reads", async () => { /* reuse the existing "one lineage read" fixture;
  assert no SQL contains "codex.tool_result" or "{turnIds:Array(String)}" */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd dashboard/server && node --test codexAgents.test.js`
Expected: the two legacy tests FAIL (no children / no parent).

- [ ] **Step 3: Implement the read sequence in `codexAgents`**; update the observability row
  (attributes on `collaboration<tool>`/`run_turn` from Codex 0.166; earlier versions resolve
  the parent through the call's `codex.tool_result` log) and add a CHANGELOG Fixed entry.

- [ ] **Step 4: Run the full checks**

Run: `(cd dashboard/server && npm test)`, `(cd dashboard/web && npm test && npm run build)`,
`bash tests/run-all.sh` — each to a log file under the scratchpad, then grep for failures.
Expected: all pass.

- [ ] **Step 5: Production read-only check.** Per the `clickhouse-investigate` skill
  (port-forward, reader password in an env var only, killed afterwards), run a scratchpad
  script that calls the branch's `userTaskDetail` with a ClickHouse `run` for range
  2026-10-16..2026-11-15 on:
  - `codex:<subagent-conversation>:<subagent-turn>` →
    expected `agents.parent.id` = `codex:<orchestrator-conversation>:<orchestrator-turn>`,
    `parent.tool` = `followup_task`, no children;
  - the parent turn `codex:<orchestrator-conversation>:<orchestrator-turn>` → expected `children` includes the `<subagent-turn>`
    turn and `spawn_calls` > 0; report the detail's wall time.

- [ ] **Step 6: Commit** `fix(tasks): link Codex subagent turns before Codex 0.166`
