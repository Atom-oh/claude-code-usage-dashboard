# Headless review input limits

Verified against official documentation on 2026-11-08. CLI transport, model context
windows and repository review budgets are different limits. UTF-8 bytes do not
establish token counts, model acceptance, latency or billing tiers.

| CLI | Documented input transport | Documented byte ceiling |
| --- | --- | --- |
| Codex exec | `-` reads the full prompt from stdin | None stated on the referenced page |
| Claude Code print | Prompt argument plus piped stdin | Piped stdin is capped at 10MB |
| Kiro headless V3 | Stdin when no positional instruction is supplied | None stated on the referenced page |

Sources: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive),
[Claude headless mode](https://code.claude.com/docs/en/headless),
[Kiro headless mode](https://kiro.dev/docs/cli/headless/).
These pages describe current CLI behavior, not a guarantee for every older binary.

A local Linux subprocess probe accepted a 131,071-byte single argument and rejected
131,072 bytes with E2BIG; the terminating NUL also needs space. This is an argument
transport limit, not a model limit. Total ARG_MAX does not establish the maximum
size of one argument. Kiro V3 review requests now use stdin.

## Trusted project budgets

[input_limits.py](../../scripts/pr-review/input_limits.py) owns the workflow and
specialist budgets:

| Input | Budget |
| --- | --- |
| Complete PR diff | At most 512,000 bytes and 12,000 lines |
| Trusted context | At most 24,000 bytes; this repository uses 20,000 |
| Full reviewer or chair request | Below 640,000 bytes, including instructions and framing |
| Direct Kiro AWS patch | At most 95,000 bytes and 3,000 lines |
| Chair AWS packet | At most 64,000 bytes of compact JSON |
| Complete Kiro V3 request | Below 120,000 bytes, including context, metadata and framing |

The Kiro ceilings are intentional review budgets, not claimed V3 CLI maxima.
An AWS scope exceeding the direct budget triggers one shared chair summary.
Codex and Claude retain the complete raw diff. If the summary cannot fit, account
for every metadata/hunk unit, or quote valid source evidence, required Kiro coverage
blocks. Raw input is retained privately; prefix truncation never earns coverage.
Summary uncertainties enter adjudication even if a specialist omits them.

Hash-bound unit accounting is not proof of semantic completeness. Kiro sees the
summary basis explicitly and must report insufficient detail. The two full-change
reviewers remain required. See [specialist review](../pr-review-specialists.md).

## V3 isolation and version evidence

The reviewer pins the V3 harness. Its profile uses an empty tools list, excludes all
tools, denies every capability, and disables MCP/power inclusion. Legacy allowedTools
and toolsSettings are omitted: V3 can skip an unconverted profile that has those
fields without permissions. A fresh canary and the two-role safety barrier remain
required before either Kiro process receives PR evidence.

Sources: [V3 agent configuration](https://kiro.dev/docs/custom-agents/configuration-reference/),
[permissions](https://kiro.dev/docs/permissions/).
Stub tests establish subprocess contracts; a live runner preflight establishes
whether its installed binary actually honors the profile. The workflow prints
all three CLI versions. Runner images and their update schedule belong to the
runner platform repository; changing this project's workflow does not rebuild them.
