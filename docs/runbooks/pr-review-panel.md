# Runbook: AI PR Review Panel

## Scope and trust boundary

The `AI Code Review` workflow in `.github/workflows/pr-review.yml` runs for same-repository
PRs on `pull_request_target`, using the trusted base checkout. PR code is not executed by
this workflow. The PR diff and panel outputs are untrusted data, including instructions
embedded in documentation. Trusted project context must come from the base checkout.
Keep input truncation, skipped cells, startup failures, and invalid chair output visible.

`scripts/pr-review/run-panel.sh` runs Codex and two Kiro models across L2 data/query
correctness, L3 security, L4 frontend correctness, and L5 docs/infrastructure consistency.
The Kiro roster is `claude-opus-5` (`kiro-opus`) and `gpt-5.6-terra` (`kiro-gpt`);
Codex's model is runner-configured. `synthesize.sh` combines successful cells through a
primary/fallback Claude chair and requires a final `VERDICT: PASS` or `VERDICT: FAIL`.
Missing/invalid chair output fails. Model agreement alone is not evidence of a defect.

## Trusted review context

`build-prompts.py` reads canonical `AGENTS.md` files from the base Git commit, not the
working tree or proposed PR contents. Only allowlisted, regular tracked files can supply
contracts. The context also lists tracked Markdown paths so an omitted excerpt is not
mistaken for an absent document.

Panel and chair instructions use English. Reviewers must verify claims against executable
behavior rather than treating removed prose as automatically correct. Baseline contracts
may be intentionally updated by a PR; real introduced defects still block.

Each context is limited to 20,000 UTF-8 bytes and each lens prompt to 22,000 bytes. The
default Kiro diff cap plus that prompt stays below the single-argument limit. Context
overflow fails explicitly rather than silently dropping guidance. Split oversized changes.
`lenses/context-manifest.json` records the base revision, included files, content hashes,
sizes, and missing optional guides. The chair independently reads the same base snapshot.

`review_verdict()` in `lib.sh` is shared by synthesis validation and the CI gate. It accepts
only an exact final nonempty `VERDICT: PASS` or `VERDICT: FAIL` line; body quotations do not
override that final decision. Missing, empty, malformed, or noncanonical output is not
approval. Coverage/safety failures still append a final FAIL regardless of the chair.

## Startup verification

The runner needs Bash, `python3`, `timeout`, `realpath`, standard GNU text utilities, `gh`,
and the configured `codex`, `kiro-cli`, and `claude` binaries. Check the actual runner's CLI
version in the panel log; do not infer it from an old validation date.

1. Python validates `agents/pr-review-notools.json` before Kiro calls: no duplicate JSON
   keys; matching agent name; empty `tools`, `allowedTools`, `resources`, and `mcpServers`;
   `useLegacyMcpJson: false`. Invalid JSON or a failed agent-file copy aborts the step.
2. Each configured Kiro model receives the same fixed canary prompt in a separate fresh
   working directory/HOME containing the no-tools agent and a random, non-secret file.
   **Preflight stdin is `/dev/null`; neither its prompt nor stdin contains PR input.**
3. Passing requires exit 0, exactly `NO_TOOLS` after CLI-format normalization, and no
   fallback, quota, or `using tool:` signal. Each call has a
   `KIRO_PREFLIGHT_TIMEOUT` limit (default 60 seconds); the loop stops at the first failure.
4. **Both models must pass before either receives PR input.** A failed preflight skips
   every Kiro review cell, permits Codex work to continue, and always forces the gate to fail.
   Canary calls do not count as review coverage.

This is a behavioral startup check, not formal proof or an OS tool sandbox. Review cells
still use `--agent pr-review-notools` and isolated directories with a minimal environment.
Kiro receives the size-capped diff inline in its prompt; the shared review runner also
redirects the diff to stdin, although Kiro's non-interactive mode uses the prompt argument.
Codex receives the diff on stdin with `-s read-only`. Post-execution fallback detection,
quota handling, exit/nonempty-output checks, and output secret scrubbing remain necessary.

## Diagnose the failed run

