# Specialist PR review

CI uses `ROLE_REVIEW=1` to run independent Codex and Claude specialists.
Trusted routing requires Kiro for applicable AWS and operations changes; missing
required coverage blocks the review. See [ADR-011](decisions/ADR-011-specialist-review-protocol.md).

| Slot | Configured model | Responsibility |
| --- | --- | --- |
| `codex` | `global.openai.gpt-6-astra` | Implementation, concurrency, errors and tests |
| `kiro-fable` | `claude-opus-5` | AWS architecture, IAM, networking and service constraints |
| `kiro-sol` | `gpt-5.6-sol` | AWS resource deployment order, contracts, lifecycle and recovery |
| `claude-self` | `global.anthropic.claude-fable-5-1` | Authentication, data boundaries, requirements, API and ADR consistency |

The shared `kiro-fable` tag identifies the Opus slot. Kiro catalog aliases differ
from Bedrock inference-profile IDs. These are configured model identities, not
attestation of the provider's internal routing or weights.

## Routing and evidence

Trusted code determines which roles apply. Codex and Claude review the full change
boundary, retaining independent OpenAI/Anthropic checks for sensitive changes.
Kiro roles receive only complete file patches for AWS architecture and resources:
infrastructure directories and Terraform/Terragrunt files, CloudFormation/CDK/Pulumi
declarations, SAM/Serverless configuration, Helm charts, AWS task definitions and
CodeBuild/CodeDeploy specifications, architecture documents and relevant AWS deployment
procedures. Removed definitions and rename source paths also participate in routing.
The projection preserves every patch for each selected path, including multi-block
file-type changes. Application SDK calls, ARN references, region strings, generic retries and
unfamiliar application paths alone do not activate Kiro.
Resource declarations in test fixtures remain conservatively applicable; routing
does not execute source code to distinguish fixtures from deployable definitions.
Only deterministic routing may record NOT_APPLICABLE; provider failures never do.

`prepare_roles.py` verifies the pinned base checkout, resolves the immutable merge
base, fetches Git objects and generates a complete diff without executing head
code. Workflow context rendering uses the same event `BASE_SHA` as the trusted
checkout, including advanced or stacked PR bases. Reviewer instructions come from
the base Git object. Candidate context is checked for availability, size and
generated-source freshness, then discarded.
The shared context ceiling is 24,000 bytes; repositories may enforce a smaller one.

Every result confirms its role, HEAD and reviewed paths. Codex and Claude must
cover all changed paths; Kiro must cover all projected paths. Host metadata binds
each request to both the canonical complete diff hash and its own scope hash,
and records the process status. Validation reconstructs scopes from `complete.diff`;
rewriting a plan digest cannot deactivate a required AWS review or select an
arbitrary subset. Nonzero exits, malformed
or empty reports, missing paths, invalid fingerprints, model selection errors,
quota exhaustion and failed required roles block coverage. A JSON shape is
evidence of protocol completion, not proof that the model found every defect.

Transport budgets are separate from model context windows:

| Input | Diff bytes (UTF-8) | Diff lines | Framed request bytes |
| --- | --- | --- | --- |
| Codex / Claude full change | 512,000 | 12,000 | Below 640,000 |
| Each Kiro AWS projection | 95,000 | 3,000 | Below 131,072 (128 KiB) |

The full-change budget matches the workflow's existing outer guard. Kiro retains
its single-argument budget. Codex sends instructions and diff on stdin; Claude
sends the diff on stdin and bounds its instruction argument below 128 KiB.
All required scopes must fit their budgets before any reviewer runs. Oversized
input blocks without awarding credit for a prefix. No chunk coordinator combines
partial passes.

## Execution and synthesis

Each applicable model receives one request for its complete assigned scope.
Application-only changes use two independent reviewers with no Kiro startup calls.
Mixed changes add both Kiro roles for the AWS projection. Both Kiro roles use fresh
HOME/cwd directories and an explicit empty tool catalog with no MCP resources or
hooks. In each isolated HOME, native settings disable Markdown rendering and
JSON readback must confirm `chat.disableMarkdownRendering=true`. `--wrap never`
alone still transforms JSON fences and string literals. Each preflight attempt
runs settings setup, readback and the fixed no-tools canary within its own
`KIRO_PREFLIGHT_TIMEOUT` budget; a role makes up to `KIRO_PREFLIGHT_ATTEMPTS`
attempts, and only timeouts and nonzero exits without a safety diagnostic are
retried. The peer wait lasts until all permitted attempts could finish;
`kiro_preflight_timeout` and `kiro_preflight_peer` record the cause and block
coverage. Failed or unconfirmed setup invokes no Kiro model; only an exact
successful no-tools response permits PR input. Settings and chat use the same
filtered environment, excluding AWS and GitHub credentials. Errors remain
visible; no automatic quota or billing changes are made.

Codex retains its read-only sandbox and configured Bedrock provider. Claude's
specialist has no tools. The chair has bounded local read tools and no GitHub
token. Review output is scrubbed before becoming a public artifact.

Review examples use closed top-level code fences with markers at column one;
inline code is limited to symbol/path references. Specialist prose and chair
output must satisfy this contract before and after confidentiality filtering.
Nonempty sensitive-key colon values must be fenced, including Markdown links and
multiword prose. Use a standalone heading and separate explanation; ordinary
sentence citations remain supported. Use Markdown links with actual `#L` line anchors for
all file-and-line citations; sensitive inline numeric references can be damaged by
confidentiality filtering. Bare sensitive numeric labels receive no citation exemption.
Unsupported examples or damaged fences remain incomplete review evidence, with
a static failure explanation. Metadata paths keep their existing scope validation.
See the [module presentation contract](../scripts/pr-review/README.md#review-presentation).

Complete, valid results with no Critical/Major candidate or uncertainty receive
a deterministic summary. Other valid results require chair adjudication. A
coverage failure receives a deterministic failure; a chair cannot waive it.
Minor/Info findings remain in the report.

With all four roles active, the ordinary path uses four review calls and two
Kiro startup checks. Adjudication adds one chair call; retries and fallback add
calls only when needed. This reduces duplicate requests, but is not a measured
wall-clock speedup. Per-role timing artifacts support before/after measurement.

## Maintenance and release

Run `python3 -m unittest discover -s scripts/pr-review -p 'test_*role*.py' -v`
and the repository's existing review tests. Offline fake CLIs validate routing,
scope, subprocess status and safety boundaries without spending model credits.
They do not establish successful live model execution.

Native `pull_request_target` uses base scripts, so a workflow-changing PR must
also have offline checks for the candidate implementation. Review the latest HEAD,
resolve real Critical/Major findings, satisfy required CI and branch rules, and
verify the integration path before merge. Missing review or quota failure is not
a clean result. Model limits and required gates remain in force.

## Review scope

`role-input-scope.json` selects every changed path, including lockfiles and generated
assets. The trusted base classifies immutable Git paths before requests are prepared.
Provenance records every path and the raw and selected diff hashes. Renames are
expanded into deletion/addition records. Binary content cannot be reviewed as text
and blocks the review; oversized or missing input also blocks rather than yielding a
partial pass. Split oversized changes into reviewable PRs.

If a single lockfile or binary asset cannot be split into reviewable text changes, it
remains blocked until a separately reviewed complete-coverage method is available.

The generic protocol also supports exclusions-only input, but production does not
configure any exclusions. An approved exclusions-only input explicitly supplies `--allow-exclusions-only` and
a private `--policy` file copied from Git BASE. The engine checks its byte hash
and retains an anchor through aggregation; arbitrary provenance cannot opt in.
