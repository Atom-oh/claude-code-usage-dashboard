# ClickHouse — claude-code 네임스페이스에 신규 CHI(2 레플리카) + CHK(Keeper 3노드).
# 기존 observability/fsi-demo-ch(1레플리카, ArgoCD 관리)는 건드리지 않는다.
#
# ponytail: 백업은 별도 clickhouse-backup 툴 대신 ClickHouse 네이티브 BACKUP 커맨드 +
# 이미 구성한 S3 disk(cold_s3, IRSA 자격증명 재사용)로 — 이미지/자격증명 관리가 하나 줄어든다.

resource "kubernetes_namespace" "claude_code" {
  metadata { name = var.k8s_namespace }
}

resource "kubernetes_service_account" "clickhouse" {
  metadata {
    name      = "clickhouse"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
    annotations = {
      "eks.amazonaws.com/role-arn" = aws_iam_role.clickhouse_s3.arn
    }
  }
}

# CHI의 default 유저는 오퍼레이터가 비밀번호를 요구하도록 막아놔서(값을 모름) 스키마 초기화/백업은
# otel_writer로 접속한다 — 어차피 이 계정이 쓰기 권한을 가져야 하는 계정이라 이 쪽이 맞다.
resource "kubernetes_secret" "clickhouse_writer" {
  metadata {
    name      = "clickhouse-writer"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  data = { CH_PASSWORD = var.clickhouse_writer_password }
}

locals {
  ch_toleration    = [{ key = "claude-code", operator = "Equal", value = "true", effect = "NoSchedule" }]
  ch_node_selector = { "node-type" = "claude-code" }
  cold_s3_endpoint = "https://${aws_s3_bucket.clickhouse.bucket}.s3.${var.region}.amazonaws.com/cold/"
  # Altinity operator의 서비스 네이밍 규칙(clickhouse-<CHI 이름>) — CHI를 apply한 뒤 실측 확인 필요
  # (kubectl -n claude-code get svc). 다르면 이 값만 고치면 된다.
  chi_service = "clickhouse-cc-ab.${var.k8s_namespace}.svc.cluster.local"
}

# ── Keeper 3노드 ────────────────────────────────────────────────────────
resource "kubectl_manifest" "chk" {
  yaml_body = yamlencode({
    apiVersion = "clickhouse-keeper.altinity.com/v1"
    kind       = "ClickHouseKeeperInstallation"
    metadata   = { name = "keeper", namespace = kubernetes_namespace.claude_code.metadata[0].name }
    spec = {
      configuration = { clusters = [{ name = "keeper", layout = { replicasCount = 3 } }] }
      templates = {
        podTemplates = [{
          name = "keeper-pod"
          spec = {
            tolerations  = local.ch_toleration
            nodeSelector = local.ch_node_selector
            containers = [{
              name  = "clickhouse-keeper"
              image = "clickhouse/clickhouse-keeper:24.8"
              resources = {
                requests = { cpu = "0.5", memory = "512Mi" }
                limits   = { cpu = "1", memory = "1Gi" }
              }
            }]
          }
        }]
        volumeClaimTemplates = [{
          name = "keeper-data"
          spec = {
            accessModes      = ["ReadWriteOnce"]
            storageClassName = "gp3"
            resources        = { requests = { storage = "10Gi" } }
          }
        }]
      }
      defaults = { templates = { podTemplate = "keeper-pod", dataVolumeClaimTemplate = "keeper-data" } }
    }
  })
  depends_on = [kubectl_manifest.claude_code_nodepool]
}

# ── CHI: 2 레플리카 ReplicatedMergeTree ─────────────────────────────────
resource "kubectl_manifest" "chi" {
  yaml_body = yamlencode({
    apiVersion = "clickhouse.altinity.com/v1"
    kind       = "ClickHouseInstallation"
    metadata   = { name = "cc-ab", namespace = kubernetes_namespace.claude_code.metadata[0].name }
    spec = {
      configuration = {
        clusters = [{ name = "replicated", layout = { shardsCount = 1, replicasCount = 2 } }]
        # CHK 서비스 이름은 <chk 이름>-<cluster 이름>이라 "keeper-keeper" (실측 확인: kubectl get svc).
        zookeeper = { nodes = [{ host = "keeper-keeper.${var.k8s_namespace}.svc.cluster.local", port = 2181 }] }
        users = {
          "otel_writer/password_sha256_hex" = sha256(var.clickhouse_writer_password)
          "otel_writer/networks/ip"         = "10.0.0.0/8"
          "otel_reader/password_sha256_hex" = sha256(var.clickhouse_reader_password)
          "otel_reader/networks/ip"         = "10.0.0.0/8"
          "otel_reader/profile"             = "readonly"
          # 명시 grant를 두면 기본 전체권한이 사라져 테이블 함수(url/s3/remote/file → 각각
          # URL/S3/REMOTE/FILE grant 필요)와 system DB가 서버 측에서 거부된다 — Ask Claude 챗의
          # sanitizeSql SSRF 방어(chat.js)의 defense-in-depth. 대시보드는 claude_code.*만 조회한다.
          # 이 grants/query는 config 기반(users.xml) 유저의 <grants> 요소로 렌더되며, SQL 명령 기반
          # 접근제어(access_management=1)와 무관하게 동작한다 — 별도 access_management 설정 불필요.
          # apply 후 실효성은 docs/workshop-studio-notes.md §4 검증 절차(url() → ACCESS_DENIED)로 확인.
          "otel_reader/grants/query" = "GRANT SELECT ON claude_code.*"
        }
        profiles = { "readonly/readonly" = "1" }
        # 콜드 티어링: hot(EBS gp3, 기본 disk) → cold(S3), TTL로 이동. 실제 TTL은 스키마 쪽
        # (ConfigMap clickhouse-schema-replicated)에서 `TTL ... TO VOLUME 'cold'`로 건다.
        files = {
          "config.d/storage.xml" = <<-XML
            <clickhouse>
              <storage_configuration>
                <disks>
                  <cold_s3>
                    <type>s3</type>
                    <endpoint>${local.cold_s3_endpoint}</endpoint>
                    <use_environment_credentials>1</use_environment_credentials>
                  </cold_s3>
                </disks>
                <policies>
                  <hot_cold>
                    <volumes>
                      <hot><disk>default</disk></hot>
                      <cold><disk>cold_s3</disk></cold>
                    </volumes>
                    <move_factor>0.1</move_factor>
                  </hot_cold>
                </policies>
              </storage_configuration>
            </clickhouse>
          XML
          # BACKUP TO Disk('cold_s3', ...)를 쓰려면 이 allowlist가 필요 — 없으면
          # INVALID_CONFIG_PARAMETER로 거부된다 (실측: 백업 CronJob 수동 실행 중 발견).
          "config.d/backups.xml" = <<-XML
            <clickhouse>
              <backups>
                <allowed_disk>cold_s3</allowed_disk>
              </backups>
            </clickhouse>
          XML
        }
      }
      templates = {
        podTemplates = [{
          name = "chi-pod"
          spec = {
            tolerations        = local.ch_toleration
            nodeSelector       = local.ch_node_selector
            serviceAccountName = kubernetes_service_account.clickhouse.metadata[0].name
            containers = [{
              name  = "clickhouse"
              image = "clickhouse/clickhouse-server:24.8"
              resources = {
                requests = { cpu = "2", memory = "6Gi" }
                limits   = { cpu = "3.5", memory = "13Gi" }
              }
            }]
          }
        }]
        volumeClaimTemplates = [{
          name = "hot-data"
          spec = {
            accessModes      = ["ReadWriteOnce"]
            storageClassName = "gp3"
            resources        = { requests = { storage = "100Gi" } }
          }
        }]
      }
      defaults = { templates = { podTemplate = "chi-pod", dataVolumeClaimTemplate = "hot-data" } }
    }
  })
  depends_on = [kubectl_manifest.chk]
}

# 원본 clickhouse-schema.sql을 ON CLUSTER + ReplicatedMergeTree + TTL TO VOLUME 'cold'로
# 변환한 버전. 컬럼/MATERIALIZED 정의는 원본과 동일 — engine과 클러스터 절만 다르다.
resource "kubernetes_config_map" "schema" {
  metadata {
    name      = "clickhouse-schema-replicated"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  data = {
    "schema.sql" = file("${path.module}/files/clickhouse-schema-replicated.sql")
  }
}

resource "kubernetes_job_v1" "schema_init" {
  metadata {
    name      = "clickhouse-schema-init"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  spec {
    backoff_limit = 6
    template {
      metadata {}
      spec {
        restart_policy = "OnFailure"
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
          command = ["sh", "-c", "clickhouse-client --host ${local.chi_service} --user otel_writer --password \"$CH_PASSWORD\" --multiquery --queries-file /sql/schema.sql"]
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
          }
        }
        volume {
          name = "sql"
          config_map { name = kubernetes_config_map.schema.metadata[0].name }
        }
      }
    }
  }
  wait_for_completion = false
  depends_on          = [kubectl_manifest.chi]
}

# 일별 백업 — ClickHouse 네이티브 BACKUP, cold_s3 disk(IRSA 자격증명) 재사용.
resource "kubernetes_cron_job_v1" "backup" {
  metadata {
    name      = "clickhouse-backup"
    namespace = kubernetes_namespace.claude_code.metadata[0].name
  }
  spec {
    schedule = "0 18 * * *" # 03:00 KST
    job_template {
      metadata {}
      spec {
        template {
          metadata {}
          spec {
            restart_policy = "OnFailure"
            toleration {
              key      = "claude-code"
              operator = "Equal"
              value    = "true"
              effect   = "NoSchedule"
            }
            node_selector = local.ch_node_selector
            container {
              name  = "backup"
              image = "clickhouse/clickhouse-server:24.8"
              command = ["sh", "-c", <<-EOT
                clickhouse-client --host ${local.chi_service} --user otel_writer --password "$CH_PASSWORD" \
                  --query "BACKUP DATABASE claude_code TO Disk('cold_s3', 'backup/$(date +%Y-%m-%d)')"
              EOT
              ]
              env {
                name = "CH_PASSWORD"
                value_from {
                  secret_key_ref {
                    name = kubernetes_secret.clickhouse_writer.metadata[0].name
                    key  = "CH_PASSWORD"
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  depends_on = [kubernetes_job_v1.schema_init]
}
