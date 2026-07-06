variable "region" {
  default = "ap-northeast-2"
}

variable "eks_cluster_name" {
  default = "fsi-demo-cluster"
}

variable "k8s_namespace" {
  default = "claude-code"
}

variable "domain" {
  default = "atomai.click"
}

variable "dashboard_hostname" {
  default = "ccdash.atomai.click"
}

variable "ch_ingest_hostname" {
  default = "ch.atomai.click"
}

variable "clickhouse_node_instance_type" {
  description = "8세대 그래비톤 — ../aws-ec2-benchmark ClickBench 실측 가성비 1위(m8g.xlarge)"
  default     = "m8g.xlarge"
}

variable "dashboard_basic_auth_user" {
  default = "admin"
}

variable "dashboard_basic_auth_password" {
  sensitive = true
  # terraform apply -var="dashboard_basic_auth_password=..." 로 주입. 기본값 없음.
}

variable "clickhouse_writer_password" {
  sensitive = true
}

variable "clickhouse_reader_password" {
  sensitive = true
}
