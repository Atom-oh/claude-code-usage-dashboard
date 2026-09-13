# Implementation References

Read the root [AGENTS.md](../../AGENTS.md) for canonical developer instructions.
These English references describe source behavior, not proof of a live deployment.
Use scoped module instructions for changes and probes or migration evidence for runtime claims.
Follow the shared [documentation policy](../documentation-policy.md) for language and ownership.

<!-- AUTO-MANAGED:index -->
| Reference | Scope |
|---|---|
| [Infrastructure](infrastructure.md) | Application image, local stack, runtime and health checks |
| [Data](data.md) | Schema, counter differences, time boundaries, identity and channel inference |
| [API implementation](api.md) | Validation, filters, caching and query ownership |
| [Infrastructure as code](iac.md) | Terraform resources, prerequisites and deployment ownership |
| [Frontend](frontend.md) | Routes, runtime configuration, range/filter state and fetching |
| [UI](ui.md) | Shared components, spend formatting, tables and CSV |
| [Security](security.md) | Authentication, SQL restrictions, masking and retention limits |
| [Chat assistant](agent-llm.md) | Bedrock tool loop, SSE protocol and implementation limits |
<!-- /AUTO-MANAGED:index -->

For specific tasks, use the [API contract](../api-reference.md),
[metric definitions](../metrics.md), [onboarding guide](../onboarding.md),
[architecture](../architecture.md), or [organization deployment guide](../deploying-for-your-org.md).
Keep this index aligned with the files in this directory.
