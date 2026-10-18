variable "backup_monitor_enabled" {
  description = "Observe backup Job health independently of the dashboard and publish a regional alarm."
  type        = bool
  default     = true
  nullable    = false
}

variable "backup_alert_email" {
  description = "Optional backup SNS email recipient. Confirm the subscription or attach an approved regional subscriber."
  type        = string
  default     = null
  validation {
    condition     = var.backup_alert_email == null ? true : can(regex("^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$", var.backup_alert_email))
    error_message = "backup_alert_email must be an email address when provided."
  }
}

variable "backup_job_deadline_seconds" {
  description = "Bound each backup Job, including retries and Pending time. Tune from measured backup duration."
  type        = number
  default     = 7200
  nullable    = false
  validation {
    condition     = var.backup_job_deadline_seconds >= 300 && var.backup_job_deadline_seconds <= 43200 && floor(var.backup_job_deadline_seconds) == var.backup_job_deadline_seconds
    error_message = "backup_job_deadline_seconds must be an integer between 300 and 43200."
  }
}

variable "backup_success_max_age_hours" {
  description = "Maximum age of the daily CronJob's last successful Job. This is not verified snapshot age."
  type        = number
  default     = 27
  nullable    = false
  validation {
    condition     = var.backup_success_max_age_hours >= 24 + var.backup_job_deadline_seconds / 3600 && var.backup_success_max_age_hours <= 168 && floor(var.backup_success_max_age_hours) == var.backup_success_max_age_hours
    error_message = "backup_success_max_age_hours must be an integer covering 24 hours plus the Job deadline, at most 168."
  }
}

resource "aws_iam_role" "backup_monitor" {
  count       = var.backup_monitor_enabled ? 1 : 0
  name_prefix = "cc-ab-backup-monitor-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.eks.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.oidc_issuer}:sub" = "system:serviceaccount:${var.k8s_namespace}:clickhouse-backup-monitor"
          "${local.oidc_issuer}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "backup_monitor" {
  count = var.backup_monitor_enabled ? 1 : 0
  name  = "publish-backup-health"
  role  = aws_iam_role.backup_monitor[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["cloudwatch:PutMetricData"]
      Resource = "*"
      Condition = {
        StringEquals = { "cloudwatch:namespace" = "ClaudeCodeDashboard/Backup" }
      }
    }]
  })
}

resource "kubernetes_service_account_v1" "backup_monitor" {
  count = var.backup_monitor_enabled ? 1 : 0
  metadata {
    name      = "clickhouse-backup-monitor"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
    annotations = {
      "eks.amazonaws.com/role-arn" = aws_iam_role.backup_monitor[0].arn
    }
  }
}

resource "kubernetes_role_v1" "backup_monitor" {
  count = var.backup_monitor_enabled ? 1 : 0
  metadata {
    name      = "clickhouse-backup-monitor"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  rule {
    api_groups     = ["batch"]
    resources      = ["cronjobs"]
    resource_names = [kubernetes_cron_job_v1.backup.metadata[0].name]
    verbs          = ["get"]
  }
  rule {
    api_groups = ["batch"]
    resources  = ["jobs"]
    verbs      = ["list"]
  }
}

resource "kubernetes_role_binding_v1" "backup_monitor" {
  count = var.backup_monitor_enabled ? 1 : 0
  metadata {
    name      = "clickhouse-backup-monitor"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.backup_monitor[0].metadata[0].name
  }
  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account_v1.backup_monitor[0].metadata[0].name
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
}

resource "aws_sns_topic" "backup_alerts" {
  count       = var.backup_monitor_enabled ? 1 : 0
  name_prefix = "claude-code-backup-alerts-"
}

resource "aws_sns_topic_subscription" "backup_alerts_email" {
  count     = var.backup_monitor_enabled && var.backup_alert_email != null ? 1 : 0
  topic_arn = aws_sns_topic.backup_alerts[0].arn
  protocol  = "email"
  endpoint  = var.backup_alert_email
}

resource "aws_cloudwatch_metric_alarm" "backup_health" {
  count               = var.backup_monitor_enabled ? 1 : 0
  alarm_name          = "claude-code-${var.eks_cluster_name}-${var.k8s_namespace}-backup-health"
  alarm_description   = "Backup failed, overdue, never completed, stale, suspended, unobservable, or monitor stopped. Job completion does not prove restore usability."
  namespace           = "ClaudeCodeDashboard/Backup"
  metric_name         = "Unhealthy"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  dimensions = {
    ClusterName = var.eks_cluster_name
    Namespace   = var.k8s_namespace
    CronJob     = kubernetes_cron_job_v1.backup.metadata[0].name
  }
  alarm_actions = [aws_sns_topic.backup_alerts[0].arn]
  ok_actions    = [aws_sns_topic.backup_alerts[0].arn]
}

resource "kubernetes_cron_job_v1" "backup_monitor" {
  count = var.backup_monitor_enabled ? 1 : 0
  metadata {
    name      = "clickhouse-backup-monitor"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  spec {
    schedule                      = "*/5 * * * *"
    concurrency_policy            = "Forbid"
    starting_deadline_seconds     = 180
    successful_jobs_history_limit = 1
    failed_jobs_history_limit     = 1
    job_template {
      metadata {}
      spec {
        active_deadline_seconds = 120
        backoff_limit           = 0
        template {
          metadata {}
          spec {
            service_account_name            = kubernetes_service_account_v1.backup_monitor[0].metadata[0].name
            automount_service_account_token = true
            restart_policy                  = "Never"
            node_selector                   = local.ch_node_selector
            toleration {
              key      = "claude-code"
              operator = "Equal"
              value    = "true"
              effect   = "NoSchedule"
            }
            security_context {
              run_as_non_root = true
              run_as_user     = 1000
              run_as_group    = 1000
              seccomp_profile {
                type = "RuntimeDefault"
              }
            }
            container {
              name    = "monitor"
              image   = "${aws_ecr_repository.dashboard.repository_url}:${var.dashboard_image_tag}"
              command = ["node", "server/backupHealth.js"]
              env {
                name  = "BACKUP_NAMESPACE"
                value = var.k8s_namespace
              }
              env {
                name  = "BACKUP_CLUSTER_NAME"
                value = var.eks_cluster_name
              }
              env {
                name  = "AWS_REGION"
                value = var.region
              }
              env {
                name  = "AWS_STS_REGIONAL_ENDPOINTS"
                value = "regional"
              }
              env {
                name  = "AWS_EC2_METADATA_DISABLED"
                value = "true"
              }
              env {
                name  = "BACKUP_MAX_AGE_SECONDS"
                value = tostring(var.backup_success_max_age_hours * 3600)
              }
              env {
                name  = "BACKUP_JOB_DEADLINE_SECONDS"
                value = tostring(var.backup_job_deadline_seconds)
              }
              resources {
                requests = { cpu = "25m", memory = "64Mi" }
                limits   = { cpu = "100m", memory = "256Mi" }
              }
              security_context {
                allow_privilege_escalation = false
                read_only_root_filesystem  = true
                capabilities {
                  drop = ["ALL"]
                }
              }
            }
          }
        }
      }
    }
  }
  depends_on = [kubernetes_role_binding_v1.backup_monitor, aws_iam_role_policy.backup_monitor]
}

output "backup_alert_topic_arn" {
  description = "Regional backup alert topic. Delivery requires a confirmed authorized subscriber."
  value       = one(aws_sns_topic.backup_alerts[*].arn)
}

output "backup_health_alarm_name" {
  value = one(aws_cloudwatch_metric_alarm.backup_health[*].alarm_name)
}
