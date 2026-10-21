# Optional device-authenticated OTLP path through the existing dashboard origin.
variable "device_ingest_enabled" {
  description = "Enable editor/admin device tokens, installer downloads and the private OTLP receiver. Requires OIDC."
  type        = bool
  default     = false
  validation {
    condition     = !var.device_ingest_enabled || var.auth_mode == "oidc"
    error_message = "Device ingestion requires organization OIDC authentication."
  }
}

variable "device_ingest_secret_name" {
  description = "Existing namespace Secret containing token: a 32+ character base64url internal receiver credential. Never include it in client packages."
  type        = string
  default     = null
  validation {
    condition = !var.device_ingest_enabled ? true : (
      var.device_ingest_secret_name == null ? false : can(regex("^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$", var.device_ingest_secret_name))
    )
    error_message = "Device ingestion requires an existing Kubernetes Secret name."
  }
}

variable "device_receiver_image" {
  description = "Reviewed Collector release with a verified immutable multi-platform digest. Refresh only after existing-schema export validation."
  type        = string
  default     = "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib:0.163.1@sha256:1175b03003053962012f5a231f5567f66a3e8fdb960c7835c0e48f7aa1555806"
  validation {
    condition     = can(regex("^[^\\s]+@sha256:[0-9a-f]{64}$", var.device_receiver_image))
    error_message = "device_receiver_image must be pinned by SHA-256 digest."
  }
}

locals {
  device_receiver_labels = { app = "device-otel-receiver" }
  device_receiver_source = yamldecode(file("${path.module}/../dashboard/collector/generated/central.yaml"))
  device_receiver_config = merge(local.device_receiver_source, {
    service = merge(local.device_receiver_source.service, {
      pipelines = { for name, pipeline in local.device_receiver_source.service.pipelines : name => pipeline
        if endswith(name, "/codex") ? var.codex_enabled : var.claude_enabled
      }
    })
  })
  device_ingest_environment = var.device_ingest_enabled ? {
    INGEST_ENABLED             = "1"
    INGEST_TOKEN_TABLE         = aws_dynamodb_table.device_tokens[0].name
    INGEST_UPSTREAM_URL        = "http://device-otel-receiver.${var.k8s_namespace}.svc.cluster.local:4318"
    INGEST_UPSTREAM_TOKEN_FILE = "/var/run/ccdash-ingest/token"
  } : {}
}

resource "aws_dynamodb_table" "device_tokens" {
  count                       = var.device_ingest_enabled ? 1 : 0
  name                        = "${var.k8s_namespace}-ccdash-device-tokens"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "owner"
  range_key                   = "id"
  deletion_protection_enabled = true
  attribute {
    name = "owner"
    type = "S"
  }
  attribute {
    name = "id"
    type = "S"
  }
  ttl {
    attribute_name = "purgeAt"
    enabled        = true
  }
  # AWS-managed DynamoDB KMS key; no cleartext owner identifiers are stored.
  server_side_encryption { enabled = true }
}

resource "aws_iam_role_policy" "device_tokens" {
  count = var.device_ingest_enabled ? 1 : 0
  name  = "ccdash-device-tokens"
  role  = aws_iam_role.dashboard_bedrock.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
      Resource = aws_dynamodb_table.device_tokens[0].arn
    }]
  })
}

