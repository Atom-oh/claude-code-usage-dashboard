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
