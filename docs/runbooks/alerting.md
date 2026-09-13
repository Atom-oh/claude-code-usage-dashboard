# Runbook: Telemetry and Edge Alerting

## What is implemented

| Signal | Source and trigger | Delivery and enablement |
|---|---|---|
| Data freshness | `dashboard/server/alerting.js`: two consecutive non-ok 60-second ticks | Slack-compatible POST when `ALERT_WEBHOOK_URL` is set |
| Edge errors | `infra/alerting.tf`: CloudFront average `5xxErrorRate` above 5% for two 5-minute periods | SNS email when `alert_email` is non-null |

The in-app loop cannot report the dashboard process being down. The edge alarm does not
measure ingestion freshness and treats missing traffic as non-breaching. Neither monitors
backup CronJob failures. Terraform declarations are not evidence that either alert is live.

## Enable and verify

Supply `alert_webhook_url` through the approved secret workflow into a protected,
gitignored `infra/secrets.auto.tfvars`; never put the token-bearing URL in examples,
committed files, shell history, or logs. `alert_repeat_minutes` defaults to 60.
Set the non-secret `alert_email` recipient separately and review/apply the Terraform plan.

Enabling/disabling the webhook changes the pod template. Rotating only its Secret value
does not itself restart pods; refresh workers through a controlled dashboard restart and
verify rollout. Changing `alert_email` changes AWS alarm/SNS resources, not the dashboard
Deployment. Edge resources use the `us-east-1` provider because that is where this stack
queries CloudFront metrics.

Use `kube` from [incident response](incident-response.md):

```bash
kube rollout status deployment/dashboard --timeout=120s
kube logs -l app=dashboard --tail=100 --prefix | grep -i alert
aws cloudwatch describe-alarms --region us-east-1 \
  --alarm-names claude-code-dashboard-5xx-rate
TOPIC_ARN=$(terraform -chdir=infra output -raw alert_topic_arn)
aws sns list-subscriptions-by-topic --region us-east-1 --topic-arn "$TOPIC_ARN"
```

Only run the SNS query when the topic is enabled. Confirm the intended distribution and
recipient, then complete the SNS subscription confirmation. A pending subscription is not
delivery coverage. With authorization to send a test message, use the approved secret-aware
webhook client and confirm receipt; do not put the webhook URL in a command transcript.

The app's first tick occurs after 60 seconds. It sends one recovery message after the
non-ok state clears and repeats ongoing alerts at the configured interval. Each replica
alerts independently; two replicas can produce two messages with different pod names
([ADR-005](../decisions/ADR-005-outbound-webhook-alerting.md)). Delivery failures log
`alert webhook failed` with status/error information, not the webhook URL.

## Respond and silence

`STALE` means the newest raw metric is older than the freshness threshold; `UNKNOWN`
means measurement failed or the probe window contains no rows. Follow
[incident response](incident-response.md) for either. Investigate an edge 5xx alarm before
choosing application rollback. A recovery notification confirms the signal cleared, not
that lost telemetry was recovered.

To disable one path, set its variable to `null`, apply the reviewed plan, and verify the
result. Webhook and edge alerting are independent. Record any intentional silence and
restore the prior settings after the incident; rerun delivery verification.
