# Runbook: Telemetry, Edge and Backup Alerting

## What is implemented

| Signal | Source and trigger | Delivery and enablement |
|---|---|---|
| Data freshness | `dashboard/server/alerting.js`: two consecutive non-ok 60-second ticks | Slack-compatible POST when `ALERT_WEBHOOK_URL` is set |
| Edge errors | `infra/alerting.tf`: CloudFront average `5xxErrorRate` above 5% for two 5-minute periods | SNS email when `alert_email` is non-null |
| Backup scheduling health | `infra/backup-monitor.tf` and `dashboard/server/backupHealth.js`: independent five-minute CronJob, two unhealthy/missing points in three five-minute periods | Regional SNS topic when `backup_monitor_enabled`; confirmed `backup_alert_email` or an attached authorized subscriber |

The in-app loop cannot report the dashboard process being down. The edge alarm does not
measure ingestion freshness and treats missing traffic as non-breaching. Backup observation
is independent of the dashboard and reads Kubernetes Job status, not DB rows or S3 objects.
Terraform declarations do not prove that any alert or recipient is live.

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

## Backup observation

`backup_monitor_enabled` defaults to true. Before first creation, set `dashboard_image_tag`
to a published, reviewed immutable release containing `server/backupHealth.js` and its
CloudWatch SDK dependency. It seeds the observer image; Terraform ignores later image
changes. Every subsequent release refreshes both workload images through
[deployment](deploy-production.md#refresh-the-backup-observer), with a separate observer
rollback image. This prevents the initial observer tag aging out of ECR's ten-image retention.

The worker reads the named CronJob and at most 500 namespace Jobs in five bounded pages.
It selects controller owners by the current CronJob UID, so old/recreated/foreign Jobs do
not establish success. RBAC permits namespace Job listing and the named CronJob read,
with no Secret, pod-log, exec, SQL or S3 access. Job listing can expose Job specifications;
it is not a field-level RBAC restriction. Responses are capped at 2 MiB per page.

Suspended schedules, newer terminal failures, overdue Pending/running Jobs, no successful
Job, success older than `backup_success_max_age_hours` (default 27), missing active Job
records and unavailable/malformed status emit `Unhealthy=1`. Intermediate retry counts
are not terminal failures. Older failures clear after a newer success. Logs expose only
the health reason and last-success age, without API response bodies or credentials.

The worker has a 40-second cancellation budget and a 120-second Job deadline, no Job
retries, at most one active instance, and 100m CPU/256 MiB limits. It uses a dedicated IRSA
role restricted to `PutMetricData` in `ClaudeCodeDashboard/Backup`. No per-user, per-Job or
per-table metric dimensions are emitted. Disabling monitoring removes its resources.

The alarm treats missing metrics as breaching to cover a stopped monitor or cluster.
CloudWatch can retrieve older real points before filling missing periods; two-of-three
evaluation is not an exact ten-minute outage-detection guarantee. See AWS
[missing-data evaluation](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-missing-data.html).
SNS notifies on state transitions, not repeated paging while the alarm stays active.
First enablement can notify before healthy datapoints arrive; a new installation
without a successful backup also legitimately reports unhealthy.

Configure and confirm `backup_alert_email`, or attach an authorized regional subscriber
to `backup_alert_topic_arn`. A topic without a confirmed subscriber does not deliver
alerts. These resources use `var.region`, independently of the edge topic in `us-east-1`.

```bash
: "${REGION:?Set the installation region}"
kube get cronjob clickhouse-backup-monitor
kube get jobs --sort-by=.metadata.creationTimestamp
BACKUP_ALARM=$(terraform -chdir=infra output -raw backup_health_alarm_name)
BACKUP_TOPIC=$(terraform -chdir=infra output -raw backup_alert_topic_arn)
aws cloudwatch describe-alarms --region "$REGION" --alarm-names "$BACKUP_ALARM"
aws sns list-subscriptions-by-topic --region "$REGION" --topic-arn "$BACKUP_TOPIC"
```

Inspect the actual worker image/role/budgets and recent redacted worker logs. Check all
three metric dimensions (`ClusterName`, `Namespace`, `CronJob`) against the alarm, and
verify normal points and recovery. With approval for a test notification, change only the
backup alarm's temporary state and confirm receipt; do not suspend production backups,
alter Job status or stop the cluster as an alert drill. Automatic evaluation resets a
temporary alarm state.

Job completion is not evidence of complete backup objects, a usable restore, measured RPO
or RTO. Perform the object inspection and isolated drill in
[backup and restore](backup-and-restore.md).

## Respond and silence

`STALE` means the newest raw metric is older than the freshness threshold; `UNKNOWN`
means measurement failed or the probe window contains no rows. Follow
[incident response](incident-response.md) for either. Investigate an edge 5xx alarm before
choosing application rollback. A recovery notification confirms the signal cleared, not
that lost telemetry was recovered.

To disable webhook or edge delivery, set its variable to `null`; to remove backup
monitoring, set `backup_monitor_enabled=false`. Apply the reviewed plan and verify the
result. The three paths are independent. Record any intentional silence and
restore the prior settings after the incident; rerun delivery verification.
