# Runbook: AI PR Review Panel

> Current protocol: CI uses `ROLE_REVIEW=1`. See the
> [specialist review contract](../pr-review-specialists.md) and
> [specialist tooling](../../scripts/pr-review/README.md). The panel and chair
> procedure below describes the retained legacy `ROLE_REVIEW=0` path.

## Scope and trust boundary

The `AI Code Review` workflow in `.github/workflows/pr-review.yml` runs for same-repository
PRs on `pull_request_target`, using the trusted base checkout. PR code is not executed by
this workflow. The PR diff, title and panel outputs are untrusted data, including
instructions embedded in documentation. Trusted project context must come from the base
checkout.

The workflow fetches immutable merge-base and HEAD objects without checking out PR
code. Its diff includes every changed path. Binary or oversized input blocks rather
than yielding a partial pass; the specialist contract documents its limits and evidence.

## Legacy panel and chair (ROLE_REVIEW=0)

1. `scripts/pr-review/run-panel.sh` runs one Codex cell per lens in parallel: L2 data/query
   correctness, L3 security, L4 frontend correctness, L5 documentation and infrastructure
   consistency. The model is `PANEL_MODEL`, default `global.openai.gpt-6.1-sol` (previously
   `global.openai.gpt-6-astra`). Each cell gets its lens prompt from `build-prompts.py` and
   the diff on stdin, with `PANEL_TIMEOUT` (300 s in the workflow) per attempt and up to
   `PANEL_RETRIES` attempts (default 2). Every attempt runs in a fresh cell under the review
   workdir (`cells/codex-<lens>/`): an empty `HOME`, `CODEX_HOME`, working directory and
   `TMPDIR`, outside the repository checkout. The only Codex configuration is generated
   there: the Bedrock provider (`PANEL_PROVIDER`, default `amazon-bedrock-runtime`),
   reasoning effort (`PANEL_REASONING_EFFORT`, default `xhigh`), `approval_policy = "never"`,
   the read-only sandbox, web search disabled, and the shell, exec, image, browser,
   plugin, hook and multi-agent features disabled. The runner's `~/.codex` (auth, skills,
   plugins) is not used. `review_env` in `lib.sh` passes only `PATH`, `LANG`/`LC_ALL`, the
   cell directories and the AWS region and Pod Identity/IRSA credential handles
   (`REVIEW_AWS_VARS`); profiles, `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE`, static
   keys, Bedrock bearer tokens, `CODEX_*`, `GH_TOKEN` and `KIRO_API_KEY` are dropped.
   Codex runs as `codex exec ... -s read-only --skip-git-repo-check --ephemeral
   --ignore-rules --json -o <cell>/last-message.md`; only that final message is the cell
   output. A tool-use tripwire reads the JSON events: any item other than a message,
   reasoning, plan or error item (for example `command_execution`) discards the cell
   without a retry. A nonzero exit, malformed or incomplete event stream, or empty final
   message is retried.
2. Coverage fails closed: every lens L2-L5 needs a successful Codex cell. Otherwise
   `run-panel.sh` logs `::error::codex did not complete every lens (missing: ...)`, writes
   `coverage-severe.flag` and `degraded-models.txt`, and `synthesize.sh` replaces the chair
   verdict with `VERDICT: FAIL` under a "Required coverage failed" banner. Missing or failed
   review is never approval.
