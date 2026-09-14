# Selectable coding-client observability

The accepted scope adds Claude-only, Codex-only and combined collection/views through
`CLAUDE_ENABLED` (default true) and `CODEX_ENABLED` (default false). Both false is invalid.
`CODEX_BEDROCK_ENDPOINT` selects Mantle or Runtime. Codex is a distinct emitting client;
Claude's bedrock/enterprise channels remain inside its detail pages.

Acceptance requires matching activation across bootstrap, Collector, authenticated API
and SPA; consistent totals and breakdowns; nulls for missing measurements; and retained
Claude reported-cost diagnostics. Codex estimates use AWS model rates with cache subsets
and per-request context/inference tiers. No invoice equality, causal ROI, production
rollout, IAM/billing changes or credential creation is implied.

Canonical details are owned by [data contracts](../../reference/data.md),
[API contracts](../../api-reference.md), [metric definitions](../../metrics.md) and the
[operator runbook](../../runbooks/codex-telemetry.md). See [ADR-012](../../decisions/ADR-012-selectable-client-observability.md)
for the decision and [implementation record](../plans/2026-09-14-client-observability.md)
for validation. Keep those owners current instead of duplicating their contracts here.
