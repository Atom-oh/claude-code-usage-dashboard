variable "region" {
  default = "ap-northeast-2"
}

variable "eks_cluster_name" {
  default = "fsi-demo-cluster"
}

variable "k8s_namespace" {
  default = "claude-code"
}

# Ask Claude 챗이 호출하는 Bedrock 모델(inference profile id). 변경 시 env(CHAT_MODEL_ID)와
# IAM policy의 foundation-model/inference-profile ARN이 이 변수 하나로 함께 좁혀진다.
variable "chat_model_id" {
  default = "global.anthropic.claude-sonnet-5"
}

# Bedrock ConverseStream 호출 리전. var.region(EKS/ClickHouse 리전)과 독립 — 워크샵 계정으로
# 이식할 때는 us-west-2(Bedrock 허용 리전만)로 바꾼다. 지금 이 admin 환경은 워크샵 계정이
# 아니라 리전 제한이 없으므로 var.region과 동일한 ap-northeast-2. 빈 문자열이면 env 주입을
# 생략하고 AWS_REGION을 따른다.
variable "bedrock_region" {
  default = "ap-northeast-2"
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
