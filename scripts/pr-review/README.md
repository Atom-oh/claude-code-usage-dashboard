# Specialist review protocol

CI selects `ROLE_REVIEW=1`. Trusted inputs feed specialist executors; validated
results feed aggregation and, when needed, the chair. See
[the project contract](../../docs/pr-review-specialists.md).

| Tag | Requested model | Scope |
| --- | --- | --- |
| codex | `global.openai.gpt-6-astra` | Implementation/tests |
| kiro-fable | `claude-opus-5` | AWS/IAM/network |
| kiro-sol | `gpt-5.6-sol` | Deployment/contracts/recovery |
| claude-self | `global.anthropic.claude-fable-5-1` | Auth/data/API/ADR |

`kiro-fable` means Opus. `ROLES` governs specialists; legacy files govern legacy
execution. Kiro/Bedrock IDs differ. English is requested, not validated; configured
IDs do not attest model weights.

## API and input

`python3 scripts/pr-review/role_review.py COMMAND --help` lists flags.

| Command | Contract |
| --- | --- |
| prepare | Diff/context, HEAD/base, work; optional paths/provenance → `role-plan.json`, `roles/TAG.txt/.diff`. |
| issue | Work/tag → nonce, exact `requests/TAG.prompt/.input`, `slot/TAG-request.json`. Call before each attempt. |
| record | Tag, output/stderr, exit code, issued nonce → validated, scrubbed `slot/TAG-result.json`. |
| aggregate | Validate results/receipts → `role-summary.json`, `responded.txt`, `chair-mode.txt`, applicable report/flag. |

The executor sends issued bytes; hashes bind inputs, not transport. Keep tool data
out of diagnostics.

`--paths`: UTF-8 JSON array of unique repository-relative paths matching the patch,
e.g. `["src/api.ts"]`. Renames use destinations; the collector checks both sides.
Omit only for authoritative, unambiguous patch paths.

`--provenance`: JSON object. Required `head_sha`/`base_sha` equal the lowercase
40-character CLI revisions; `diff_sha256` hashes exact raw diff bytes. Example:

```json
{"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","base_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","diff_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
```

Optional `input_failures` contains codes matching `[a-z][a-z0-9_:.-]{0,63}`; any code
blocks. Invalid provenance is discarded and blocks; stored values are scrubbed.
Optional `path_only: list[str]` identifies collector-approved metadata-only
deletions. Verify eligibility before withholding bodies.

## Coverage and lifecycle

Codex/Claude are required for reviewable source; trusted routing may deactivate
irrelevant Kiro roles. App Router React is conservative. Failed output is never
N/A. Parsing misses whole omissions/some cut prefixes: verify Git scope/hashes.

Exclusions-only NOT_APPLICABLE/PASS requires `--allow-exclusions-only --policy FILE`.
The schema-1 policy bytes must match the 64-hex `input_policy_sha256`; the private
`exclusions-policy.json` anchor is rechecked on aggregation. Require empty diff,
`--paths` file containing `[]`, `scope_exception: configured_exclusions_only`, and
identical nonempty unique safe `scope_paths`/`excluded_paths`. The trusted BASE
collector must verify policy and all Git paths. Missing opt-in, accidental empty
input or mismatch blocks. The report discloses exclusions/hash and no model review.
New exclusions require policy review; project-specific rules remain.

Start fresh work before collection. `prepare` clears owned results/receipts, claims,
duplicate/terminal flags and histories; upstream flags remain. Issue/record exclude
each other; interrupted operations require fresh work. Duplicate records retain
the first result and block. Finish writers before aggregation. Reissue archives
32 prior results in `slot/TAG-attempts.json`; model-selection/fallback/quota/preflight
failures block until new preparation. Summaries retain history. All `*.flag` files
block except root `coverage-severe.flag`. `failure_codes` is canonical; `failures` aliases it.

Exit 2 means blocked. Aggregate exit 0: `deterministic` permits the report when no
blocking candidate/uncertainty exists (Minor/Info remain); `review` needs a chair.
Blocked input yields deterministic FAIL; the chair cannot waive coverage failures.

