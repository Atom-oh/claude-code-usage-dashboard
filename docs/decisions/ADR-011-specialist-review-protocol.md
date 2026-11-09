# ADR-011: Specialist review protocol

## Status

Accepted 2026-09-13. `ROLE_REVIEW=1` activates specialist responsibilities and
retains the project input, runner, coverage and publication safeguards.
Active in CI following the 2026-11-04 full-coverage amendment below.

## Decision

Assign distinct responsibilities to the supported model pool instead of repeating
every lens. Codex uses GPT-6 Astra, Kiro uses Opus 5 and GPT-5.6 Sol, and the Claude
role uses Fable 5.1. Require complete, immutable-scope reports and independent
OpenAI/Anthropic primary coverage. Only trusted routing can mark a role inactive.
Use random-nonce input boundaries and bind invocation nonces into result digests.

A complete report without blocking candidates or uncertainty may receive a
deterministic summary. A chair adjudicates substantive candidates, but cannot
waive missing or invalid coverage. Preserve existing project input exclusions,
secret/state custody, context and budgets. No quota or billing limits are raised.
Review instructions and output are English to avoid duplicate translations.

This supersedes the repeated model-by-lens matrix, permissive dropout floor and
unconditional chair call. Existing security, source-custody, context, ownership
and budget decisions remain in force.
See [the module contract](../../scripts/pr-review/README.md) for current interfaces
and offline checks. Model access and production execution require separate evidence.

Sol intentionally replaces the legacy Terra review slot for fleet consistency;
application inference model configuration remains unchanged.

A scope containing only files excluded by the existing, base-approved project
input policy may complete as NOT_APPLICABLE with a PASS gate result. The trusted
collector must account for every path and record the policy hash; the report
identifies excluded paths and claims no model review. Any reviewable source,
unknown exclusion, source omission or failed collector remains blocking. New
exclusions require their own reviewed policy change.

## Amendment 2026-11-04 — Codex lens panel and Claude chair

Owner decision 2026-11-04: CI sets `ROLE_REVIEW: "0"` and runs the Codex lens panel ->
Claude chair path, the same shape as the owner's other repositories, because the specialist
review duplicated work and was slow. `ROLE_REVIEW=1` re-enables the retained specialist
protocol; its code and tests stay in place, inactive.

1. Panel: `scripts/pr-review/run-panel.sh` runs one Codex cell per lens in parallel (L2 data/query
   correctness, L3 security, L4 frontend correctness, L5 documentation and infrastructure
   consistency) with `PANEL_MODEL` (default `global.openai.gpt-6.1-sol`) and
   `PANEL_TIMEOUT`/`PANEL_RETRIES`. Each attempt runs in a fresh cell (empty HOME, CODEX_HOME,
   cwd and TMPDIR outside the checkout) with a generated config that disables Codex's shell,
   exec and other tool features, an environment limited to the region and Pod Identity/IRSA
   credential handles, and a JSON-event tripwire that discards any cell that used a tool.
2. Fail-closed coverage: every lens L2-L5 needs a successful Codex cell. Otherwise
   `coverage-severe.flag` is written and synthesis replaces the chair verdict with
   `VERDICT: FAIL`. Missing or failed review is never approval.
3. Chair: `scripts/pr-review/synthesize.sh` runs Claude `global.anthropic.claude-opus-5-5`
   (fallback `global.anthropic.claude-opus-5`) tool-less in its own empty HOME/cwd with the
   same environment allowlist. It reviews the diff itself as the second independent reviewer, adjudicates
   the Codex findings and must end with exactly `VERDICT: PASS` or `VERDICT: FAIL`.
4. Diff custody and limits: the diff is built from the pinned merge base and HEAD with the
   `scripts/pr-review/role-input-scope.json` exclusions; a sha256 check confirms the chair sees
   the bytes the panel reviewed. Diffs over 12,000 lines or 512,000 bytes are blocked, never
   truncated; the specialist limits were Kiro's command-line bound, which stdin-fed reviewers
   with 1M-token windows do not share.
5. Removed: Kiro cells, `scripts/pr-review/agents/pr-review-notools.json`, the Kiro preflight
   canary, quota and agent-fallback detection, the diff-truncation flag and their banners.

The published comment's Status badge and footer contract is unchanged.

Known gaps (accepted): one panel model family (OpenAI) plus the Anthropic chair, so
cross-family checking rests on the chair; both processes still hold the shared runner role's
credentials, because Bedrock-scoped short-lived credentials need a runner-platform IAM change
(see the [runbook](../runbooks/pr-review-panel.md#credential-exposure-and-residual-risk)).

## Amendment 2026-11-04 — Restore independent full-scope review

The owner requires `ROLE_REVIEW=1`: Codex and Claude independently review the
complete change, and trusted routing requires Kiro for applicable AWS and operations
changes. Missing required output blocks. This supersedes the preceding CI selection
and coverage amendment. The production scope has no path exclusions; binary content
and oversized input block instead of producing a partial pass. Existing safety,
credential isolation, timeouts and SHA-bound publication remain in force.

## Clarification 2026-11-09 — Input budget evidence

The 512,000-byte / 12,000-line guard is repository policy, not a documented
headless or model maximum. Its introduction has no recorded sizing experiment
or provider derivation. Published context windows, CLI transport limits and
account quotas use distinct scopes and units; none establishes this exact guard.
This clarification retains existing enforcement and coverage requirements.
Budget changes require dated evidence for the selected runner, model and
provider, complete framed token/output accounting and boundary validation.
See [limit evidence and update rules](../reference/pr-review-headless-limits.md).
