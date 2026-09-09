variable "dashboard_image_tag" {
  description = "ECR에 push된 이미지 태그. 첫 apply 시점엔 아직 이미지가 없을 수 있음 — push 후 재배포. 기본값 없음 — ECR 리포지터리가 IMMUTABLE이라 움직이는 `latest`가 존재하지 않는다(ecr.tf). 첫 apply 전에 이미지를 push하고 그 타임스탬프 태그를 지정한다."
}

variable "data_stale_minutes" {
  description = "GET /api/health/data가 stale로 판정하는 기준(분). 서버 기본값과 같은 360."
  type        = number
  default     = 360
}

variable "group_mode" {
  description = "서버 GROUP_MODE. ab는 bedrock/enterprise 쌍 비교, single은 채널이 하나인 조직(SPA가 빈 두 번째 카드를 그리지 않음). 서버는 이 둘 외의 값이면 기동 실패(index.js) — 롤아웃까지 가지 않게 여기서 먼저 거른다."
  type        = string
  default     = "ab"
  validation {
    condition     = contains(["ab", "single"], var.group_mode)
    error_message = "group_mode must be \"ab\" or \"single\"."
  }
}

variable "default_range_days" {
  description = "서버 DEFAULT_RANGE_DAYS. from 없이 온 요청의 기본 구간이자 캐시 warmer가 매 부팅마다 미리 데우는 창(README Configuration). 서버 기본값과 같은 2."
  type        = number
  default     = 2
  validation {
    condition     = var.default_range_days >= 1 && floor(var.default_range_days) == var.default_range_days
    error_message = "default_range_days must be a positive integer."
  }
}

variable "range_cap_days" {
  description = "서버 RANGE_CAP_DAYS. 요청 가능한 최대 구간(넘으면 400). 서버는 DEFAULT_RANGE_DAYS보다 작으면 기동 실패 — 같은 조건을 여기서 먼저 거른다. 서버 기본값과 같은 90."
  type        = number
  default     = 90
  validation {
    condition     = var.range_cap_days >= var.default_range_days && floor(var.range_cap_days) == var.range_cap_days
    error_message = "range_cap_days must be an integer >= default_range_days."
  }
}

variable "alert_webhook_url" {
  description = "서버 ALERT_WEBHOOK_URL. Slack 호환 incoming webhook — 텔레메트리 신선도가 두 틱 연속 non-ok면 발송, ALERT_REPEAT_MINUTES마다 반복, 복구 시 1회. null이면 Secret/env를 만들지 않아 알림이 꺼진다. URL에 토큰이 들어 있으므로 secrets.auto.tfvars 같은 비추적 파일로만 넘긴다."
  type        = string
  default     = null
  sensitive   = true
}

variable "alert_repeat_minutes" {
  description = "서버 ALERT_REPEAT_MINUTES. non-ok가 지속될 때 재발송 간격(분). 서버는 0 이하/비숫자면 기동 실패 — 여기서 먼저 거른다. alert_webhook_url이 null이면 주입하지 않는다."
  type        = number
  default     = 60
  validation {
    condition     = var.alert_repeat_minutes >= 1 && floor(var.alert_repeat_minutes) == var.alert_repeat_minutes
    error_message = "alert_repeat_minutes must be a positive integer."
  }
}

# 아래 둘은 null이면 env를 아예 주입하지 않는다 — 서버가 자기 기본 단가표/캐시 TTL을 쓴다.
# 빈 문자열로 주입하면 서버가 부팅 시점에 파싱 실패로 죽으므로 null과 구분해야 한다.
variable "pricing_json" {
  type    = string
  default = null
}

variable "pricing_cache_write_ttl" {
  type    = string
  default = null
  validation {
    # 서버가 받아주는 값은 이 둘뿐이고, 그 밖의 값은 모듈 로드 시점에 부팅을 막는다 —
    # 잘못된 값이 롤아웃까지 가지 않게 여기서 먼저 거른다.
    condition     = var.pricing_cache_write_ttl == null || contains(["1h", "5m"], var.pricing_cache_write_ttl)
    error_message = "pricing_cache_write_ttl must be \"1h\" or \"5m\" when set."
  }
}

