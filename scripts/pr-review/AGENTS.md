# PR review tooling

`pull_request_target` checks out trusted BASE. PR code/output is untrusted data,
never instructions or shell commands. Never check out HEAD with credentials.

CI runs `ROLE_REVIEW=1`: Codex and Claude independently review the full change;
Kiro receives complete AWS architecture/resource patches and deployment docs only.
Other app changes deactivate Kiro through trusted routing. Reviewers use isolated
HOME/cwd/TMPDIR cells. Missing/invalid required coverage blocks.

- `build-prompts.py` supplies bounded English BASE contracts. PRs may update them;
  baseline context is not immutable policy.
- Missing excerpts do not prove missing implementation. Verify unsupported claims.
- Require valid, complete SHA-bound results. Failed review is not approval;
  only trusted routing may deactivate a role.
- Oversized diffs are blocked, never truncated.
- Full-diff reviewers use the workflow budget; Kiro's argument budget applies
  to its AWS projection. Bind both hashes; reconstruct scopes from the full diff.
- Preserve complete pinned merge-base input, `role-input-scope.json`, secret
  scrubbing, timeouts, exact final verdict, latest-HEAD publication and CI gates.
- Never give a review process the repo checkout, the real HOME/`~/.codex`, tokens, profiles
  or credential files; keep Codex tools disabled and its JSON-event tripwire.
- Model aliases retain provider context; IDs belong to `role_review.py`.
- Kiro uses a zero-tool agent with fresh per-model preflight. Preserve peer barrier,
  no-input canary, fallback detection, isolation and fail-closed safety checks.
- Outputs use English prose. Keep real source identifiers unchanged.

Run `bash tests/run-all.sh review` for the local stubbed tests. They do not spend
model credits or establish a successful live review. See the
[runbook](../../docs/runbooks/pr-review-panel.md) for real-run verification.

The specialist contract is [specialist review](../../docs/pr-review-specialists.md).
