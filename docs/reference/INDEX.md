# Implementation Reference Index

<!-- AUTO-MANAGED:index -->
Layer-by-layer implementation notes. Each doc is bilingual (English first, Korean second) and
follows the same structure: Overview, Components, Key Decisions, Code Pointers, Cross-references.

| Layer | Doc | Covers |
|---|---|---|
| Infrastructure | [infrastructure.md](infrastructure.md) | Docker image, EKS deployment, ECR, DNS/CDN |
| Data | [data.md](data.md) | ClickHouse schema, cumulative-counter diffing, bedrock/enterprise grouping |
| API | [api.md](api.md) | Express routes, query layer, chat SQL sandbox |
| IaC | [iac.md](iac.md) | Terraform: EKS, ClickHouse Operator, networking |
| Frontend | [frontend.md](frontend.md) | React SPA structure, shared state, data fetching |
| UI | [ui.md](ui.md) | Shared presentational components, chart primitives, theming |
| Security | [security.md](security.md) | Basic Auth, SQL sanitization, secrets handling |
| Agent · LLM | [agent-llm.md](agent-llm.md) | Bedrock chat assistant, tool-use loop |

Regenerate this table with `/sync-docs` or `/add-reference-doc <layer>` after adding a new layer.
<!-- /AUTO-MANAGED:index -->
