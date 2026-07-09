variable "dashboard_image_tag" {
  description = "ECR에 push된 이미지 태그. 첫 apply 시점엔 아직 이미지가 없을 수 있음 — push 후 재배포."
  default     = "latest"
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
    template {
      metadata { labels = { app = "dashboard" } }
      spec {
        toleration {
          key      = "claude-code"
          operator = "Equal"
          value    = "true"
          effect   = "NoSchedule"
        }
        node_selector        = local.ch_node_selector
        service_account_name = kubernetes_service_account.dashboard.metadata[0].name
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
          env_from {
            secret_ref { name = kubernetes_secret.dashboard_basic_auth.metadata[0].name }
          }
          liveness_probe {
            http_get {
              path = "/healthz"
              port = 8080
            }
            initial_delay_seconds = 5
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