3. `scripts/pr-review/synthesize.sh` runs the Claude chair `global.anthropic.claude-opus-5-5`
   (`CHAIR_PRIMARY_MODEL`; fallback `global.anthropic.claude-opus-5`, `CHAIR_FALLBACK_MODEL`),
   `CHAIR_TIMEOUT` default 900 s per attempt, as `claude -p ... --tools "" --strict-mcp-config
   --setting-sources ""` from a fresh `chair/` box (empty `HOME`, working directory and
   `TMPDIR`) under the same `review_env` allowlist plus `CLAUDE_CODE_USE_BEDROCK`,
   `ANTHROPIC_BEDROCK_BASE_URL` and `ANTHROPIC_MODEL`, so no user settings, memory files,
   API keys or GitHub/Kiro tokens reach it.
   Fixed instructions carry the trusted base context; the PR title, diff and Codex cells
   arrive on stdin as untrusted data. The chair reviews the diff itself as the second
   independent reviewer, adjudicates the Codex findings and must end with exactly
   `VERDICT: PASS` or `VERDICT: FAIL`. A rejected attempt logs `--- chair '<label>' rejected`
   with scrubbed output; if both models fail, the review is "Review generation failed" plus
   `VERDICT: FAIL`. The empty-directory rule comes from cc-on-bedrock, where a tool-less
   chair started in the checkout tried to inspect the tree and stopped without a verdict.

## Credential exposure and residual risk

Both model processes receive untrusted PR text and must hold Bedrock credentials. The
runner authenticates with EKS Pod Identity, so the processes get
`AWS_CONTAINER_CREDENTIALS_FULL_URI` and `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` for the
shared runner role, which the runner platform grants more than Bedrock access (for
example read-only AWS access and S3 access). Neither model has a tool that can read files,
the environment or the network: the chair runs with `--tools ""`, and Codex runs with its
tool features disabled behind the event tripwire. Published output still passes
`scrub_secrets`, which is defense in depth, not a boundary.

Not enforced here: short-lived credentials scoped to `bedrock:InvokeModel*`. Minting them
needs a Bedrock-only role the runner role may assume (or a session policy on such an
assumption); that is a runner-platform IAM change. Until it exists, a Codex or Claude CLI
defect, or a future tool that ignores the disabled features, could reach the runner
role's credentials. The tripwire discards such a cell's output and fails coverage, but
cannot undo a tool call that already ran.

## Trusted review context

`build-prompts.py` reads canonical `AGENTS.md` files from the base Git commit, not the
working tree or proposed PR contents. Only allowlisted, regular tracked files can supply
contracts. The context also lists tracked Markdown paths so an omitted excerpt is not
mistaken for an absent document.

Panel and chair instructions use English. Reviewers must verify claims against executable
behavior rather than treating removed prose as automatically correct. Baseline contracts
may be intentionally updated by a PR; real introduced defects still block.

Each context is limited to 20,000 UTF-8 bytes and each lens prompt to 22,000 bytes. Context
overflow fails explicitly rather than silently dropping guidance. Split oversized changes.
`lenses/context-manifest.json` records the base revision, included files, content hashes,
sizes, and missing optional guides.

`review_verdict()` in `lib.sh` is shared by synthesis validation and the CI gate. It accepts
only an exact final nonempty `VERDICT: PASS` or `VERDICT: FAIL` line; body quotations do not
override that final decision. Missing, empty, malformed, or noncanonical output is not
approval. Coverage/safety failures still append a final FAIL regardless of the chair.

## Legacy limits and time budget

Diffs over 12,000 lines or 512,000 bytes are blocked (`## Review blocked`, BLOCKED,
`VERDICT: FAIL`), never truncated; the same limits as cc-on-bedrock. Both reviewers read the
diff from stdin and have 1M-token context windows (Bedrock model cards for
`openai.gpt-6.1-sol` and `anthropic.claude-opus-5-5`, checked 2026-11-04); 512,000 bytes is
roughly 150K tokens, under Codex's 272K standard-rate tier. The specialist protocol's
3,000 lines / 95,000 bytes came from Kiro receiving its prompt as one command-line argument
(`MAX_REQUEST_BYTES`, 128 KiB) and applies to the active specialist path. The old
3,000-line truncation of this path and Kiro's `KIRO_DIFF_CAP` are gone.

The job has `timeout-minutes: 50`. The normal worst case is 300 s x 2 panel attempts plus
900 s x 2 chair models, 40 minutes.

## Diagnose the legacy panel run

Inspect the latest HEAD's workflow log, review comment, and inline findings. Match the
comment's triggering commit to the current HEAD; an older passing review is insufficient.

