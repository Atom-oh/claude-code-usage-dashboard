# ADR-010: English documentation and shared review context

- Status: Accepted
- Date: 2026-09-13
- Supersedes: ADR-007's bilingual documentation requirement only

## Context

Duplicated translations, historical assertions, and inconsistent cost or UI guidance
increase review context and have contributed to unsupported findings. Kiro reviewers
cannot inspect arbitrary repository files, so a diff alone omits relevant conventions.

## Decision

Maintain concise English-only project documentation. Keep current agent instructions
in root/scoped `AGENTS.md` and use adjacent `CLAUDE.md` imports. Keep detailed references,
procedures, and historical decisions in their own documents.

Provide bounded, trusted base-revision project context to the review panel. Distinguish
that baseline from proposed changes and untrusted diff instructions. Preserve the
existing no-tools, coverage, severity, and current-head verification requirements.

Product UI localization remains under ADR-007. This decision changes neither runtime
labels nor API, calculation, schema, or deployment behavior.

## Consequences

One maintained language and one owner per rule reduce duplication. Reviewers receive
relevant conventions, but must still verify claims against code; context does not
guarantee a correct model verdict. Historical records remain useful when explicitly dated
and non-normative. See [documentation policy](../documentation-policy.md).
