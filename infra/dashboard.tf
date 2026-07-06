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

resource "kubernetes_deployment_v1" "dashboard" {
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
        node_selector = local.ch_node_selector
        container {
          name  = "dashboard"
          image = "${aws_ecr_repository.dashboard.repository_url}:${var.dashboard_image_tag}"
          port { container_port = 8080 }
          env {
            name  = "CH_URL"
            value = "http://${local.chi_service}:8123"
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
      "service.beta.kubernetes.io/aws-load-balancer-type"            = "external"
      "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type" = "ip"
      "service.beta.kubernetes.io/aws-load-balancer-scheme"          = "internal"
      "service.beta.kubernetes.io/aws-load-balancer-subnets"         = join(",", data.aws_subnets.private.ids)
      "service.beta.kubernetes.io/aws-load-balancer-ssl-cert"        = data.aws_acm_certificate.wildcard_regional.arn
      "service.beta.kubernetes.io/aws-load-balancer-ssl-ports"       = "443"
      "service.beta.kubernetes.io/aws-load-balancer-security-groups" = aws_security_group.internal_nlb.id
    }
  }
  spec {
    type     = "LoadBalancer"
    selector = { app = "dashboard" }
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
      "service.beta.kubernetes.io/aws-load-balancer-type"            = "external"
      "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type" = "ip"
      "service.beta.kubernetes.io/aws-load-balancer-scheme"          = "internal"
      "service.beta.kubernetes.io/aws-load-balancer-subnets"         = join(",", data.aws_subnets.private.ids)
      "service.beta.kubernetes.io/aws-load-balancer-ssl-cert"        = data.aws_acm_certificate.wildcard_regional.arn
      "service.beta.kubernetes.io/aws-load-balancer-ssl-ports"       = "443"
      "service.beta.kubernetes.io/aws-load-balancer-security-groups" = aws_security_group.internal_nlb.id
    }
  }
  spec {
    type     = "LoadBalancer"
    selector = { "clickhouse.altinity.com/chi" = "cc-ab" }
    port {
      name        = "https"
      port        = 443
      target_port = 8123
    }
  }
  wait_for_load_balancer = true
  depends_on             = [kubectl_manifest.chi]
}

# NLB SG — CloudFront origin-facing prefix list에서만 443 인바운드. 최소권한.
resource "aws_security_group" "internal_nlb" {
  name        = "cc-ab-internal-nlb"
  description = "CloudFront VPC Origin -> internal NLB (dashboard + clickhouse ingest)"
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
