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
- [x] Server: `show_chart` selects stored result columns and emits a `chart` SSE
  event; it cannot supply executable code or invented numeric data. Bound charts,
  rows and series; preserve nulls, masking and truncation labels. Do not resend
  chart arrays in later history.
- [x] Web: `useChatStream.js` validates `chart` events with `chatCharts.js`, keeps
  them on the assistant message and excludes them from the request history;
  `ChatCharts.jsx` renders fixed bar, stacked-bar and line Recharts templates with
  an accessible data table in both FloatingChat and Analytics.
- [x] Request adaptive summarized thinking only for the analysis agent; the
  conversation request omits `additionalModelRequestFields` because Haiku 5.5
  acceptance of that shape was not verified with a live call.
- [x] Tests: server routing, cancellation, exhaustion, tool rejection, chart
  source validation, SSE transport and per-agent request fields; web stream-reader
  chart validation, `ChatCharts` rendering, and chart figures with text-only
  resend in both chat surfaces (jsdom with Recharts mocked).
- [x] Configure both model IDs and exact Bedrock IAM resources in Terraform; three
  mocked routing plans in `infra/test-fixtures/bedrock-routing.tftest.hcl`, not
  applied.
- [x] Update the chat reference, API reference, chat troubleshooting runbook,
  workshop notes and CHANGELOG.

The host implements the approved change. No deployment is requested. Chart
templates save generated code and repeated data tokens; total token/cost savings
require measurement and are not guaranteed by splitting model calls.

Verification commands for this PR: server `npm test`; web `npm test` and
`npm run build`; `bash tests/run-all.sh`; `terraform fmt -check -recursive infra/`
and `terraform validate`. Not performed: synthetic browser rendering, live Bedrock
invocation of either model, IAM or infrastructure rollout, and real ClickHouse
integration checks. Source defaults and mock plans prove neither model access nor
deployment. Installations relying on the previous `chat_model_id` default switch
models and lose the old model's invoke grant in the same apply.
