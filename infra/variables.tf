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

# 이메일 마스킹(앞 2글자 + ****** + @도메인). 이 배포는 공개 URL(dashboard_hostname)로 데모를
# 돌리므로 true. 워크샵 계정에 이식할 때는 false — 이메일이 {accountid}@ws 형태의 가짜 주소라
# 개인정보가 아니고, 참가자가 리더보드에서 자기 행을 찾아야 한다. 앱 자체 기본값은 false(env가
# 없으면 마스킹 안 함)지만 이 변수 기본값은 true — 즉 표준 Terraform 배포는 마스킹 ON으로 나가고,
# 워크샵 계정 쪽에서 false로 끄는 구조다(docs/api-reference.md의 two-layer default 설명과 동일).
variable "pii_mask_enabled" {
  type    = bool
  default = true
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
