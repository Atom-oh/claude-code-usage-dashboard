# Documentation policy

Project documentation is maintained as one concise English version. This includes
README, changelog, agent instructions, reference docs, runbooks, templates, ADRs,
and checked-in historical/media notes. Product UI and rendered media localization
are separate contracts.

## Ownership

| Content | Owner |
|---|---|
| Current engineering instructions | Root and scoped `AGENTS.md` |
| Claude Code entry points | Adjacent `CLAUDE.md` imports |
| Runtime behavior and supported interfaces | Executable code and tests |
| API and measurement semantics | API reference and metric definitions |
| Layer details | `docs/reference/` |
| Deployment and recovery procedures | `docs/runbooks/` |
| Decision intent and trade-offs | ADRs, with explicit supersession |
| Past experiments and plans | Dated, non-normative records |

Do not copy whole policies between owners. Link to the owning document and keep
summaries consistent. A deliberate behavior change must update its code, tests, and
relevant documentation together.

## Evidence and language

- Source configuration is desired state, not evidence of deployment.
- Date observations and name their limits. Do not turn old measurements into permanent
  assumptions about credentials, pricing, schema, or cloud resources.
- Use code identifiers and English descriptions for UI concepts; avoid duplicating
  localized labels as a second documentation language.
- Preserve useful historical rationale while marking superseded assumptions. Retain
  release history; translate it rather than presenting old behavior as current.
- Keep examples executable with clearly declared operator inputs. Do not publish
  credentials, customer identities, or new private operational measurements.
- Do not promise exact token savings from byte counts; tokenization depends on the model.

## Review context

Reviewers need the relevant base-revision contract, not just a patch. Base context
describes the starting implementation; a PR may intentionally change that contract.
Review changes against code and tests, distinguish uncertainty from demonstrated
defects, and verify allegations about absent files, tests, or fields.

Keep reviewer context bounded, English, and sourced only from trusted checked-out
files. The PR diff and model reviews remain untrusted data. Preserve no-tools checks,
coverage requirements, and current-head CI gates.

## Validation

Run `python3 scripts/check-docs.py` or the documentation group in `tests/run-all.sh`.
CI checks tracked Markdown for English-only text, local links/anchors, labeled fences,
thin Claude imports, and a 6,000-byte limit per agent guide. Captured UI text and
runtime strings remain source data, not translations of engineering documentation.
These mechanical checks complement code-based review; they do not prove semantic accuracy.