Inspect the latest HEAD's workflow log, review comment, and inline findings. Match the
comment's triggering commit to the current HEAD; an older passing review is insufficient.
Within the runner work directory, these files identify the failure without copying secrets:

| Signal | Meaning and action |
|---|---|
| `kiro-preflight.flag` | Startup behavior was not established. Inspect the model's preflight stderr for timeout, authentication, unexpected output, tool use, quota, or fallback. Resolve the cause and rerun; never bypass this check. |
| `kiro-agent-fallback.flag` | Agent lookup/schema failed and the CLI continued with a default agent. The affected response is discarded and the gate fails regardless of remaining coverage. |
| `kiro-quota.flag` | Kiro stderr matched `Monthly request limit reached`, `MONTHLY_REQUEST_COUNT`, or `UsageLimitReachedError`. Diagnose authentication and usage as below. |
| `degraded-models.txt` | A model returned zero successful cells across all lenses. |
| `coverage-severe.flag` | Zero successful Codex cells, all Kiro models with zero successful cells, or a preflight/fallback safety failure forces `VERDICT: FAIL`. |
| `responded.txt` and `slot/` | Actual successful review cells and their output; canaries are excluded. |

Quota failures **after successful startup** remove affected cells without retry. Partial
quota failures can retain enough coverage to pass: the coverage floor is vendor-wide,
not a requirement that all 12 cells or every model/lens pair succeed. Preflight failures
and agent fallback are independent blocking conditions. Kiro stderr signatures are not
applied to Codex stderr, which may contain quoted diff text matching those signatures.

The workflow caps its diff at 3,000 lines. Kiro has a further `KIRO_DIFF_CAP` byte limit
(default 100,000). Truncation banners describe partial review; Codex sees the workflow's
input, not necessarily the full original PR. Neither a canary pass nor a nonempty cell
establishes review of omitted content.

## Recover Kiro authentication or quota

Record the exact error class, reason, reset date if present, model, and whether failure
occurred during preflight or review. A quota response does **not** prove a specific API
key's independent cap is exhausted. Check which account/profile actually authenticates the
worker, its usage/entitlement, and any shared consumption. The isolated Kiro process only
inherits `KIRO_API_KEY` when present; a successful interactive login elsewhere may use a
different identity and does not verify the worker.

If rotation is required, update `KIRO_API_KEY` through the runner platform's approved secret
store. Locate the `ai-panel-keys` ExternalSecret mapping in the runner platform repository,
verify External Secrets Operator (ESO) refreshed the target Secret, then start a **fresh
runner worker/pod**. An already running worker retains its old environment. Verify refresh
status and worker creation time without decoding credentials into logs. Rerun the workflow
and inspect both startup checks and actual review coverage. Do not blindly enable paid
usage or overages in response to a banner.

For agent failures, validate the checked-out file using the installed CLI:

```bash
kiro-cli --version
kiro-cli agent validate --path scripts/pr-review/agents/pr-review-notools.json
```

Repair the runner/configuration if validation fails. Validation alone does not replace the
behavioral preflight. Do not work around failure with `--trust-tools=` or the v3 engine:
the repository's regression tests preserve the no-tools agent path and exclude those
previously unsafe alternatives. Runner image changes belong to the runner platform project.

## Offline verification and merge gate

From the repository root, these tests stub the model CLIs; they do not make real model calls:

```bash
bash tests/run-all.sh pr-review-panel
bash tests/run-all.sh review-context
bash tests/run-all.sh pr-review-verdict
bash tests/run-all.sh
```

`tests/structure/test-pr-review-panel.sh` is registered through `tests/run-all.sh`, and
`.github/workflows/ci.yml` actually runs that harness alongside server tests, web tests/build,
and Terraform checks. Missing local `.claude/` tooling causes designated harness groups
to skip; it is not a successful execution of those groups.

After fixes, obtain review on the new HEAD and satisfy required CI/branch protection.
Resolve verified Critical/Major findings; missing review or failed coverage is not “no
blocking findings.” Immediately before merging, recheck HEAD, target branch, and any
prerequisite PRs. Do not disable checks or hide failures to obtain a pass.
