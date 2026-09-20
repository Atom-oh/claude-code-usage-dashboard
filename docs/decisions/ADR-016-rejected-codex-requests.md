# ADR-016: Keep rejected Codex attempts out of missing-usage coverage

Status: accepted, 2026-09-20.

## Context

The rolling one-day chart still broke where Codex emitted only HTTP 400 attempts.
No completion usage was present, but every unmatched request scope was classified
as missing usage. These explicit rejections need a different interpretation from
accepted requests whose completion telemetry is missing.

## Decision

- Recognize HTTP 400, 401, 403, 404, 413, 415, 422 and 429 request/error events without
  token fields as rejections. Status parsing is shared between SQL and detail logs.
- An identified scope containing only rejected attempts has zero recorded completion tokens
  and token-derived cost. Preserve request/error counts and expose `rejected_requests`.
  This is not a billing guarantee or reconstructed usage.
- Preserve session/user/backend/project/model scope boundaries. Accepted or uncertain
  requests, timeouts, server errors, token-bearing error records and other evidence
  without completion usage retain the existing unknown/partial behavior.
- Compact non-exempt Codex evidence (including intermediate streams, WebSocket
  requests, token hints and unknown events) by scope in the same table read.
  Evaluate rejection eligibility before removing those markers from shared results.
  Detail markers retain model identities in one per-session marker, preserving
  the result-row budget; model-less evidence remains conservative
  session evidence. Anonymous requests do not qualify for the zero exemption.
- Keep model-less attribution restricted to the original supported request/usage
  events. Startup model settings do not establish attribution for tool records.
- Shared and detail views use this rule. Detail metadata and stream-scope safeguards
  remain; ratios requiring completed usage do not acquire fabricated denominators.
- Conversation-start, startup-phase and prompt-intent metadata without token fields
  do not imply accepted usage in an otherwise rejection-only identified session.
  Unrelated sessions, unknown events and operational/stream evidence remain guarded.
- `request_rejections_only` identifies shared Codex groups containing only rejected
  request records. Zero chart tooltips disclose the rejected count.
- Model pricing, routing validation, collection and model selection are unchanged.
  Unpriced completions retain null costs even when their tokens are known.

This narrows the missing-usage rule in [ADR-014](ADR-014-observed-token-subtotals.md)
and complements the recorded-zero display policy in [ADR-015](ADR-015-idle-chart-buckets.md).
Successful responses without usable telemetry remain distinguishable from idle or
rejected-only periods. No schema or Collector change is required.
