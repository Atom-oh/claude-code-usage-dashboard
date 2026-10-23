# Codex completion metrics implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` for inline implementation.

**Goal:** Show explicitly scoped Codex completion metrics without weakening whole-window completeness.

**Architecture:** Extend the existing single log aggregation with identified-completion
cost/session statistics. Add a separate `completion_usage` response object and
whole-window `completeness` reasons. Keep existing summary fields unchanged.
Render the new cohort as the primary detail and retain whole-window units in an
expandable section.

**Tech stack:** Existing ClickHouse SQL, Express ESM and React.

**Spec:** User-approved conversation: completion-based ratios and tokens,
cost per usage-bearing identified session, and explanatory missingness labels.
The latest request authorizes code changes only.

## Constraints

- Preserve ADR-013/014 whole-window fields and unknown-versus-zero behavior.
- Token rates use strictly validated canonical components within the completion
  cohort, never `observed_tokens` as a fallback.
- Session cost numerator and denominator both exclude unidentified completions.
- Preserve filters, full-identity deduplication, pricing and aggregate row limits.
- No additional queries, schema changes, collection or infrastructure.
- Do not add/run tests, commit, publish or deploy in this code-only step.
- Preserve the unrelated proposed SSO enrollment design.

## Review focus

- Unknown pricing, zero denominators and overflow remain unavailable or partial.
- Invalid cache metadata does not erase independently valid reasoning ratios.
- Missing/limited whole-window scopes do not invalidate the separate completion
  cohort; a limited usage family invalidates the cohort itself.
- Anonymous completions cannot contribute costs to identified-session averages.
- Old API payloads retain their existing display; no session/user identifiers
  enter the new response.

## Tasks

- [x] Add `codexCompletionUsage.js` to format the separate cohort using canonical
  sums and matched session sums.
- [x] Extend `codexLogAggregates.js` with usage-family identified-session count,
  identified-completion count, priced/unpriced counts and known cost subtotal.
- [x] Keep the raw fold in `codexInsightsLogs.js` aligned as the existing regression
  oracle; expose identical new metadata without altering the old summary.
- [x] Add `CodexEfficiency.jsx`; label completion denominators explicitly,
  retain expandable whole-window units, and explain missingness.
- [x] Update API/interpretation documentation without live customer data.
- [x] Obtain a read-only code review; resolve correctness issues.
- [x] Transfer reviewed code changes to the original workspace and remove only
  the temporary worktree. Report that tests and deployment were not performed.

## Validation scope

Implementation and read-only review only. No test additions, test execution,
application builds, commits, publication or deployment are included in this step.
`git diff --check` passed for the tracked patch; this establishes whitespace
consistency only, not executable correctness or live behavior.

An independent read-only review found one invalid-cache-subset edge case.
Cohort-only SQL/raw sums now validate each cache subset before aggregation,
preserving the original summary/Effort values. A follow-up source review found
no remaining substantive issues. Runtime and regression verification remain
unperformed.

All eight changed/new files were copied to the original workspace and compared
byte for byte before removing the temporary worktree. The unrelated SSO
enrollment specification was preserved.
