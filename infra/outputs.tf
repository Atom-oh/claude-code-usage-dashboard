output "dashboard_url" {
  value = "https://${var.dashboard_hostname}"
}

output "ch_ingest_url" {
  value = "https://${var.ch_ingest_hostname}"
}

output "ecr_repository_url" {
  value = aws_ecr_repository.dashboard.repository_url
}

output "clickhouse_backup_bucket" {
  value = aws_s3_bucket.clickhouse.bucket
}

output "alert_topic_arn" {
  description = "CloudFront 5xx 알람이 발송하는 SNS 토픽 ARN. alert_email이 null이면 null — 조직이 모듈을 수정하지 않고 두 번째 구독자(PagerDuty, AWS Chatbot 경유 Slack)를 붙일 수 있게 내보낸다."
  value       = one(aws_sns_topic.dashboard_alerts[*].arn)
}
