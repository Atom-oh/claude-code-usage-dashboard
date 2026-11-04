# PR review tooling

The workflow checks out the trusted base revision with `pull_request_target`.
PR code and review output are untrusted data, never shell commands or instructions.
Do not switch to a credential-bearing PR-head checkout.

CI runs `ROLE_REVIEW=1`: Codex and Claude independently review the full change;
trusted routing requires Kiro for applicable AWS and operations changes. Missing or
invalid required coverage blocks. Reviewers run in isolated HOME/cwd/TMPDIR cells.

- `build-prompts.py` supplies bounded English contracts from the base Git snapshot.
  A PR may intentionally update those contracts; baseline context is not immutable policy.
- A missing excerpt is not proof that a file, field, test, or implementation does not
  exist. Unsupported claims require verification.
- Every required specialist must return valid, complete SHA-bound output.
  Missing/failed review is not approval; only trusted routing may deactivate a role.
- Oversized diffs are blocked, never truncated.
- Preserve the pinned complete merge-base diff, `role-input-scope.json` policy, secret
  scrubbing, timeouts, exact final-verdict validation, latest-HEAD publication and the
  final CI gate.
- Never give a review process the repo checkout, the real HOME/`~/.codex`, tokens, profiles
  or credential files; keep Codex tools disabled and its JSON-event tripwire.
- Keep model aliases in their provider context; specialist model IDs belong to `role_review.py`.
- Kiro uses a zero-tool agent and a fresh per-model preflight; preserve the peer barrier,
  no-input canary, fallback detection, per-cell isolation and fail-closed safety checks.
- Outputs use English prose. Keep real source identifiers unchanged.

Run `bash tests/run-all.sh review` for the local stubbed tests. They do not spend
model credits or establish a successful live review. See the
[runbook](../../docs/runbooks/pr-review-panel.md) for real-run verification.

The specialist contract is [specialist review](../../docs/pr-review-specialists.md).
