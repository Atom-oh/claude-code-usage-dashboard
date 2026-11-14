# Headless review input limits

Official pages fetched and local synthetic probes run on 2026-11-09.
Transport limits, model context, account quotas and repository policy are
different constraints. A request must fit all applicable constraints; no single
byte value establishes the maximum reviewable PR.

## Documented transport

| CLI | Transport used by this repository | Official ceiling |
| --- | --- | --- |
| Codex exec | Complete instruction and evidence on stdin via `-` | No numeric stdin ceiling stated |
| Claude Code print | Instruction argument and evidence on stdin | Piped stdin documented as 10MB |
| Kiro headless V3 | Complete instruction on stdin, without a positional instruction | No numeric stdin ceiling stated |

Sources: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[Claude headless mode](https://code.claude.com/docs/en/headless),
[Kiro headless mode](https://kiro.dev/docs/cli/headless/).
An unstated ceiling is unknown, not unlimited. File-reading alternatives in CLI
documentation are unsuitable for full-diff specialists with tools disabled.

Local Claude Code 2.1.319 checks the decoded JavaScript string against 10,485,760
UTF-16 code units. Synthetic probes found:

| Input | UTF-8 bytes | UTF-16 code units | Result |
| --- | --- | --- | --- |
| ASCII at the boundary | 10,485,760 | 10,485,760 | Passed stdin check; then reported `Prompt is too long` |
| ASCII above the boundary | 10,485,761 | 10,485,761 | Rejected: piped stdin exceeds 10MB |
| Repeated two-byte Unicode character | 10,485,762 | 5,242,881 | Passed stdin check; then reported `Prompt is too long` |

These probes used an empty home, disabled tools, a synthetic API key, a loopback
endpoint and `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`; no provider inference was
performed. The prompt rejections therefore do not measure the default model
window. These probes establish this binary's stdin behavior, not successful
model processing or a portable UTF-8
byte ceiling. Recheck the installed runner version before relying on the result.

On the probed Linux host with 4,096-byte pages, a single argument of 131,071 bytes
was accepted by `/usr/bin/true`; 131,072 bytes failed with `E2BIG`. The terminating
NUL also consumes space. This does not constrain stdin or establish model
capacity. `ARG_MAX` describes a separate aggregate constraint. Claude's
instruction argument remains subject to both argument and aggregate limits.

## Selected model context

These are the active `ROLE_REVIEW=1` defaults in
[role_review.py](../../scripts/pr-review/role_review.py) and
[synthesize_roles.py](../../scripts/pr-review/synthesize_roles.py).

| Review slot | Primary default model | Published context | Published maximum output |
| --- | --- | --- | --- |
| Codex | `global.openai.gpt-6-astra` | 1,050,000 tokens | 128,000 tokens |
| Claude and chair | `global.anthropic.claude-fable-5-1` | 1M tokens | 128K tokens |
| Both Kiro roles | `claude-opus-5.5` | 1M tokens in Kiro's catalog | Not established for the Kiro harness |

Sources: [OpenAI GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra),
[Claude model overview](https://platform.claude.com/docs/en/models/overview),
[Kiro model catalog](https://kiro.dev/docs/models/).
These are published model capacities, not verified maximum PR inputs on this
runner. The OpenAI card describes the underlying model; it does not attest the
effective limits of this inference profile. Kiro's catalog does not establish
its headless harness's output reservation. Verify `CHAIR_PRIMARY_MODEL` overrides
and `CHAIR_FALLBACK_MODEL` independently; Fable's row does not establish a
fallback model's limits.

The CLI's system prompt, instructions, context, metadata, evidence and provider
envelope use capacity beyond the diff. Reserve output and reasoning according to
the selected endpoint's rules; a published maximum output is not necessarily
the reservation used by the CLI. Do not convert these windows into bytes with
`bytes / 4`, or subtract advertised maxima and call the result a tested PR limit.

Check effective overrides and automatic compaction:

- Codex exposes `model_context_window` and `model_auto_compact_token_limit` in
  its [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
- Claude's [model configuration](https://code.claude.com/docs/en/model-config)
  documents default 1M context for Fable 5.1 on Bedrock, the 200K opt-out through
  `CLAUDE_CODE_DISABLE_1M_CONTEXT`, and gateway-specific compact-window settings.
- Kiro's [context management](https://kiro.dev/docs/cli/chat/context/) documents
  automatic compaction on context overflow. Its context-file dropping limit
  applies to context files, not to the headless stdin instruction.

A receipt hash binds the submitted input, not an internally compacted
conversation. Observed compaction or omitted evidence cannot earn full raw-diff
coverage. The current receipt checks do not independently prove the absence of
internal compaction.

## Existing repository policy

[input_limits.py](../../scripts/pr-review/input_limits.py) owns transport and
request budgets; [build-prompts.py](../../scripts/pr-review/build-prompts.py)
owns the lens argument guard. The former 24,000-byte context ceiling, this
repository's 20,000-byte context budget and the 22,000-byte specialist instruction
template budget were removed on 2026-11-14. Trusted context now counts only toward
the guards below; Kiro receives the AWS scope the trusted routing selects, or the
chair packet when that scope exceeds its direct budget.

| Input | Existing policy budget |
| --- | --- |
| Complete PR diff | At most 512,000 UTF-8 bytes and 12,000 lines |
| Full reviewer or chair request | Below 640,000 bytes, including instructions and framing |
| Direct Kiro AWS patch | At most 95,000 bytes and 3,000 lines |
| Chair AWS packet | At most 64,000 bytes of compact JSON |
| Complete Kiro V3 request | Below 120,000 bytes, including context, metadata and framing |
| Claude instruction argument | Below 120,000 bytes |
| Codex lens prompt argument (legacy panel) | Below 120,000 bytes |

Guide selection follows the changed paths.
[frame_request](../../scripts/pr-review/role_review.py) adds nonce boundary
instructions and frames the evidence payload; `role_review.py prepare` checks the
complete framed request of each required role and Claude's instruction argument
against the guards above before any provider call.
Codex's stdin ceiling has not been measured; its full-request guard remains a
policy budget.

Commit `4e2dc91` introduced the 512,000-byte / 12,000-line guard on 2026-11-04;
`7590682` centralized it on 2026-11-08. No sizing experiment, token-count
derivation or provider source for the exact values was found in those changes.
The earlier runbook described matching limits in cc-on-bedrock; that historical
comparison is not vendor documentation or a sizing experiment.
The 120,000-byte instruction and lens-argument guards leave space below the observed
Linux single-argument limit; Kiro V3 now uses stdin and does not inherit that argument
constraint. Its request and summary ceilings remain policy choices.

An AWS scope exceeding the direct budget triggers one shared chair summary.
Codex and Claude retain the complete raw diff. Invalid, oversized or incomplete
summaries block required Kiro coverage. Hash-bound unit accounting does not prove
semantic completeness; disclose the summary basis and propagate uncertainty.
Raw input is retained privately; prefix truncation never earns coverage.
See [specialist review](../pr-review-specialists.md).

## Rules for changing budgets

1. Record the exact CLI version, harness, model ID, provider/region, transport,
   source URL, verification date and counting unit. Keep undisclosed limits
   unknown; a change in any of these inputs requires renewed verification.
2. Verify context and output rules for the actual endpoint. Use its token-count
   facility or a matching tokenizer where supported, and account for the
   complete framed request plus CLI/provider overhead. Estimates must be labeled;
   they cannot establish an exact admissible token boundary.
3. Separate synthetic offline transport probes from provider acceptance tests.
   Transport success, stub tests, a model card and one small successful review
   do not prove maximum-size full coverage. Verify the intended workload and
   absence of omitted/compacted evidence before raising the production budget.
4. Update the owning constants, workflow consumers, boundary tests and these
   instructions together. Required execution/context failures still block.
   Preserve independent full raw Codex/Claude coverage and Kiro's validated
   summary path; never obtain a pass by truncating or waiving a required role.
5. Classify failures: repository policy, argument/stdin transport, context,
   provider quota/rate limit, timeout or review finding. Consult the actual
   [Bedrock account quotas](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html)
   for rate failures; opening another PR does not change a payload budget.

## V3 isolation and runner evidence

The reviewer pins the V3 harness. Its profile uses an empty tools list, excludes
all tools, denies every capability and disables MCP/power inclusion. Legacy
allowedTools and toolsSettings are omitted: V3 can skip an unconverted profile.
A fresh canary and the two-role safety barrier remain required before either
Kiro process receives PR evidence.

Sources: [V3 agent configuration](https://kiro.dev/docs/custom-agents/configuration-reference/),
[permissions](https://kiro.dev/docs/permissions/).
Local Kiro 2.29.1 cannot attest the CI V3 runner's transport behavior. The workflow
prints all three CLI versions; use the reviewed run's evidence rather than
assuming the local binaries match. [Run 42620975201](https://github.com/Atom-oh/claude-code-usage-dashboard/actions/runs/42620975201),
completed on 2026-11-09,
reported Codex 0.167.0, Claude Code 2.1.319 and Kiro 3.1.0. A matching version
does not substitute for running the synthetic probe in the runner environment.
Runner image updates belong to the runner
platform repository, and changing this project's guidance does not rebuild them.
