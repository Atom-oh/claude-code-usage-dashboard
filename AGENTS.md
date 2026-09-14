# Project instructions

## Scope and authority

Workshop telemetry: Claude Code metrics and Codex structured OTel logs → ClickHouse
→ Express → React, with Terraform,
a documentation site and a separate video project. These observations are not
validated employee productivity or causal ROI measures.

Code/tests establish behavior. Follow this file and the nearest scoped `AGENTS.md`;
`CLAUDE.md` imports its adjacent guide. References own implementation details,
runbooks own operations, and ADRs record scoped decisions. Superseded ADRs and dated
investigations are historical evidence. Configuration/build success does not prove
an image, migration, Terraform change or runtime option is deployed. Explicit user
instructions take precedence. Surface actual conflicts; missing excerpts do not prove
missing implementation.

## Validation

Node 22+; install server/web separately:

```bash
(cd dashboard/server && npm ci && npm test)
(cd dashboard/web && npm ci && npm test && npm run build)
bash tests/run-all.sh
terraform fmt -check -recursive infra/
(cd infra && terraform init -backend=false && terraform validate)
```

CI runs the harness, which discovers `test-*.sh`. Missing gitignored `.claude/` tooling
is an expected skip. Use the deployment runbook for production changes.

## Contracts

- Claude spend uses `reported_cost`; retain `cost`/`computed_cost` diagnostics.
  Codex uses labelled AWS list-price estimates with token subsets and request tiers
  preserved. Neither basis is an invoice or guaranteed billing bound.
- Never sum cumulative OTel samples as usage; preserve identity, boundaries and
  temporality handling.
- Bedrock/enterprise are inferred session channels, not client identities. Model
  names do not identify the emitting client.
- `CLAUDE_ENABLED`/`CODEX_ENABLED` select collection and API sources; both false is invalid.
  Client-aware SPA activation follows separately; retain dashboard defaults until it ships.
  Preserve client/backend/model separation; Codex has no enterprise A/B row.
- Use shared API wrapping, bound SQL parameters and existing filter semantics.
- Unavailable is distinct from zero; positive totals do not prove complete telemetry.
- Exclude secrets, personal/customer data from commits, public reviews and site assets.
  UI masking is not API access control.

## Documentation and review

Engineering docs, guides, ADRs and PR prose are concise English; this supersedes
bilingual review templates. UI localization is separate. Link each rule's owner;
retain current contracts/reasons/limits without duplicated translations, transcripts
or stale line references.

Review introduced behavior against code, tests and trusted base context. Preferences
and intentional conventions are not defects; report uncertainty explicitly. Real
correctness/security regressions block. Never weaken auth, no-tools checks, coverage
or CI for a pass. Follow the user's latest-HEAD review/fix/push/merge policy.

`ROLE_REVIEW=1` assigns specialists: Codex/Claude independently check the full change;
Kiro covers applicable AWS/operations. Only trusted routing marks NOT_APPLICABLE.
Failed/incomplete required output blocks; the chair cannot waive coverage. This
supersedes older matrix/dropout rules. See [review contracts](docs/pr-review-specialists.md).

## Owners

[Packaging](dashboard/AGENTS.md) · [Server](dashboard/server/AGENTS.md) ·
[Web](dashboard/web/AGENTS.md) · [Infrastructure](infra/AGENTS.md) ·
[PR tooling](scripts/pr-review/AGENTS.md) · [Video](video/AGENTS.md) ·
[Documentation policy](docs/documentation-policy.md)