# 그룹별 캐시 쓰기 TTL 정책(ADR-008). null이면 서버 내장 정책(bedrock 5m / enterprise 1h, 전역
# 변수가 있으면 그 값). 값은 단일 티어("1h"/"5m") 또는 전환 스케줄 "5m,2026-09-09T00:00:00Z=1h" —
# 전환 시각은 타임존 명시 + UTC 정각이어야 서버가 기동한다(pricing.js parseCacheWriteTtlSchedule).
# 두 validation의 정규식은 서버 파서와 같은 형태만 통과시킨다(정각은 :00:00으로 강제, 순서/중복은
# 서버가 검사). variable validation은 자기 변수만 참조할 수 있어 locals로 빼지 못하고 두 번 적는다.
variable "pricing_cache_write_ttl_bedrock" {
  type    = string
  default = null
  validation {
    condition     = var.pricing_cache_write_ttl_bedrock == null || can(regex("^(1h|5m)(,[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:00:00(Z|[+-][0-9]{2}:[0-9]{2})=(1h|5m))*$", var.pricing_cache_write_ttl_bedrock))
    error_message = "pricing_cache_write_ttl_bedrock must be \"1h\", \"5m\" or a schedule like \"5m,2026-09-09T00:00:00Z=1h\" (hour-aligned, timezone-explicit instants)."
  }
}

variable "pricing_cache_write_ttl_enterprise" {
  type    = string
  default = null
  validation {
    condition     = var.pricing_cache_write_ttl_enterprise == null || can(regex("^(1h|5m)(,[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:00:00(Z|[+-][0-9]{2}:[0-9]{2})=(1h|5m))*$", var.pricing_cache_write_ttl_enterprise))
    error_message = "pricing_cache_write_ttl_enterprise must be \"1h\", \"5m\" or a schedule like \"1h,2026-10-01T00:00:00Z=5m\" (hour-aligned, timezone-explicit instants)."
  }
}

resource "kubernetes_secret" "dashboard_basic_auth" {
  metadata {
    name      = "dashboard-basic-auth"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  data = {
    BASIC_AUTH_USER     = var.dashboard_basic_auth_user
    BASIC_AUTH_PASSWORD = var.dashboard_basic_auth_password
  }
}

# 웹훅 URL은 토큰을 품고 있어 env value가 아니라 Secret으로 — null이면 Secret 자체가 없다.
resource "kubernetes_secret" "dashboard_alert" {
  count = var.alert_webhook_url == null ? 0 : 1
  metadata {
    name      = "dashboard-alert"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  data = { ALERT_WEBHOOK_URL = var.alert_webhook_url }
}

resource "kubernetes_secret" "clickhouse_reader" {
  metadata {
    name      = "clickhouse-reader"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  data = { CH_PASSWORD = var.clickhouse_reader_password }
}

# Ask Claude 챗(dashboard/server/chat.js)이 Bedrock ConverseStream을 호출하려면 자격증명이
# 필요하다 — clickhouse_s3(s3.tf)와 동일한 IRSA 패턴: 이 SA만 assume 가능하도록 trust를
# namespace/이름으로 좁힌다.
resource "kubernetes_service_account" "dashboard" {
  metadata {
    name      = "dashboard"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
    annotations = {
      "eks.amazonaws.com/role-arn" = aws_iam_role.dashboard_bedrock.arn
    }
  }
}

resource "aws_iam_role" "dashboard_bedrock" {
  name = "cc-ab-dashboard-bedrock"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.eks.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.oidc_issuer}:sub" = "system:serviceaccount:${kubernetes_namespace.claude_code.metadata[0].name}:dashboard"
          "${local.oidc_issuer}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })
}

# InvokeModel* 리소스는 foundation-model(리전 무관 ARN)과 inference-profile 둘 다 필요 —
# global.anthropic.* 프로파일이 내부적으로 여러 리전의 foundation-model ARN을 참조하므로
# foundation-model은 리전 와일드카드(*)를 유지한다. inference-profile은 사용 모델 하나로 좁힌다.
# chat_model_id에서 리전 프리픽스(global./us./eu./apac.)를 떼면 foundation-model 이름이 된다.
locals {
  chat_foundation_model = replace(var.chat_model_id, "/^(global|us|eu|apac)\\./", "")
}
resource "aws_iam_role_policy" "dashboard_bedrock" {
  name = "bedrock-invoke"
  role = aws_iam_role.dashboard_bedrock.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      Resource = [
        "arn:aws:bedrock:*::foundation-model/${local.chat_foundation_model}",
        "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/${var.chat_model_id}"
      ]
    }]
  })
}

