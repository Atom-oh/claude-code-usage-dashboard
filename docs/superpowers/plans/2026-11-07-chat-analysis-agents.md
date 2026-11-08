# Chat and analysis agents

The user approved separate agents and selected Haiku 5.5 for ordinary chat and
Sonnet 5.5 for analysis. Extend the existing chat endpoint in place, preserving
the current main branch's pricing, security and telemetry contracts.

- [x] Give Haiku a small conversation prompt and one `analyze_data` delegation
  tool. Give Sonnet the existing schema prompt and bounded SQL loop. Maintain
  separate histories: signed thinking must never cross model boundaries.
- [x] Keep one admission slot, rate slot and 180-second cancellation signal per
  HTTP turn. Allow one delegation, four analysis rounds plus a tool-free summary,
  eight SQL/usage-summary attempts, and a tool-free Haiku answer.
- [x] Add fixed bar, stacked bar and line charts using existing Recharts.
  `show_chart` selects stored result columns; it cannot supply executable code
  or invented numeric data. Bound charts, rows and series; preserve nulls,
  masking and truncation labels. Do not resend chart arrays in later history.
- [x] Test routing, cancellation, exhaustion, tool rejection, chart source
  validation, SSE transport, retained chart messages and both chat surfaces.
- [x] Configure both model IDs and exact Bedrock IAM resources in Terraform.
  Validate mock routing plans without applying infrastructure.
- [x] Update the chat reference and run server/web tests, web build, relevant
  shell checks and Terraform validation. Review the scoped change before finishing.

The host implements the approved change. No deployment is requested. Chart
templates save generated code and repeated data tokens; total token/cost savings
require measurement and are not guaranteed by splitting model calls.

The PR is based on the current main branch. Its analysis prompt uses live pricing
at the start of each HTTP turn and pins the table throughout signed tool rounds.
Verification covers server/web tests, web build, shell checks, three mocked
Bedrock routing plans, Terraform fmt/validate and documentation links.
Synthetic browser fixtures rendered all three chart types in both chat surfaces
and at mobile width without page errors. Real ClickHouse integration checks
require their configured fixture environment. No live dashboard model invocation
or infrastructure rollout was performed.
