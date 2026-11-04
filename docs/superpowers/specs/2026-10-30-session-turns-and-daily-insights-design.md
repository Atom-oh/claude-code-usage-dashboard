# Session turns, cost per turn, and daily AI insights on Overview

Status: approved by the user 2026-10-30 (turn = one user prompt; daily generation;
DynamoDB storage). Claude Code detail Overview only; Codex views are unchanged.

## 1. Session turns and cost per turn (PR 1)

**Definitions.** A *turn* is one Claude Code `user_prompt` log event. A session's cost is
its known reported cost (ADR-013 known subtotal, ADR-017 non-Anthropic estimate) from the
existing counter path (`incFlat` rows carry `SessionId`). *Model calls per turn* =
`api_request` events / `user_prompt` events in the same session.

**Coverage rules (ADR-013/014).** Turns come from logs (90-day retention), costs from
counters (180 days). Ratios use only sessions with both a usable cost and ≥1 observed
prompt; others are counted and disclosed (`sessions_without_turns`,
`sessions_cost_unavailable`), never treated as zero. Partial cost subtotals carry
`cost_partial`. Duplicate log deliveries are deduplicated per (`session.id`, `prompt.id`)
when `prompt.id` is present, else by (`session.id`, `event.sequence`).

**API.** `GET /api/overview/session-turns` (shared `route()` wrapping, bound params,
existing range/filter semantics; unknown-channel policy = the existing A/B default):

```json
{ "summary": { "sessions": 0, "sessions_with_turns": 0, "turns": 0,
    "median_turns_per_session": 0, "p90_turns_per_session": 0,
    "known_cost": 0, "cost_partial": false, "cost_per_turn": 0,
    "model_calls_per_turn": 0, "sessions_without_turns": 0, "sessions_cost_unavailable": 0 },
  "users": [ { "user": "", "sessions": 0, "turns": 0, "known_cost": 0,
    "cost_partial": false, "cost_per_turn": 0, "cost_per_session": 0 } ],
  "sessions": [ { "session": "", "user": "", "group": "", "started": "", "turns": 0,
    "model_calls": 0, "known_cost": 0, "cost_partial": false, "cost_per_turn": 0 } ] }
```

`users`: top 20 by known cost; `sessions`: top 20 by known cost. Null where unavailable.

**Web.** Overview card titled "session and turn cost" (Korean UI label): stat tiles
(turns per session median/p90, cost per turn, model calls per turn), top users table (user
masked per PII rules, sessions, turns, cost per turn, cost per session, cost status), top
sessions table. CSV follows displayed
columns. Help text states the definitions and that heavy turns are not a quality signal.

## 2. Daily AI insights with Haiku 5.5 (PR 2, stacked on PR 1)

**Generation.** Once per UTC day for the previous UTC day (`period = YYYY-MM-DD`). Each API
pod runs a light scheduler (check every 10 min after 00:30 UTC). Exactly one generation
per period: a conditional `PutItem` lease item (`pk = "lease#<period>"`,
`attribute_not_exists`, expires after 15 min) before calling the model; the result item
(`pk = "daily#<period>"`) is written with `attribute_not_exists`. A failed generation
releases nothing; the lease expiry allows a later retry; at most 3 attempts per period.

**Model input.** Aggregates only — never prompt text, code, file paths or tool inputs:
org totals for the period and the 7-day baseline (cost, sessions, turns, cost per turn,
model mix), and the top 10 users by known cost with sessions, turns, cost per turn, model
mix, top tools, and change vs their 7-day baseline. Users are pseudonymized as `U1..U10`
before the call; the server maps pseudonyms back only when serving the stored result.

**Model call.** Bedrock Converse, `INSIGHTS_MODEL_ID` (default
`global.anthropic.claude-haiku-5-5`), temperature 0.2, max 1,200 output tokens, region as
the chat client. The system prompt requires strict JSON:
`{ "summary": string, "findings": [{ "user": "U1"|null, "title": string,
"detail": string, "metric": string }] (≤ 6), "caveats": [string] }`, Korean text, and
forbids productivity/ROI/causality claims (AGENTS.md). The response is validated
(schema, lengths ≤ 600 chars per field, pseudonyms limited to the provided set); invalid
output counts as a failed attempt. Token usage and the estimated cost of the call are
stored with the item.

**Storage.** New DynamoDB table `${namespace}-ccdash-insights` (PAY_PER_REQUEST, `pk`
string hash key, TTL `purgeAt` = period + 90 days, SSE, deletion protection), created only
when `insights_enabled = true`. IRSA policy: `GetItem`, `PutItem`, `Query` on that table;
`bedrock:InvokeModel` on the Haiku foundation model and its inference profile (same
pattern as `infra/bedrock.tf`). Env: `INSIGHTS_ENABLED`, `INSIGHTS_TABLE`,
`INSIGHTS_MODEL_ID`. Disabled or misconfigured → the endpoint returns
`{ "enabled": false }` and the scheduler does not run (startup does not fail).

**API.** `GET /api/insights/daily?period=YYYY-MM-DD` (default latest available, max 7
periods listed): `{ enabled, period, generatedAt, model, summary, findings[{user,…}],
caveats, usage: {inputTokens, outputTokens, estimatedCostUsd}, available: [periods] }`
or `{ enabled: true, period, status: "pending" | "failed" }`.

**Web.** Overview card titled "AI insights (Haiku 5.5, daily)" (Korean UI label): period selector (last 7),
summary, findings list (user masked by the existing UI PII masking), caveats, generated
time, and a fixed disclaimer: AI-generated from aggregate telemetry; not a productivity
or performance evaluation. Text is rendered as plain text (no Markdown/HTML).

## Non-goals and limits

- No per-prompt content analysis; no hourly generation; no manual regenerate endpoint.
- Insights are model output and may be wrong; numbers shown in the card come from the
  stored aggregates, not from the model text.
- Cost: ~one Haiku call per day (≈ $0.002); DynamoDB on-demand pennies per month.

## Implementation notes (PR 1)

- Deduplication refines the key above: turns use `prompt.id`; without it `event.sequence`
  plus the event timestamp (a resumed process can restart the sequence); without either the
  exact record (timestamp and attribute map). Model calls never use `prompt.id`, which is
  shared by every request of a turn.
- The model filter selects sessions that used a matching model and keeps each session's
  whole cost and turns. `started` is the first in-window prompt or model-call event.
- Median/p90 cover sessions with at least one turn. `cost_partial` also marks sessions
  excluded for an unavailable cost. Contract details: `docs/metrics.md#session-turns`.

## Tests

- PR 1: query unit tests (dedup, sessions without turns, partial cost, ratios exclude
  unavailable), SQL integration through the existing disposable-ClickHouse harness where
  available, route test, web render/CSV tests.
- PR 2: scheduler/lease (single generation across two simulated pods, retry after lease
  expiry, max attempts), pseudonymization round-trip and no raw emails in the model
  request, response validation (bad JSON, unknown pseudonym, oversize), disabled config,
  route, web render (pending/failed/disabled/data), Terraform validate.
- Each PR must stay under the review CI limits (95,000 diff bytes, 3,000 lines,
  22,000-byte specialist prompts).
