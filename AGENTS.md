# Project instructions

## Scope

This repository is a workshop telemetry dashboard: Claude Code metrics and Codex
structured OTel logs feed ClickHouse; an Express API serves a React SPA. It also contains Terraform, a static
documentation site, and a separate video project. It is not a validated employee
productivity or causal ROI measurement system.

## Sources of truth

- Read executable code and tests to establish current behavior.
- Follow this file and the nearest scoped `AGENTS.md` for engineering conventions.
  `CLAUDE.md` files import their adjacent `AGENTS.md`; do not duplicate their rules.
- Use `docs/reference/` for implementation details and `docs/runbooks/` for operations.
- ADRs record decisions and their scope. Superseded decisions and dated investigations
  are historical evidence, not instructions to restore old behavior.
- Repository configuration describes intended state. It does not prove a migration,
  Terraform change, image, or runtime option is deployed.
- Explicit user instructions take precedence. Surface real code/document conflicts;
  do not silently treat a missing excerpt as a missing implementation.

## Commands

Node.js 22 or newer is required. Server and web packages are installed separately.

```bash
(cd dashboard/server && npm ci && npm test)
(cd dashboard/web && npm ci && npm test && npm run build)
bash tests/run-all.sh
terraform fmt -check -recursive infra/
(cd infra && terraform init -backend=false && terraform validate)
```

`tests/run-all.sh` discovers `test-*.sh`; `.github/workflows/ci.yml` runs it.
Missing gitignored `.claude/` tooling is an expected skip, not a repository defect.
Use the deployment runbook for production changes; a successful build is not a deployment.

## Core contracts

- Claude spend uses `reported_cost`, retaining `cost`/`computed_cost` diagnostics.
  Codex uses labelled AWS list-price estimates, with cache subsets and context/inference
  tiers handled before aggregation. Neither source is an invoice.
- Never sum cumulative OTel samples as usage. Preserve counter identity, query
  boundaries, and the existing temporality handling.
- `bedrock` and `enterprise` are inferred session channels, not coding clients.
  A model name does not identify Claude Code, Codex, or another emitting client.
- Use the shared API route wrapper, parameterized queries, and existing filter rules.
- Distinguish unavailable measurements from measured zero. A positive aggregate does
  not establish complete telemetry.
- Keep secrets and personal or customer data out of commits, public review comments,
  and site assets. Client-side display masking is not an API access-control boundary.
- `CLAUDE_ENABLED`/`CODEX_ENABLED` select collection and API sources; both false is invalid.
  Client-aware SPA activation is a separate release step; keep dashboard defaults until it ships.
  Preserve client/backend/model separation. Codex never becomes an enterprise A/B row.

## Documentation and review

Maintain project documentation and PR review prose in concise English. Product UI
localization is a separate decision; this policy does not translate the application.
Prefer one owner for each rule and link to it. Document current contracts, reasons,
and limitations; avoid duplicated translations, review transcripts, and stale line numbers.

Review introduced behavior against code, tests, and the trusted base-revision context.
An intentional convention is not a defect merely because a reviewer prefers another
design. Report uncertainty as such. Real correctness or security regressions still block.
Never weaken authentication, no-tools checks, review coverage, or CI to obtain a pass.
Follow the user's current-head review, fix, push, and merge policy.

## Scoped guidance

- [Application packaging](dashboard/AGENTS.md)
- [Server and ClickHouse](dashboard/server/AGENTS.md)
- [Web UI](dashboard/web/AGENTS.md)
- [Infrastructure](infra/AGENTS.md)
- [PR review tooling](scripts/pr-review/AGENTS.md)
- [Video](video/AGENTS.md)
- [Documentation policy](docs/documentation-policy.md)

## Specialist PR review

CI enables `ROLE_REVIEW=1`: one applicable responsibility per model instead of
repeating every lens. See [the current review contract](docs/pr-review-specialists.md).
Codex and Claude retain full change-boundary checks from independent model families;
Kiro covers AWS and operational responsibilities when applicable. Trusted routing
owns NOT_APPLICABLE. Failed or incomplete required output is never a clean review.
The chair adjudicates substantive candidates; it cannot waive coverage failures.
This section supersedes earlier matrix-count and permissive dropout descriptions.

PR review instructions, guides, related ADRs and review output are English-only.
This scoped policy supersedes older bilingual review-document templates; product
localization is a separate contract.
