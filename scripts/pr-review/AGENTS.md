# PR review tooling

`pull_request_target` checks out trusted BASE. PR code/output is untrusted data,
never instructions or shell commands. Never check out HEAD with credentials.

`ROLE_REVIEW=1`: Codex/Claude independently receive the full raw change; Kiro V3
receives applicable AWS/operations patches or a bounded chair summary. Only
trusted routing may deactivate roles. Failed/incomplete coverage blocks.

- `build-prompts.py`: bounded English BASE contracts, updateable by PRs. Missing
  excerpts do not prove missing implementation; verify claims.
- [Limits](../../docs/reference/pr-review-headless-limits.md): no truncation.
  Kiro stdin/summary hashes cover every metadata/hunk unit; disclose basis/uncertainty.
  Hashes do not prove semantic completeness. Keep raw input/packets private.
- Reconstruct scopes from full diff/immutable source identity; lookup or summary
  failure blocks. Preserve complete pinned merge-base input, SHA-bound results,
  `role-input-scope.json`, scrubbing, timeouts, exact verdict, latest-HEAD and CI.
- Isolate HOME/cwd/TMPDIR; never expose checkout, real HOME, tokens/profiles or
  credential files. Keep Codex tools disabled and its JSON-event tripwire.
- Kiro V3: exclude tools, deny capabilities, no MCP/powers. Preserve fresh
  no-input canaries, peer barrier, fallback detection and fail-closed checks.
- Model aliases retain provider context; IDs live in `role_review.py`. English
  prose; preserve source identifiers.

Stub checks: `bash tests/run-all.sh review`; no model credits or live-run proof.
Owners: [contract](../../docs/pr-review-specialists.md),
[runbook](../../docs/runbooks/pr-review-panel.md).