resource "kubernetes_config_map" "device_receiver" {
  count = var.device_ingest_enabled ? 1 : 0
  metadata {
    name      = "device-otel-receiver"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  data = { "config.yaml" = yamlencode(local.device_receiver_config) }
}

resource "kubernetes_service" "device_receiver" {
  count = var.device_ingest_enabled ? 1 : 0
  metadata {
    name      = "device-otel-receiver"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  spec {
    type     = "ClusterIP"
    selector = local.device_receiver_labels
    port {
      name        = "otlp-http"
      port        = 4318
      target_port = 4318
    }
  }
}

resource "kubernetes_deployment_v1" "device_receiver" {
  count            = var.device_ingest_enabled ? 1 : 0
  wait_for_rollout = false
  metadata {
    name      = "device-otel-receiver"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  spec {
    replicas = 2
    selector { match_labels = local.device_receiver_labels }
    strategy {
      type = "RollingUpdate"
      rolling_update {
        max_unavailable = "0"
        max_surge       = "1"
      }
    }
    template {
      metadata {
        labels      = local.device_receiver_labels
        annotations = { "checksum/config" = sha256(kubernetes_config_map.device_receiver[0].data["config.yaml"]) }
      }
      spec {
        automount_service_account_token  = false
        node_selector                    = local.ch_node_selector
        termination_grace_period_seconds = 30
        toleration {
          key      = "claude-code"
          operator = "Equal"
          value    = "true"
          effect   = "NoSchedule"
        }
        security_context {
          run_as_non_root = true
          run_as_user     = 10001
          run_as_group    = 10001
          fs_group        = 10001
          seccomp_profile { type = "RuntimeDefault" }
        }
        affinity {
          pod_anti_affinity {
            preferred_during_scheduling_ignored_during_execution {
              weight = 100
              pod_affinity_term {
                topology_key = "kubernetes.io/hostname"
                label_selector { match_labels = local.device_receiver_labels }
              }
            }
          }
        }
        container {
          name  = "collector"
          image = var.device_receiver_image
          args  = ["--config=/etc/otelcol/config.yaml"]
          port { container_port = 4318 }
          port { container_port = 13133 }
          dynamic "env" {
            for_each = { CH_HOST = local.chi_service, CH_PORT = "9000", CH_DB = "claude_code", CH_USER = "otel_ingest", GOMEMLIMIT = "300MiB" }
            content {
              name  = env.key
              value = env.value
            }
          }
          security_context {
            allow_privilege_escalation = false
            read_only_root_filesystem  = true
            capabilities { drop = ["ALL"] }
          }
          volume_mount {
            name       = "config"
            mount_path = "/etc/otelcol"
            read_only  = true
          }
          volume_mount {
            name       = "receiver-auth"
            mount_path = "/var/run/ccdash-ingest"
            read_only  = true
          }
          volume_mount {
            name       = "database-auth"
            mount_path = "/var/run/ccdash-clickhouse"
            read_only  = true
          }
          readiness_probe {
            http_get {
              path = "/"
              port = 13133
            }
            period_seconds = 5
          }
          liveness_probe {
            http_get {
              path = "/"
              port = 13133
            }
            initial_delay_seconds = 10
            period_seconds        = 15
          }
          resources {
            requests = { cpu = "100m", memory = "192Mi" }
            limits   = { cpu = "500m", memory = "384Mi" }
          }
        }
        volume {
          name = "config"
          config_map { name = kubernetes_config_map.device_receiver[0].metadata[0].name }
        }
        volume {
          name = "receiver-auth"
          secret {
            secret_name  = var.device_ingest_secret_name
            default_mode = "0440"
          }
        }
        volume {
          name = "database-auth"
          secret {
            secret_name  = kubernetes_secret.clickhouse_ingest.metadata[0].name
            default_mode = "0440"
            items {
              key  = "CH_PASSWORD"
              path = "CH_PASSWORD"
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_network_policy_v1" "device_receiver" {
  count = var.device_ingest_enabled ? 1 : 0
  metadata {
    name      = "device-otel-receiver"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  spec {
    pod_selector { match_labels = local.device_receiver_labels }
    policy_types = ["Ingress"]
    ingress {
      from {
        pod_selector { match_labels = { app = "dashboard" } }
      }
      ports {
        port     = "4318"
        protocol = "TCP"
      }
    }
  }
}

resource "kubernetes_pod_disruption_budget_v1" "device_receiver" {
  count = var.device_ingest_enabled ? 1 : 0
  metadata {
    name      = "device-otel-receiver"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  spec {
    min_available = "1"
    selector { match_labels = local.device_receiver_labels }
  }
}