Publish scrubbed reports/receipts/metadata only; never raw `roles/*.diff` or
`requests/*.input/.prompt`.

## Review presentation

Specialist prompts request one JSON object without an outer Markdown wrapper.
Prefer plain-English evidence; encode any fenced example inside a JSON string.
Fence rules apply after JSON decoding; embedded quotes and newlines must be escaped.
Chair prompts repeat plain-prose guidance after the untrusted evidence. A retryable
format failure adds static guidance to the existing configured fallback, without
replaying the rejected output. A complete exit-0 FAIL with invalid details keeps a
static FAIL with details withheld and stops before fallback. Provider diagnostics
retain precedence. Models, call bounds, scope and validation stay unchanged.

Code and configuration examples require closed top-level fences with both markers
on their own lines at column one. Use a longer fence around examples containing
fences. Inline backticks permit only single-line symbol/path references, such as
`validate()` or `src/service.py`; commands, assignments and nested fences fail.
Ambiguous sensitive-key colon values require fences, including multiword
explanations and trailing comments. Formatting only the key with backticks does
not exempt its value. Put explanatory prose under a standalone heading or use a
sentence without that colon form. After an inline path reference, use a separate
sentence or a semicolon rather than an ambiguous colon explanation.
Bare section labels and Setext headings remain supported. Put compact sensitive
file:line references entirely inside inline code, such as `src/token.ts:42`.
Markdown links use actual line anchors, such as `src/token.ts#L42`, rather than
colon-number targets. Bare sensitive numeric citations are ambiguous values and
require fences; dots, slashes and numeric prefixes do not exempt them.
A link exemption still requires a complete inline link and no trailing value or
comment. Same-line empty equals assignments require fences.
The existing scrubber can damage an otherwise valid sensitive inline citation;
use a `#L` link when that occurs. Post-filter format rejection remains required.

`review_format.py` supplies the shared instructions and validator. Specialist
checks, finding conditions/evidence and uncertainties are checked before and after
scrubbing; protocol paths retain their existing validation. Unsupported prose
records `unsupported_review_format` and blocks required coverage. Deterministic
findings use fenced canonical JSON. Chair output must satisfy the same contract
before and after filtering; a filter-damaged fence stays a visible failure.
Existing credential filtering remains necessary, and format validation is not a
general code parser. Use synthetic examples and describe credential locations.
Complete JSON objects/arrays inside closed fences use the existing structured
masker before prose filtering, without protocol-path exemptions. Other code
blocks retain the existing filter; their format is still checked afterwards.

## Limits and checks

Limits: 95,000 diff bytes (UTF-8), 3,000 lines, 24,000 context bytes, <128 KiB
request; projects may lower them. Oversize blocks. No chunk coordinator or
combining partial PASS results; preserve custody/budgets.

Run `python3 -m unittest discover -s scripts/pr-review -p 'test_*role*.py'`.
Offline CI: `.github/workflows/pr-review-roles-tests.yml`. Also verify
executor/adapter, limit and exact-HEAD publication tests; offline success proves
no live provider execution.

Sol replaces this repository's legacy Terra slot in this workflow; application
inference models remain unchanged.

[run_role.py](run_role.py) records and validates each CLI attempt before deciding to
retry, including exit-0 responses. `PANEL_RETRIES` bounds total attempts (default 2,
maximum 3). Nonterminal failures retry the same complete prepared input and model
settings with a fresh nonce; reissue archives the failed result. Exhaustion leaves
required coverage blocked. Terminal diagnostics stop retries. Valid results,
including Critical/Major findings or uncertainty, stop retries and cannot be reissued.
Prepare again for a new review; retries do not repair JSON or discard findings.

The [workflow](../../.github/workflows/pr-review.yml) checks out the pinned BASE.
Runner or prompt changes in PR HEAD take effect only in a review whose BASE contains them.

Codex uses structured transport events plus its CLI-designated final-output file.
Tool output and progress text are not review results. Recovered transport notices
remain visible; terminal provider errors still block.

`prepare_context_roles.py` reuses the committed BASE context builder and selected
module guides, retaining its 20,000-byte context and 22,000-byte prompt limits.
Candidate guide size is validated without using candidate instructions.
