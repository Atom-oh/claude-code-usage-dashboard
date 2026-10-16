# Project

## Scope

Workshop Claude Code/Codex OTel → ClickHouse → Express → React; Terraform/docs site/separate video project. Not validated employee productivity/causal ROI.

Behavior: code/tests. Follow this/nearest scoped AGENTS.md; CLAUDE.md imports adjacent guide. References: implementation; runbooks: operations; ADRs: scoped decisions. Superseded ADRs/dated investigations: historical evidence. Config/build success does not prove deployed images/migrations/Terraform changes/runtime options. Explicit user instructions win. Surface actual conflicts; missing excerpts do not prove missing implementation.

## Checks

Node 22.12+; install server/web separately:

```bash
(cd dashboard/server && npm ci && npm test)
(cd dashboard/web && npm ci && npm test && npm run build)
bash tests/run-all.sh
terraform fmt -check -recursive infra/
(cd infra && terraform init -backend=false && terraform validate)
```

CI harness discovers test-*.sh; absent gitignored .claude/ tooling: expected skip. Production: deployment runbook.

## Contracts

- Claude spend: reported_cost; retain cost/computed_cost diagnostics. Codex/non-Anthropic Claude (ADR-017): AWS list estimates; retain token subsets/tiers. Neither basis is an invoice/guaranteed billing bound.
- Never sum cumulative OTel samples as usage; keep identity/boundaries/temporality.
- Bedrock/enterprise: inferred session channels, not clients; model names do not identify emitting clients.
- CLAUDE_ENABLED/CODEX_ENABLED select collection/views; both false invalid. Separate client/backend/model; no Codex enterprise A/B row.
- Use shared API wrapping, bound SQL parameters, existing filter semantics.
- Codex metrics/traces are diagnostic feeds; never add them to completion-log usage/cost: [interpretation](docs/reference/codex-observability.md).
- Unavailable differs from zero; positive totals do not prove complete telemetry.
- Shared views: known costs/observed_tokens, partial flags; all-unknown unavailable. Strict canonical tokens for ratios: [coverage](docs/decisions/ADR-014-observed-token-subtotals.md).
- No secrets/personal/customer data in commits/public reviews/site assets. UI masking is not API access control.

## Review

Engineering docs/guides/ADRs/PR prose: concise English over bilingual review templates; separate UI localization. Link owners; keep contracts/reasons/limits, no duplicate translations/transcripts/stale line refs.

Review new behavior using code/tests/trusted base. Preferences/intentional conventions are not defects; report uncertainty. Correctness/security regressions block. Never weaken auth/no-tools checks/coverage/CI to pass. Follow user's latest-HEAD review/fix/push/merge.

ROLE_REVIEW=1: Codex/Claude independently check full change; Kiro: applicable AWS/operations. NOT_APPLICABLE only via trusted routing. Required failed/incomplete output blocks; no chair coverage waiver. Supersedes matrix/dropout rules: [review](docs/pr-review-specialists.md).

## Owners

[Package](dashboard/AGENTS.md); [Server](dashboard/server/AGENTS.md);
[Web](dashboard/web/AGENTS.md); [Infra](infra/AGENTS.md);
[PR](scripts/pr-review/AGENTS.md); [Video](video/AGENTS.md);
[Policy](docs/documentation-policy.md)
