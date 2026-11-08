# Specialist PR review

CI uses `ROLE_REVIEW=1` to run independent Codex and Claude specialists.
Trusted routing requires Kiro for applicable AWS and operations changes; missing
required coverage blocks the review. See [ADR-011](decisions/ADR-011-specialist-review-protocol.md).

| Slot | Configured model | Responsibility |
| --- | --- | --- |
| `codex` | `global.openai.gpt-6-astra` | Implementation, concurrency, errors and tests |
| `kiro-fable` | `claude-opus-5.5` | AWS architecture, IAM, networking and service constraints |
| `kiro-sol` | `claude-opus-5.5` | AWS resource deployment order, contracts, lifecycle and recovery |
| `claude-self` | `global.anthropic.claude-fable-5-1` | Authentication, data boundaries, requirements, API and ADR consistency |

The shared Kiro tags are stable role identifiers; both slots use Opus 5.5 in
separate sessions. Codex/Claude retain independent OpenAI/Anthropic full-change
coverage. Kiro catalog aliases differ from Bedrock inference-profile IDs. These
are configured identities, not attestation of provider routing or weights.

## Routing and evidence

Trusted code determines which roles apply. Codex and Claude review the full change
boundary, retaining independent OpenAI/Anthropic checks for sensitive changes.
Kiro roles receive only AWS architecture/resource evidence:
infrastructure directories and Terraform/Terragrunt files, CloudFormation/CDK/Pulumi
declarations, SAM/Serverless configuration, Helm charts, AWS task definitions and
CodeBuild/CodeDeploy specifications, architecture documents and relevant AWS deployment
procedures. Removed definitions and rename source paths also participate in routing.
The projection preserves every patch for each selected path, including multi-block
file-type changes. Stable operation runbook paths apply even without AWS keywords
in the changed hunk. Immutable old/new source identifies resource imports and
workflow role assumption outside a property-only patch; no candidate source is
executed. Source blobs above 2,000,000 bytes, unreadable/non-UTF-8 source or unavailable
commit identities block classification and the review. Application SDK calls, ARN
references, region strings, generic retries and
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
and records the process status. Validation reconstructs scopes from `complete.diff`
and pinned source identities. Collected merge-base provenance requires both source
revisions;
rewriting a plan digest cannot deactivate a required AWS review or select an
arbitrary subset. Nonzero exits, malformed
or empty reports, missing paths, invalid fingerprints, model selection errors,
quota exhaustion and failed required roles block coverage. A JSON shape is
evidence of protocol completion, not proof that the model found every defect.

Transport budgets are separate from model context windows:

| Input | Diff bytes (UTF-8) | Diff lines | Framed request bytes |
| --- | --- | --- | --- |
| Codex / Claude full change | 512,000 | 12,000 | Below 640,000 |
| Direct Kiro AWS patch | 95,000 | 3,000 | Below 120,000 |
| Shared chair AWS packet | 64,000 compact JSON | Every metadata/hunk unit | Below 120,000 including context |

The full-change budget matches the workflow's outer guard. Codex and Kiro V3 send
instructions and evidence on stdin; Claude sends the diff on stdin and bounds its
instruction argument below 120,000 bytes. These are repository budgets, not
documented V3 maxima. See [verified headless limits](reference/pr-review-headless-limits.md).

An oversized AWS scope triggers one shared chair packet while Codex and Claude
retain the complete raw change. The packet must account for every metadata/hunk
unit, bind HEAD/source hashes and quote literal source evidence. Each receipt using
the packet binds its hash; reports disclose `chair_summary`. Missing, invalid, incomplete or
oversized packets block required coverage. Packet uncertainties enter adjudication
even if a specialist omits them. Unit accounting does not prove semantic completeness:
Kiro must report insufficient detail. No raw prefix or combined partial PASS earns
coverage.

## Execution and synthesis

Each applicable model receives one request covering its assigned paths and declared
evidence basis.
Application-only changes use two independent reviewers with no Kiro startup calls.
Mixed changes add both Kiro roles for the AWS projection. Both Kiro roles use fresh
HOME/cwd directories. The V3 profile has an empty tool list, excludes every tool,
denies tool capabilities and disables MCP/power inclusion, resources and hooks.
Legacy `allowedTools`/`toolsSettings` are omitted because V3 can skip unconverted
profiles. In each isolated HOME, native settings disable Markdown rendering and
JSON readback must confirm `chat.disableMarkdownRendering=true`. Each preflight attempt
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
Kiro startup checks. Oversized AWS input adds a shared summary call; adjudication
adds a chair call. Retries and fallback add
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
