# Scoped AWS specialist review

The user requested Kiro review of AWS architecture and resources, with Codex and
Claude retaining independent review of the complete change. This supersedes the
conservative routing of unrelated application changes to Kiro.

## Design

Trusted base code projects complete file patches for infrastructure, resource
definitions, architecture documents and AWS deployment procedures. Kiro receives
only this projection. Codex and Claude receive the complete pinned merge-base
diff, including the AWS projection. Routing considers removed content and source
paths so deletion and renaming do not hide infrastructure changes.

Each request binds the complete change hash and its own projection hash, expected
paths and HEAD. Validation reconstructs the projection from the canonical full
diff; a caller cannot replace a required scope with an arbitrary subset.
Unrelated application changes deactivate Kiro deterministically.

Codex and Claude use the existing workflow's 512,000-byte / 12,000-line full-diff
budget. The subsequent user instruction selects Kiro V3 and chair summaries above
its direct 95,000-byte / 3,000-line budget. A shared hash-bound packet accounts for
every metadata/hunk unit and fits 64,000 bytes; the full Kiro stdin request stays
below 120,000 bytes. Full-change reviewers retain raw input below their separate
640,000-byte request budget. Invalid or incomplete summary input blocks; no scope
is truncated. Existing
no-tools checks, credential isolation, preflight barriers and latest-HEAD
publication remain required.

## Implementation

- [x] Add failing tests for mixed scope, application-only changes, deletion/rename,
  transport budgets, canonical scope tampering and missing required AWS coverage.
- [x] Implement deterministic projection, per-role limits and scope validation.
- [x] Adapt executor fixtures to actual AWS scope and verify delivered input.
- [x] Update instructions and reference/runbook documentation.
- [x] Run the review and documentation suites and obtain independent review.

## Initial routing validation

The full protocol suite passed 259 tests. After narrowing standalone application
ARN routing, 96 scope, protocol, integrity and transport regression tests passed.
The review shell harness passed 161 checks, and documentation validation passed.
Independent Claude full-change review and final routing-delta review returned
PASS. Advice about unfamiliar IAM policy formats remains a classifier limitation;
this repository's IAM definitions live in matched Terraform paths.

## Authorized follow-up

Use modern V3 tool exclusions/deny permissions, retaining fresh canaries and the
peer barrier. Classify keyword-free operational updates and property-only
resource changes using stable paths and immutable Git source identity. Print
installed CLI versions, centralize budgets and disclose summary evidence in
reports. Validate bounded delivery, unit accounting, tamper rejection and provider
failure without awarding partial coverage. Latest validation is recorded in the PR.

## Release

Publish a dedicated PR from the isolated review branch.
The CI workflow executes trusted base scripts. This change takes effect after
integration into the base branch; candidate offline tests do not prove that a
live PR review has used the new routing.