| Signal | Meaning and action |
|---|---|
| `::error::codex did not complete every lens (missing: ...)` | Read the `--- [codex-L*] skipped; stderr (last 25 lines, scrubbed) ---` block. Transient Bedrock errors or timeouts: rerun. |
| `::error::codex CLI not found on runner` | The runner image needs a rebuild; the CLI check step also fails. |
| `[tool-use] codex-L*` / `::error::codex ran a tool in [...]` | A Codex event stream contained a tool item although tools are disabled; the output was discarded and coverage fails. Treat it as a security event: check `cells/codex-<lens>/events.jsonl` and the runner's Codex version for renamed or new tool features before rerunning. |
| `::warning::chair ... degraded` / `--- chair ... rejected` | Check the scrubbed excerpt. Confirm the Claude signing region matches `ANTHROPIC_BEDROCK_BASE_URL`, since `global.` profiles change routing only. Bedrock capacity errors such as `ServiceUnavailableException` appear in CloudTrail as failed `InvokeModelWithResponseStream` calls. Rerun. |
| `Review generation failed` | Both chair models failed; apply the same checks. |
| `## Review blocked` | The diff exceeds the limits. Split the PR; never raise limits to obtain a pass. |
| `::error::PR head changed` | Review the latest HEAD; an older pass is insufficient. |
| `coverage-severe.flag` / `degraded-models.txt` / `responded.txt` / `slot/` | Files under the review workdir. |

## Legacy panel rollback

Changing the workflow selection does not change account-side Bedrock access. The
legacy panel does not meet the independent specialist requirement; it cannot replace
the active protocol for a passing review.

## Offline verification and merge gate

From the repository root, these tests stub the model CLIs:

```bash
bash tests/run-all.sh pr-review-panel
bash tests/run-all.sh pr-review-workflow
bash tests/run-all.sh review-context
bash tests/run-all.sh pr-review-verdict
bash tests/run-all.sh
```

`tests/structure/test-pr-review-panel.sh` uses stub codex/claude binaries to check 4/4 lens
coverage, allowlisted environments, per-cell HOME/CODEX_HOME/cwd, the generated config with
tools disabled, the tool-use tripwire, fail-closed missing or empty lenses, retries, the
isolated tool-less chair, fallback, and scrubbing. `tests/structure/test-pr-review-workflow.sh`
runs the workflow's lens, panel, gate and comment steps against stubs: oversize block,
unchanged marker/badges/footer, changed-head refusal, and exclusions equal to
`role-input-scope.json`. `bash tests/run-all.sh review` runs them with the verdict and
review-context tests. They spend no model credits and do not prove a live run. Specialist
tests run with `python3 -m unittest discover -s scripts/pr-review -p 'test_*role*.py'`.

After fixes, obtain review on the new HEAD and satisfy required CI/branch protection.
Resolve verified Critical/Major findings; missing review or failed coverage is not “no
blocking findings.” Immediately before merging, recheck HEAD, target branch, and any
prerequisite PRs. Do not disable checks or hide failures to obtain a pass.

## Background

Before the temporary legacy panel on 2026-11-04, CI ran the specialist protocol (`ROLE_REVIEW=1`: `codex`, `kiro-fable`,
`kiro-sol`, `claude-self` plus a conditional chair, with two Kiro startup preflights).
Earlier, CI ran a Codex x two-Kiro model-by-lens matrix.

A live smoke run on 2026-11-04 (local, not CI) used this repository's
`origin/main~1..origin/main` diff (1 file, 41 lines) with the runner's Codex configuration.
With the isolated, tool-less cells, Codex covered 4/4 lenses in 40 s with only
`agent_message` events, and the isolated Opus 5.5 chair returned a lens-grouped review ending
in one `VERDICT: PASS` in 27 s. Nothing was posted to GitHub.

The runner image and its CLI versions belong to the runner platform repository, not this
one. Kiro incident procedures live in Git history.
