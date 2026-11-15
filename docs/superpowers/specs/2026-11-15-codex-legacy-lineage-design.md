# Codex subagent lineage for Codex before 0.166

Status: approach approved by the owner (2026-11-15). Short design.

## Intent

#302 links a Codex turn to its subagent turns through the trace. It reads the parent turn and
conversation from `turn.id`/`conversation.id` on the `collaboration<tool>` span, and the child
conversation from `run_turn`. Codex emits those attributes only from 0.166.0 (app-server, cli
and exec alike). On 0.160-0.165 (production data 2026-10-16 to 10-29) every lineage edge is
dropped, so task details from that period show no parent and no subagent turns.

## Evidence (production, read-only, 2026-11-15)

- Per version, 30 days: `collaboration*` and `run_turn` spans carry `turn.id` and
  `conversation.id` on 0 rows before 0.166.0 and on every row from 0.166.0.
- On 0.163.0 the `collaboration<tool>` span has `call_id` and `tool_name` only; the chain
  `session_task.turn <- op.dispatch.inter_agent_communication <- dispatch_tool_call_with_state
  <- collaboration<tool>` is intact, and `session_task.turn` carries `turn.id`.
- 2026-10-16 to 10-30: every `collaborationfollowup_task` (1,405) and `collaborationspawn_agent`
  (130) span without a turn id has a `codex.tool_result` log with the same `call_id`, and that
  log carries the calling `conversation.id` (100%).
- Sample turn `<subagent-turn>` (conversation `<subagent-conversation>`): its starting `followup_task` call logs
  conversation `<orchestrator-conversation>`. The only turn of that conversation whose span window contains the
  call is `<orchestrator-turn>`, which is also the `turn_id` on the call's ancestor `try_run_sampling_request`.

## Decision

Keep the 0.166+ path unchanged. When a spawn/follow-up span has no turn id:

1. **Parent conversation:** the `codex.tool_result` log with the span's `call_id` (same owner,
   lineage window).
2. **Parent turn:** the turn of that conversation whose span window contains the log time. A
   conversation runs one turn at a time. No containing turn means the edge stays unlinked.
3. **Child conversation** (when `run_turn` has none): the conversation on the child turn's own
   turn spans, read by turn id.

The task's own spawn count (`spawn_calls`) uses the same resolution, so pre-0.166 turns report
linked and unlinked calls as newer turns do.

## Approaches

- **call_id join through tool_result logs (chosen).** One bounded log read keyed by call ids;
  exact for every observed span.
- **Walk the span ancestors to `try_run_sampling_request.turn_id`.** Rejected: five hops through
  very large span names (`handle_responses` is ~1M rows in one app-server trace).
- **Show "not supported by this Codex version".** Rejected by the owner: the data to link exists.

## Constraints

- Detail latency: extra reads run only when such spans exist; a 0.166+ detail issues the same
  queries as today.
- No trace id, call id or tool argument leaves the API. Existing bounds (`AGENT_DEPTH`,
  `AGENT_LIMIT`, span/turn/completion limits) still apply and set `limited`.
- Zero links stay unknown, never "no subagents".

## Left to the builder

Query shapes, the containment slack (sub-second clock differences), and test fixtures.
Update `docs/reference/codex-observability.md` (attribute availability by version) and add a
CHANGELOG Unreleased Fixed entry.
