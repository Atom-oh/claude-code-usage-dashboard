# ClickHouse — claude-code 네임스페이스에 신규 CHI(3 레플리카) + CHK(Keeper 3노드).
# 기존 observability/fsi-demo-ch(1레플리카, ArgoCD 관리)는 건드리지 않는다.
#
# ponytail: 백업은 별도 clickhouse-backup 툴 대신 ClickHouse 네이티브 BACKUP 커맨드로 — 이미지
# 관리가 하나 줄어든다. cold_s3 disk와 동일한 IRSA(use_environment_credentials)를 그대로
# 재사용하지만, 대상은 그 disk가 아니라 BACKUP TO S3(...)로 직접 쓴다 — 아래 backup_s3_prefix
# 주석 참조(Disk('cold_s3', ...)는 S3에 논리 경로를 안 만들어 복원이 불가능함을 실측 확인).

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
  # 백업은 cold_s3 디스크를 재사용하지 않고 BACKUP TO S3(...)로 직접 쓴다 — 실측 확인
  # (2026-07-27): type=s3 디스크는 논리 경로를 파드 로컬 metadata(/var/lib/clickhouse/disks/
  # cold_s3/backup/<date>/)에만 두고 S3에는 랜덤 blob 키(cold/aaa/bzscpv...)로 저장한다.
  # 따라서 Disk('cold_s3','backup/X') 백업은 S3에 backup/ 경로를 아예 만들지 않고(실측:
  # cold/backup/ 객체 0개), PVC 없이는 blob만 복사해도 복원이 불가능하다. S3(...) 방식은
  # .backup 매니페스트 + data/<db>/<table>/... 논리 경로를 그대로 써서 자기완결적이다.
  backup_s3_prefix = "https://${aws_s3_bucket.clickhouse.bucket}.s3.${var.region}.amazonaws.com/backup"
  # Altinity operator의 서비스 네이밍 규칙(clickhouse-<CHI 이름>) — CHI를 apply한 뒤 실측 확인 필요
  # (kubectl -n claude-code get svc). 다르면 이 값만 고치면 된다.
  chi_service = "clickhouse-cc-ab.${var.k8s_namespace}.svc.cluster.local"
  # chi_service는 3개 replica 앞의 로드밸런싱 Service라 호출마다 다른 pod에 붙을 수 있다 —
  # 백업 CronJob은 SYSTEM SYNC REPLICA와 BACKUP을 반드시 같은 replica에서 실행해야 하므로
  # (아니면 sync 안 된 replica에서 BACKUP이 뜰 수 있다), operator가 replica별로 만들어주는
  # 전용 headless Service(chi-<chi>-<cluster>-<shard>-<replica>, 실측 확인: endpoint 1개뿐)로
  # 고정한다. replica 0은 replicasCount=3(위)이 유지되는 한 항상 존재.
  chi_replica0_service = "chi-cc-ab-replicated-0-0.${var.k8s_namespace}.svc.cluster.local"
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