resource "kubernetes_deployment_v1" "dashboard" {
  # ECR엔 아직 이미지가 없다 — apply 시점에 rollout이 안 끝나는 게 정상이므로 여기서 막지 않는다.
  # 이미지 push 후 `kubectl rollout restart`로 실제로 뜬다.
  wait_for_rollout = false
  metadata {
    name      = "dashboard"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  spec {
    replicas = 2
    selector { match_labels = { app = "dashboard" } }
    # max_unavailable=0: 롤아웃 중에도 ready 파드가 2 미만으로 내려가지 않는다. max_surge=1이라
    # 새 파드가 readiness를 통과한 뒤에 옛 파드가 빠진다 — 이 두 값과 아래 readiness_probe가
    # 같이 있어야 "무중단"이 성립한다(둘 중 하나만 있으면 의미가 없다).
    strategy {
      type = "RollingUpdate"
      rolling_update {
        max_unavailable = "0"
        max_surge       = "1"
      }
    }
    template {
      metadata { labels = { app = "dashboard" } }
      spec {
        toleration {
          key      = "claude-code"
          operator = "Equal"
          value    = "true"
          effect   = "NoSchedule"
        }
        # replicas=2가 한 노드에 몰리면 그 노드가 빠질 때 두 파드가 같이 죽어 PDB도 못 막는다.
        # required가 아니라 preferred인 이유: 이 nodepool은 Karpenter가 관리해 노드가 한 대로
        # 줄어드는 구간이 있고, 그때 스케줄 자체가 막히면 대시보드가 아예 안 뜬다.
        affinity {
          pod_anti_affinity {
            preferred_during_scheduling_ignored_during_execution {
              weight = 100
              pod_affinity_term {
                topology_key = "kubernetes.io/hostname"
                label_selector {
                  match_labels = { app = "dashboard" }
                }
              }
            }
          }
        }
        node_selector                    = local.ch_node_selector
        service_account_name             = kubernetes_service_account.dashboard.metadata[0].name
        termination_grace_period_seconds = 30
        container {
          name  = "dashboard"
          image = "${aws_ecr_repository.dashboard.repository_url}:${var.dashboard_image_tag}"
          port { container_port = 8080 }
          env {
            name  = "CH_URL"
            value = "http://${local.chi_service}:8123"
          }
          env {
            name  = "AWS_REGION"
            value = var.region
          }
          env {
            name  = "CHAT_MODEL_ID"
            value = var.chat_model_id
          }
          env {
            name  = "CH_DB"
            value = "claude_code"
          }
          env {
            name  = "CH_USER"
            value = "otel_reader"
          }
          env {
            name = "CH_PASSWORD"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.clickhouse_reader.metadata[0].name
                key  = "CH_PASSWORD"
              }
            }
          }
          # 새 env는 리스트 끝에 둔다 — k8s 프로바이더는 env 블록을 순서 있는 리스트로 diff해서
          # 중간에 삽입하면 뒤 항목 전체가 "변경"으로 잡히는 노이즈가 생긴다(terraform plan 확인).
          dynamic "env" {
            for_each = var.bedrock_region == "" ? [] : [var.bedrock_region]
            content {
              name  = "BEDROCK_REGION"
              value = env.value
            }
          }
          dynamic "env" {
            for_each = var.pii_mask_enabled ? ["1"] : []
            content {
              name  = "PII_MASK_ENABLED"
              value = env.value
            }
          }
          env {
            name  = "DATA_STALE_MINUTES"
            value = tostring(var.data_stale_minutes)
          }
          dynamic "env" {
            for_each = var.pricing_json == null ? [] : [var.pricing_json]
            content {
              name  = "PRICING_JSON"
              value = env.value
            }
          }
          dynamic "env" {
            for_each = var.pricing_cache_write_ttl == null ? [] : [var.pricing_cache_write_ttl]
            content {
              name  = "PRICING_CACHE_WRITE_TTL"
              value = env.value
            }
          }
          dynamic "env" {
            for_each = var.pricing_cache_write_ttl_bedrock == null ? [] : [var.pricing_cache_write_ttl_bedrock]
            content {
              name  = "PRICING_CACHE_WRITE_TTL_BEDROCK"
              value = env.value
            }
          }
          dynamic "env" {
            for_each = var.pricing_cache_write_ttl_enterprise == null ? [] : [var.pricing_cache_write_ttl_enterprise]
            content {
              name  = "PRICING_CACHE_WRITE_TTL_ENTERPRISE"
              value = env.value
            }
          }
          env {
            name  = "GROUP_MODE"
            value = var.group_mode
          }
          env {
            name  = "DEFAULT_RANGE_DAYS"
            value = tostring(var.default_range_days)
          }
          env {
            name  = "RANGE_CAP_DAYS"
            value = tostring(var.range_cap_days)
          }
          # sensitive 변수(alert_webhook_url)에서 파생한 값은 Terraform 1.9의 dynamic for_each가
          # "Cannot use a … value in for_each"로 거부한다(CI 실측 2026-09-05; 1.15는 통과).
          # Secret 리소스 개수는 sensitive 마크가 없으므로 그것으로 분기한다.
          dynamic "env" {
            for_each = length(kubernetes_secret.dashboard_alert) == 0 ? {} : { ALERT_REPEAT_MINUTES = tostring(var.alert_repeat_minutes) }
            content {
              name  = env.key
              value = env.value
            }
          }
          env_from {
            secret_ref { name = kubernetes_secret.dashboard_basic_auth.metadata[0].name }
          }
          dynamic "env_from" {
            for_each = kubernetes_secret.dashboard_alert
            content {
              secret_ref { name = env_from.value.metadata[0].name }
            }
          }
          liveness_probe {
            http_get {
              path = "/healthz"
              port = 8080
            }
            initial_delay_seconds = 5
          }
          # liveness(/healthz)와 readiness(/readyz)는 다른 걸 본다: /readyz는 SIGTERM 이후
          # 503으로 뒤집히고 ClickHouse ping이 실패해도 503이라, 준비 안 된 파드가 Service
          # endpoints에서 빠진다. liveness에 /readyz를 쓰면 ClickHouse 장애가 파드 재시작
          # 루프로 번지므로 두 엔드포인트를 그대로 분리해서 쓴다.
          readiness_probe {
            http_get {
              path = "/readyz"
              port = 8080
            }
            initial_delay_seconds = 5
            period_seconds        = 10
            failure_threshold     = 3
          }
          # SIGTERM은 파드가 Service endpoints에서 빠지기 *전에* 도착하고, /readyz를 503으로
          # 뒤집는 플래그와 server.close()는 같은 tick에 실행된다 — close()가 리스너를 즉시
          # 닫으므로 SIGTERM 이후의 새 연결은 503을 받는 게 아니라 거부된다(실측 2026-09-02,
          # dashboard/server/CLAUDE.md의 종료 시퀀스). 즉 endpoint 제거가 전파될 시간을 벌어주는
          # 건 이 preStop sleep뿐이고, 앱 쪽 플래그로는 대체할 수 없다.
          lifecycle {
            pre_stop {
              exec {
                command = ["sleep", "5"]
              }
            }
          }
          resources {
            requests = { cpu = "100m", memory = "128Mi" }
            limits   = { cpu = "500m", memory = "256Mi" }
          }
        }
      }
    }
  }
  depends_on = [kubernetes_job_v1.schema_init]
  # 실제로 돌고 있는 이미지는 배포 런북의 `kubectl set image`가 소유한다 —
  # var.dashboard_image_tag는 첫 롤아웃의 시드값일 뿐이다. 이걸 무시하지 않으면 다음
  # terraform apply가 라이브 이미지를 image.auto.tfvars의 (오래된) 태그로 되돌린다.
  lifecycle {
    ignore_changes = [spec[0].template[0].spec[0].container[0].image]
  }
}

