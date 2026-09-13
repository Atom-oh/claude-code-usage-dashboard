# ADR-005: Telemetry freshness webhook and optional edge error alarm

- Status: Accepted
- Date: 2026-09-03
- Reconciled: 2026-09-13

## Context

A recorded collector failure after a DNS timeout left roughly 43 hours of missing telemetry
while the dashboard process remained reachable. Browser polling of `/api/health/data` could
show `stale` or `unknown`, but could not notify anyone when no one was watching.

## Decision

Implement two independent notification paths:

| Path | Trigger | Configuration |
|---|---|---|
| In-app freshness webhook | Two consecutive non-ok 60-second ticks; repeat while non-ok and one recovery transition | `ALERT_WEBHOOK_URL`, `ALERT_REPEAT_MINUTES` (default 60) |
| CloudFront edge errors | Average `5xxErrorRate` above 5% for two five-minute periods | Optional Terraform `alert_email`, SNS email subscription |

[alerting.js](../../dashboard/server/alerting.js) reuses the existing freshness snapshot,
posts Slack-compatible `{"text": ...}` JSON, and logs delivery status/error names without
the token-bearing URL. The first tick is after 60 seconds. The loop is not started without
a webhook URL; boot still validates the repeat setting. Delivery failures do not crash the
server, and the in-memory planner is not a durable notification queue.

[alerting.tf](../../infra/alerting.tf) declares the edge alarm/SNS resources in `us-east-1`,
with missing traffic treated as non-breaching. A recipient must confirm the SNS subscription.
An accepted decision and a Terraform declaration are not evidence of enabled delivery.

## Rationale and alternatives

Debouncing avoids alerting on every transient startup or DNS failure. The in-process sender
can detect stale telemetry but cannot notify while its own process is down; the edge alarm
covers that separate failure surface, without claiming full availability monitoring.

A CronJob polling the authenticated endpoint would duplicate Basic Auth handling. A synthetic
canary was deferred for cost and credential-management overhead. Adding a new
Prometheus/Alertmanager stack solely for this feature was disproportionate; this is not an
assertion about everything installed in the target cluster. Leader election to suppress
replica duplicates was also rejected as unnecessary complexity for the current audience.

## Consequences

Each replica maintains independent alert state; multiple replicas can send equivalent
messages distinguished by hostname. Restarting a replica resets that state. Coverage is
freshness plus edge 5xx, **not backup CronJob failures**. A recovery message does not prove
missing telemetry was recovered, and a sent notification is not proof of receipt.

Treat the webhook URL, Terraform state, and Kubernetes Secret as sensitive. Disabling either
path is independent: set its Terraform input to `null`, apply, and verify the result.
Webhook enablement changes the pod template; a Secret-only rotation requires a fresh pod.
An email/alarm-only change does not roll the dashboard. Use the
[alerting runbook](../runbooks/alerting.md) for delivery checks and incident response.