# ── CHI: 3 레플리카 ReplicatedMergeTree ─────────────────────────────────
resource "kubectl_manifest" "chi" {
  yaml_body = yamlencode({
    apiVersion = "clickhouse.altinity.com/v1"
    kind       = "ClickHouseInstallation"
    metadata   = { name = "cc-ab", namespace = kubernetes_namespace.claude_code.metadata[0].name }
    spec = {
      configuration = {
        # replicasCount=2→3: 실측(2026-07-10) 확인 — 기존 두 레플리카가 뜬 노드(m8g.xlarge ×2)가
        # 이미 CPU limit 합계 153~178%로 오버커밋 상태라, 페이지 하나가 useApi로 7~9개 API를
        # 동시에 쏘면 cgroup CPU throttling이 실제로 발생한다(9개 동시 쿼리 발사 시 컨테이너의
        # /sys/fs/cgroup/cpu.stat nr_throttled가 10회 증가 — 커널이 강제로 CPU를 끊은 횟수).
        # Karpenter가 이 nodepool(claude-code)을 관리하며 limits.cpu=16(현재 8 사용)이라
        # 여유가 있어, 세 번째 레플리카는 새 m8g.xlarge 노드에 자동 프로비저닝될 것으로 예상.
        clusters = [{ name = "replicated", layout = { shardsCount = 1, replicasCount = 3 } }]
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
        # LIMIT 201 래핑(clickhouse.js)과 30초 AbortController(chat.js)는 행수/응답시간만
        # 제한한다 — 무거운 self-join이나 repeat('x', N) 같은 거대 셀은 여전히 ClickHouse
        # 메모리·CPU를 소모해 DoS/비용 증폭이 가능하다(실측: 리뷰에서 확인). run_sql이 이
        # 프로필(otel_reader)만 쓰므로 여기 상한을 둬도 대시보드 자체 쿼리(default 유저)는
        # 영향받지 않는다. max_execution_time은 clickhouse.js의 30초 abort보다 살짝 넉넉하게
        # 잡아 abort가 항상 먼저 걸리게 하고, 이건 그 abort가 놓친 경우의 backstop이다.
        profiles = {
          "readonly/readonly"           = "1"
          "readonly/max_execution_time" = "60"
          "readonly/max_memory_usage"   = "4000000000"
          "readonly/max_result_bytes"   = "104857600"
          "readonly/max_rows_to_read"   = "2000000000"
        }
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
          # 일별 CronJob과 archive-clickhouse.sh는 이제 BACKUP TO S3(...)를 쓰므로(위
          # backup_s3_prefix 주석 참조) 이 allowlist에 더 의존하지 않는다 — Disk 방식은 S3
          # 상에 논리 경로가 생기지 않는다는 게 실측으로 확인된 문제라 자동화에서 제외됐다.
          # 다만 임시 수동 점검용 `BACKUP TO Disk('cold_s3', ...)`를 계속 쓸 수 있게 남겨둔다.
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

# 일별 백업 — ClickHouse 네이티브 BACKUP을 S3로 직접(자기완결적 아카이브, locals 주석 참조).
# 자격증명은 cold_s3와 동일하게 파드의 IRSA(use_environment_credentials)를 쓴다.
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
                set -eu
                # replica0 전용 headless Service로 고정 — 실측 확인(2026-07-27): 로드밸런싱
                # Service(clickhouse-cc-ab)는 클라이언트 연결마다 다른 pod에 붙을 수 있어, SYNC
                # REPLICA와 BACKUP이 서로 다른 replica에서 실행되면 sync 안 된 replica 기준의
                # BACKUP이 조용히 생길 수 있다(archive-clickhouse.sh는 POD=... | head -1로 하나의
                # pod에 kubectl exec를 고정해서 이 문제가 없음 — 여기도 동일한 "항상 같은 대상"
                # 보장이 필요해 전용 Service로 고정). replica0은 replicasCount=3이 유지되는 한
                # 항상 존재.
                # 비밀번호는 --password argv가 아니라 CLICKHOUSE_PASSWORD env로 넘긴다 —
                # clickhouse-client가 이 env를 자동 인식하므로 --password 플래그 자체가 필요
                # 없다(archive-clickhouse.sh가 stdin+env로 argv 노출을 피하는 것과 같은 이유 —
                # 이 컨테이너는 ps 네임스페이스가 파드 안에서만 보이므로 실위험은 낮지만, 같은
                # PR에서 이 커맨드를 다시 쓰는 김에 통일한다).
                ch() { clickhouse-client --host ${local.chi_replica0_service} --user otel_writer --query "$1"; }
                # ponytail: 날짜(초 단위 없이)만 쓰면 같은 날 재시도(OnFailure로 컨테이너 재시작)
                # 시 BACKUP_ALREADY_EXISTS로 계속 실패한다(실측 확인) — 시각까지 넣어 재시도마다
                # 다른 목적지가 되게 한다. 정확한 경로는 archive-clickhouse.sh가 backup/ 프리픽스
                # 전체를 이관하므로 몰라도 되고, 수동 확인은 aws s3 ls로.
                #
                # archive-clickhouse.sh와 동일 패턴: 파이프로 바로 넘기지 않고 변수로 먼저
                # 받아 set -e가 SELECT 실패를 파이프라인 뒤에서 놓치지 않게 한다(pipefail 불필요).
                REPLICATED_TABLES=$(ch "SELECT table FROM system.replicas WHERE database = 'claude_code'")
                echo "$REPLICATED_TABLES" | while read -r tbl; do
                  [ -n "$tbl" ] || continue
                  case "$tbl" in
                    *[!A-Za-z0-9_]*) echo "unexpected table name char: '$tbl'" >&2; exit 1 ;;
                  esac
                  ch "SYSTEM SYNC REPLICA claude_code.\`$tbl\`"
                done
                ch "BACKUP DATABASE claude_code TO S3('${local.backup_s3_prefix}/$(date -u +%Y-%m-%d_%H%M%S)')"
              EOT
              ]
              env {
                name = "CLICKHOUSE_PASSWORD"
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