# 자발적 축출(노드 드레인, Karpenter 축소)은 롤아웃과 다른 경로라 strategy의 max_unavailable=0이
# 막지 못한다 — 두 파드가 동시에 evict되는 걸 막는 건 이 PDB뿐이다. min_available=1: replicas=2
# 에서 한 번에 한 파드만 비운다.
resource "kubernetes_pod_disruption_budget_v1" "dashboard" {
  metadata {
    name      = "dashboard"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  spec {
    min_available = "1"
    selector {
      match_labels = { app = "dashboard" }
    }
  }
}

# 내부 NLB — CloudFront VPC Origin이 붙는 대상. TLS는 NLB에서 종료(기존 와일드카드 인증서
# 데이터소스 재사용), 백엔드로는 평문 HTTP만 전달.
resource "kubernetes_service" "dashboard_nlb" {
  metadata {
    name      = "dashboard-nlb"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
    annotations = {
      # CloudFront VPC Origin은 NLB에 TLS 리스너를 허용하지 않는다("Use a TCP listener") —
      # 그래서 TLS 종료 없이 순수 TCP passthrough로 둔다. 이 구간은 VPC origin ENI를 통한
      # AWS 백본 내부 트래픽이라 평문이어도 인터넷에 노출되지 않음 (viewer<->CloudFront는 계속 HTTPS).
      "service.beta.kubernetes.io/aws-load-balancer-type"            = "external"
      "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type" = "ip"
      "service.beta.kubernetes.io/aws-load-balancer-scheme"          = "internal"
      "service.beta.kubernetes.io/aws-load-balancer-subnets"         = join(",", data.aws_subnets.private.ids)
      "service.beta.kubernetes.io/aws-load-balancer-security-groups" = aws_security_group.internal_nlb.id
    }
  }
  spec {
    type                = "LoadBalancer"
    load_balancer_class = "service.k8s.aws/nlb"
    selector            = { app = "dashboard" }
    port {
      name        = "https"
      port        = 443
      target_port = 8080
    }
  }
  wait_for_load_balancer = true
}

# ClickHouse ingest NLB — CHI가 만든 pod들을 CHI 자체 라벨로 셀렉트 (operator의 Service는
# 그대로 두고, 외부 노출용 Service를 하나 더 추가하는 방식).
resource "kubernetes_service" "clickhouse_ingest_nlb" {
  metadata {
    name      = "clickhouse-ingest-nlb"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
    annotations = {
      # dashboard-nlb와 동일한 이유로 TLS 리스너 annotation 없음 — TCP passthrough.
      "service.beta.kubernetes.io/aws-load-balancer-type"            = "external"
      "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type" = "ip"
      "service.beta.kubernetes.io/aws-load-balancer-scheme"          = "internal"
      "service.beta.kubernetes.io/aws-load-balancer-subnets"         = join(",", data.aws_subnets.private.ids)
      "service.beta.kubernetes.io/aws-load-balancer-security-groups" = aws_security_group.internal_nlb.id
    }
  }
  spec {
    type                = "LoadBalancer"
    load_balancer_class = "service.k8s.aws/nlb"
    selector            = { "clickhouse.altinity.com/chi" = "cc-ab" }
    port {
      name        = "https"
      port        = 443
      target_port = 8123
    }
  }
  wait_for_load_balancer = true
  depends_on             = [kubectl_manifest.chi]
}

# NLB -> 노드(파드 ENI) 인바운드 — target-type=ip NLB는 헬스체크/트래픽이 NLB의 ENI에서
# 나가는데, EKS 클러스터 SG(파드가 상속)엔 이걸 허용하는 규칙이 원래 없어서 따로 열어준다.
# 실측: NLB 직접 헬스체크가 Target.FailedHealthChecks로 실패해서 발견 — pod_direct curl은
# 되는데 NLB->pod 경로만 막혀 있었음.
resource "aws_security_group_rule" "cluster_from_nlb_dashboard" {
  type                     = "ingress"
  security_group_id        = data.aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  from_port                = 8080
  to_port                  = 8080
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.internal_nlb.id
  description              = "dashboard-nlb health check and traffic"
}

resource "aws_security_group_rule" "cluster_from_nlb_ch_ingest" {
  type                     = "ingress"
  security_group_id        = data.aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  from_port                = 8123
  to_port                  = 8123
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.internal_nlb.id
  description              = "clickhouse-ingest-nlb health check and traffic"
}

# NLB SG — CloudFront origin-facing prefix list에서만 443 인바운드. 최소권한.
resource "aws_security_group" "internal_nlb" {
  name        = "cc-ab-internal-nlb"
  description = "CloudFront VPC Origin to internal NLB (dashboard + clickhouse ingest)"
  vpc_id      = data.aws_vpc.this.id

  ingress {
    description     = "CloudFront origin-facing"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
