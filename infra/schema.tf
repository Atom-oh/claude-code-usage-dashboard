# Fresh installation and explicit upgrades have separate lifecycles.
# Preserve these resource addresses when moving them out of clickhouse.tf.
locals {
  schema_lifecycle_files = {
    "clickhouse-schema-replicated.sql" = file("${path.module}/files/clickhouse-schema-replicated.sql")
    "clickhouse-schema-contract.sql"   = file("${path.module}/files/clickhouse-schema-contract.sql")
    "clickhouse-schema-init.sh"        = file("${path.module}/files/clickhouse-schema-init.sh")
  }
  schema_lifecycle_hash = sha256(jsonencode(local.schema_lifecycle_files))
}

# Freeze the exact SQL, contract and runner for a Job; never change its mounted input.
resource "kubernetes_config_map" "schema" {
  metadata {
    name      = "clickhouse-schema-${substr(local.schema_lifecycle_hash, 0, 12)}"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  immutable = true
  data      = local.schema_lifecycle_files
}

resource "kubernetes_job_v1" "schema_init" {
  metadata {
    name      = "clickhouse-schema-init-${substr(local.schema_lifecycle_hash, 0, 12)}"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  spec {
    # Connection/replication waits are bounded inside the runner. Partial bootstrap
    # must be inspected; restarting it is not an implicit migration or backfill.
    backoff_limit           = 0
    active_deadline_seconds = 1500
    template {
      metadata {}
      spec {
        restart_policy = "Never"
        toleration {
          key      = "claude-code"
          operator = "Equal"
          value    = "true"
          effect   = "NoSchedule"
        }
        node_selector = local.ch_node_selector
        container {
          name    = "schema-init"
          image   = "clickhouse/clickhouse-server:24.8"
          command = ["sh", "/sql/clickhouse-schema-init.sh"]
          env {
            name  = "CH_HOST"
            value = local.chi_service
          }
          env {
            name  = "CH_EXPECTED_REPLICAS"
            value = "3"
          }
          env {
            name = "CH_PASSWORD"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.clickhouse_writer.metadata[0].name
                key  = "CH_PASSWORD"
              }
            }
          }
          volume_mount {
            name       = "sql"
            mount_path = "/sql"
            read_only  = true
          }
        }
        volume {
          name = "sql"
          config_map { name = kubernetes_config_map.schema.metadata[0].name }
        }
      }
    }
  }
  wait_for_completion = true
  timeouts {
    create = "30m"
  }
  depends_on = [kubectl_manifest.chi]
}
