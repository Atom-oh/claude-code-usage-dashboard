#!/bin/bash
set -euxo pipefail

# Client activation is independent of Claude's experiment group. These settings
# must match the dashboard deployment; Terraform does not manage this user-data.
export CLAUDE_ENABLED="${CLAUDE_ENABLED:-true}"
export CODEX_ENABLED="${CODEX_ENABLED:-false}"
export CODEX_BEDROCK_ENDPOINT="${CODEX_BEDROCK_ENDPOINT:-mantle}"
export CODEX_BEDROCK_REGION="${CODEX_BEDROCK_REGION-us-west-2}"
export CODEX_VERSION="${CODEX_VERSION-0.154.0}"
for client_flag in CLAUDE_ENABLED CODEX_ENABLED; do
  flag_value="${!client_flag}"
  case "${flag_value,,}" in
    true|1) printf -v "$client_flag" '%s' true ;;
    false|0) printf -v "$client_flag" '%s' false ;;
    *) echo "ERROR: $client_flag must be true or false" >&2; exit 1 ;;
  esac
done
case "${CLAUDE_ENABLED}:${CODEX_ENABLED}" in
  true:true|true:false|false:true) ;;
  *) echo "ERROR: client flags must be true/false with at least one enabled" >&2; exit 1 ;;
esac
case "$CODEX_BEDROCK_ENDPOINT" in
  mantle) export CODEX_MODEL="${CODEX_MODEL-openai.gpt-6-astra}" ;;
  runtime) export CODEX_MODEL="${CODEX_MODEL-us.openai.gpt-6-astra}" ;;
  *) echo "ERROR: CODEX_BEDROCK_ENDPOINT must be mantle or runtime" >&2; exit 1 ;;
esac
# Stage scripts/codex-launch.py and collector-config.yaml from the same release.
BOOTSTRAP_ASSET_DIR="${BOOTSTRAP_ASSET_DIR:-/opt/ccdash-bootstrap}"
for bootstrap_asset in scripts/codex-launch.py collector-config.yaml; do
  if [ ! -r "$BOOTSTRAP_ASSET_DIR/$bootstrap_asset" ]; then
    echo "ERROR: stage $bootstrap_asset under BOOTSTRAP_ASSET_DIR first" >&2
    exit 1
  fi
done

# =============================================================================
# Claude Code A/B Telemetry — EC2 user-data
# 두 그룹 공통 스크립트. 그룹 구분은 EXPERIMENT_GROUP 값 하나로만.
#   - Group A: EXPERIMENT_GROUP=bedrock      (Claude Code on Bedrock)
#   - Group B: EXPERIMENT_GROUP=enterprise   (Claude Code Enterprise / Anthropic API)
#
# 범위 밖: Claude Code metric에는 프로세스 메모리·CPU 같은 호스트 리소스 지표가 없다
# (문서 확인, STEP 5). 필요하면 이 Collector에 hostmetrics receiver를 별도로 붙이고
# host.name으로 조인해야 하는데, 지금 A/B 비교 범위 밖이라 추가하지 않는다.
# =============================================================================

# ---- 0. 인스턴스별 설정 (Launch Template 마다 이 값만 다르게) ---------------
EXPERIMENT_GROUP="${EXPERIMENT_GROUP:-bedrock}"      # bedrock | enterprise
AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"

# Admin ClickHouse (Collector가 여기로 export). 실제 값으로 교체.
CH_HOST="admin-clickhouse.internal"
CH_PORT="9440"                                       # native TLS
CH_DB="claude_code"
# 컬렉터는 INSERT 범위 계정으로 붙는다 — otel_writer는 DDL/DROP·테이블 함수·system DB까지
# 가능한 계정이라 워크숍 참가자 인스턴스에 둘 자격증명이 아니다. 이 파라미터는 terraform이
# 만들지 않으므로, 새 인스턴스를 띄우기 전에 운영자가 먼저 만들어야 한다.
CH_USER="otel_ingest"
# 비밀번호는 하드코딩 금지 → SSM Parameter Store(SecureString)에서 로드
CH_PASSWORD_SSM_PARAM="/claude-code/ab/clickhouse-ingest-password"

OTELCOL_VERSION="0.119.0"

# 4-2: 두 그룹이 서로 다른 Claude Code 버전을 쓰면 A/B가 깨진다 — v2.1.214 이전에는
# 게이트웨이/프록시가 usage를 여러 프레임으로 스트리밍하면 cost.usage/token.usage가
# 프레임당 한 요청씩 이중계상되는 버그가 있었다(실측으로 이 배포에서도 재현 가능성 있음 —
# 라이브 플릿이 실제로 2.1.202~2.1.226 20개 버전에 걸쳐 있었다, 2026-08-11 census). 두
# 그룹 모두 이 버전으로 핀 고정. AMI가 Claude Code를 프리베이크하는 배포에서는 이 변수를
# AMI 빌드 파이프라인 쪽으로 옮기고, 아래 버전 검증만 남겨도 된다.
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.226}"

# ---- 1. 기본 패키지 ---------------------------------------------------------
if command -v dnf >/dev/null 2>&1; then PKG=dnf; else PKG=yum; fi
$PKG install -y tar gzip curl unzip python3

BOOTSTRAP_TMP="$(mktemp -d "${TMPDIR:-/var/tmp}/ccdash-bootstrap.XXXXXX")"
COLLECTOR_MUTATED=0
COLLECTOR_SERVICE_CHANGED=0
COLLECTOR_WAS_ACTIVE=0
COLLECTOR_FILES=(
  /usr/local/bin/ccdash-codex /usr/local/bin/otelcol-contrib /opt/otelcol/otelcol-contrib
  /etc/ccdash/clients.env /etc/otelcol/env /etc/otelcol/config.yaml
  /etc/systemd/system/otelcol.service
  /etc/systemd/system/multi-user.target.wants/otelcol.service
)
cleanup_bootstrap() {
  local status=$? restore_failed=0 path saved
  trap - EXIT
  { set +x; } 2>/dev/null
  set +e
  if [ "$status" -ne 0 ] && [ "$COLLECTOR_MUTATED" = 1 ]; then
    if [ "$COLLECTOR_SERVICE_CHANGED" = 1 ]; then
      systemctl stop otelcol.service || restore_failed=1
    fi
    for path in "${COLLECTOR_FILES[@]}"; do
      saved="$BOOTSTRAP_TMP/snapshot$path"
      if [ -e "$saved" ] || [ -L "$saved" ]; then
        mkdir -p "$(dirname "$path")"
        cp -a "$saved" "$path.restore" && mv -f "$path.restore" "$path" || restore_failed=1
      else
        rm -f "$path" || restore_failed=1
      fi
    done
    if [ "$COLLECTOR_SERVICE_CHANGED" = 1 ]; then
      systemctl daemon-reload || restore_failed=1
      if [ "$COLLECTOR_WAS_ACTIVE" = 1 ]; then
        systemctl start otelcol.service || restore_failed=1
      fi
    fi
    if [ "$restore_failed" = 1 ]; then
      echo "ERROR: Collector rollback needs operator recovery; private snapshot retained at $BOOTSTRAP_TMP" >&2
    else
      echo "Collector files and previous running state restored" >&2
    fi
  fi
  if [ "$restore_failed" = 0 ]; then rm -rf "$BOOTSTRAP_TMP"; fi
  exit "$status"
}
trap cleanup_bootstrap EXIT
for collector_path in "${COLLECTOR_FILES[@]}"; do
  if [ -e "$collector_path" ] || [ -L "$collector_path" ]; then
    mkdir -p "$BOOTSTRAP_TMP/snapshot$(dirname "$collector_path")"
    cp -a "$collector_path" "$BOOTSTRAP_TMP/snapshot$collector_path"
  fi
done
if systemctl is-active --quiet otelcol.service; then COLLECTOR_WAS_ACTIVE=1; fi
COLLECTOR_MUTATED=1
install -m 0755 "$BOOTSTRAP_ASSET_DIR/scripts/codex-launch.py" /usr/local/bin/ccdash-codex
# Validate model/region and flags before contacting AWS or installing clients.
CCDASH_CLIENT_ENV=/dev/null /usr/local/bin/ccdash-codex --check >/dev/null

# AWS CLI v2 (SSM 파라미터 로드에 사용) — Amazon Linux는 보통 기본 포함
if ! command -v aws >/dev/null 2>&1; then
  curl -sL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "$BOOTSTRAP_TMP/awscliv2.zip"
  unzip -q "$BOOTSTRAP_TMP/awscliv2.zip" -d "$BOOTSTRAP_TMP" && "$BOOTSTRAP_TMP/aws/install"
fi

# ---- 1b. Claude Code CLI 설치 (버전 핀, 4-2) -------------------------------
# 이 AMI가 Claude Code를 프리베이크한다면 이 블록은 no-op(이미 설치돼 있으면 건너뜀) —
# 버전이 CLAUDE_CODE_VERSION과 다르면 경고만 내고 부팅을 막지는 않는다(set -e로 인스턴스가
# 죽으면 워크숍 전체가 막히므로).
if ! command -v npm >/dev/null 2>&1; then
  $PKG install -y nodejs npm
fi
FINAL_CC_VERSION="disabled"
if [ "$CLAUDE_ENABLED" = "true" ]; then
INSTALLED_CC_VERSION="$(command -v claude >/dev/null 2>&1 && claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo '')"
if [ "$INSTALLED_CC_VERSION" != "$CLAUDE_CODE_VERSION" ]; then
  npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" || \
    echo "WARN: claude-code ${CLAUDE_CODE_VERSION} 설치 실패 — 기존 버전(${INSTALLED_CC_VERSION:-미설치})으로 계속 진행. A/B 버전 혼재 위험, 패널 19로 확인할 것."
fi
FINAL_CC_VERSION="$(command -v claude >/dev/null 2>&1 && claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo 'unknown')"
if [ "$FINAL_CC_VERSION" != "$CLAUDE_CODE_VERSION" ]; then
  echo "WARN: 이 인스턴스의 Claude Code 버전(${FINAL_CC_VERSION})이 기대값(${CLAUDE_CODE_VERSION})과 다름 — A/B 이중계상/MCP 의미 변경 경계를 넘을 수 있음"
fi

fi

# Codex is independently pinned; installation failure must not look successful.
if [ "$CODEX_ENABLED" = "true" ]; then
  INSTALLED_CODEX_VERSION="$(command -v codex >/dev/null 2>&1 && codex --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [ "$INSTALLED_CODEX_VERSION" != "$CODEX_VERSION" ]; then
    npm install -g "@openai/codex@${CODEX_VERSION}"
  fi
  FINAL_CODEX_VERSION="$(codex --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [ "$FINAL_CODEX_VERSION" != "$CODEX_VERSION" ]; then
    echo "ERROR: Codex version does not match CODEX_VERSION" >&2
    exit 1
  fi
fi

# ---- 1c. Bedrock identity 확보 (4-1) ----------------------------------------
# Bedrock으로 붙으면 세션에 Claude 계정이 없어 user.email/user.account_uuid/
# user.account_id/organization.id가 전부 안 채워진다(user.id/session.id만 남음) — 즉
# 유저별 패널(그라파나 패널 10)이 Bedrock 그룹에서만 빈다. enduser.id를 OTEL_RESOURCE_ATTRIBUTES에
# 주입해 대시보드 쿼리가 coalesce(UserEmail, EndUserId)로 폴백할 수 있게 한다. 값은 인스턴스
# IMDSv2 태그(권장 — Launch Template의 TagSpecifications에 Email 키로 배포)에서 읽고, 실패하면
# SSM 파라미터로 폴백한다. 값에 공백/쉼표/등호가 있으면 OTEL_RESOURCE_ATTRIBUTES 포맷(쉼표
# 구분 key=value, 공백 금지)이 깨지므로 검증 후 비우고 경고만 남긴다(부팅을 막지 않음).
IMDS_TOKEN="$(curl -sS -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)"
END_USER_ID=""
if [ -n "$IMDS_TOKEN" ]; then
  END_USER_ID="$(curl -sS -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
    "http://169.254.169.254/latest/meta-data/tags/instance/Email" 2>/dev/null || true)"
fi
if [ -z "$END_USER_ID" ] && [ -n "${END_USER_ID_SSM_PARAM:-}" ]; then
  END_USER_ID="$(aws ssm get-parameter --name "$END_USER_ID_SSM_PARAM" \
    --region "$AWS_DEFAULT_REGION" --query 'Parameter.Value' --output text 2>/dev/null || true)"
fi
case "$END_USER_ID" in
  *[,\ =]*)
    echo "WARN: enduser.id 값('$END_USER_ID')에 공백/쉼표/등호가 포함돼 OTEL_RESOURCE_ATTRIBUTES 포맷을 깨뜨림 — 주입 생략"
    END_USER_ID=""
    ;;
esac
if [ "$EXPERIMENT_GROUP" = "bedrock" ] && [ -z "$END_USER_ID" ]; then
  echo "WARN: bedrock 그룹인데 enduser.id를 못 구함 — 이 인스턴스는 유저별 패널에서 빈 값으로 잡힘. IMDS 인스턴스 태그(Email) 또는 END_USER_ID_SSM_PARAM을 확인할 것"
fi

# 2026-08-11 결정: Bedrock 그룹은 user.email 자체를 강제 주입해 "빈 곳이 없게" 한다(워크숍
# 운영 요구사항 — 설치 스크립트가 항상 값을 채워야 함). enduser.id/coalesce 폴백(위)은 이
# 주입이 실패했을 때의 방어용으로 그대로 남긴다 — 이게 주 경로다.
# Bedrock 그룹에만 적용하는 이유: Enterprise 세션은 Claude Code 자신이 OAuth 인증된 실제
# user.email을 이미 표준 속성으로 채운다(문서 확인) — 여기서 OTEL_RESOURCE_ATTRIBUTES로
# user.email을 한 번 더 주입하면 그 실제 값과 충돌/덮어쓰기 위험이 있다(SDK가 리소스
# 속성을 병합하는 정확한 우선순위를 확인하지 않았다 — 검증 안 된 값으로 실제 이메일을
# 덮어쓰는 리스크를 감수할 이유가 없다). Bedrock은 애초에 채워질 값이 없으므로 주입만
# 이득이고 충돌 리스크가 없다.
FORCED_USER_EMAIL=""
if [ "$EXPERIMENT_GROUP" = "bedrock" ] && [ -n "$END_USER_ID" ]; then
  FORCED_USER_EMAIL="$END_USER_ID"
fi

# Nonsecret launcher defaults. Do not export a Codex backend through a global
# shell profile or through Claude's managed OTEL_RESOURCE_ATTRIBUTES.
export CODEX_OTEL_RESOURCE_ATTRIBUTES="${CODEX_OTEL_RESOURCE_ATTRIBUTES-team=fsi}"
if [ -n "$END_USER_ID" ]; then
  case ",${CODEX_OTEL_RESOURCE_ATTRIBUTES}," in
    *,user.email=*) ;;
    *) CODEX_OTEL_RESOURCE_ATTRIBUTES="${CODEX_OTEL_RESOURCE_ATTRIBUTES:+${CODEX_OTEL_RESOURCE_ATTRIBUTES},}user.email=${END_USER_ID}" ;;
  esac
fi
CCDASH_CLIENT_ENV=/dev/null /usr/local/bin/ccdash-codex --check >/dev/null
cat > "$BOOTSTRAP_TMP/clients.env" <<EOF
CLAUDE_ENABLED=${CLAUDE_ENABLED}
CODEX_ENABLED=${CODEX_ENABLED}
CODEX_BEDROCK_ENDPOINT=${CODEX_BEDROCK_ENDPOINT}
CODEX_BEDROCK_REGION=${CODEX_BEDROCK_REGION}
CODEX_MODEL=${CODEX_MODEL}
CODEX_VERSION=${CODEX_VERSION}
CODEX_OTEL_RESOURCE_ATTRIBUTES=${CODEX_OTEL_RESOURCE_ATTRIBUTES}
EOF
chmod 644 "$BOOTSTRAP_TMP/clients.env"

# ---- 2. SSM에서 ClickHouse 비밀번호 로드 -----------------------------------
# 인스턴스 프로파일에 ssm:GetParameter + kms:Decrypt 권한 필요
#
# 이 스크립트는 set -euxo pipefail로 돌기 때문에 이 대입문이 그대로 트레이스돼
# /var/log/cloud-init-output.log에 비밀번호가 평문으로 남는다 — 실측 확인(bash 5.2.15): 명령
# 치환 대입은 값을 두 번 찍는다(내부 명령 `++ …`와 대입 `+ CH_PASSWORD=…`). 읽는 구간만
# xtrace를 끈다. `{ set +x; } 2>/dev/null` 형태여야 set +x 자신의 트레이스 한 줄도 안 남는다.
{ set +x; } 2>/dev/null
CH_PASSWORD="$(aws ssm get-parameter \
  --name "$CH_PASSWORD_SSM_PARAM" \
  --with-decryption \
  --region "$AWS_DEFAULT_REGION" \
  --query 'Parameter.Value' --output text)"
set -x

# ---- 3. OTel Collector (contrib) 설치 --------------------------------------
ARCH="$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')"
curl -sL -o "$BOOTSTRAP_TMP/otelcol.tar.gz" \
  "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTELCOL_VERSION}/otelcol-contrib_${OTELCOL_VERSION}_linux_${ARCH}.tar.gz"
mkdir -p /opt/otelcol
tar -xzf "$BOOTSTRAP_TMP/otelcol.tar.gz" -C /opt/otelcol otelcol-contrib
install -m 0755 /opt/otelcol/otelcol-contrib /usr/local/bin/otelcol-contrib

# ---- 4. Collector 설정/시크릿 파일 -----------------------------------------
mkdir -p /etc/otelcol
# exporter 디스크 큐 디렉터리. file_storage의 create_directory=true가 만들긴 하지만, 부모가
# 없으면 실패하므로 여기서 미리 만든다. 이 유닛은 root로 돌아 쓰기 권한이 있다.
mkdir -p /var/lib/otelcol/queue
# collector config 본문은 별도 파일(collector-config.yaml)을 여기에 복사해두는 방식.
# user-data 안에 인라인으로 넣고 싶으면 heredoc으로 바꿔도 됨.
# heredoc 본문은 xtrace에 안 찍힌다(실측: 트레이스는 `+ cat` 한 줄뿐) — 그래도 이 구간을 끄는
# 건 나중에 이 쓰기가 echo/printf로 바뀌어도 평문이 안 새게 하려는 것이다. 이 창을 지우려면
# 위 대입문 가드부터 지워야 하는 게 아니라, 이 파일이 더 이상 비밀번호를 안 다뤄야 한다.
{ set +x; } 2>/dev/null
cat > "$BOOTSTRAP_TMP/collector.env" <<EOF
EXPERIMENT_GROUP=${EXPERIMENT_GROUP}
CLAUDE_ENABLED=${CLAUDE_ENABLED}
CODEX_ENABLED=${CODEX_ENABLED}
CODEX_BEDROCK_ENDPOINT=${CODEX_BEDROCK_ENDPOINT}
CH_HOST=${CH_HOST}
CH_PORT=${CH_PORT}
CH_DB=${CH_DB}
CH_USER=${CH_USER}
CH_PASSWORD=${CH_PASSWORD}
OTELCOL_QUEUE_DIR=/var/lib/otelcol/queue
EOF
set -x
chmod 600 "$BOOTSTRAP_TMP/collector.env"

# Validate the staged release before changing persistent configuration or stopping
# an existing collector. Never reuse an old config that lacks the Codex pipeline.
install -m 0644 "$BOOTSTRAP_ASSET_DIR/collector-config.yaml" "$BOOTSTRAP_TMP/config.yaml"
{ set +x; } 2>/dev/null
if ! (
  export EXPERIMENT_GROUP CH_HOST CH_PORT CH_DB CH_USER CH_PASSWORD
  export OTELCOL_QUEUE_DIR=/var/lib/otelcol/queue
  /usr/local/bin/otelcol-contrib validate --config "$BOOTSTRAP_TMP/config.yaml"
) > "$BOOTSTRAP_TMP/validate.log" 2>&1; then
  echo "ERROR: Collector candidate validation failed; existing configuration and service were not replaced" >&2
  exit 1
fi
set -x

# Prepare replacements beside their destinations, then rename each atomically.
mkdir -p /etc/ccdash
install -m 0644 "$BOOTSTRAP_TMP/clients.env" /etc/ccdash/.clients.env.next
install -m 0600 "$BOOTSTRAP_TMP/collector.env" /etc/otelcol/.env.next
install -m 0644 "$BOOTSTRAP_TMP/config.yaml" /etc/otelcol/.config.yaml.next
mv -f /etc/ccdash/.clients.env.next /etc/ccdash/clients.env
mv -f /etc/otelcol/.env.next /etc/otelcol/env
mv -f /etc/otelcol/.config.yaml.next /etc/otelcol/config.yaml

# ---- 5. Collector systemd 서비스 -------------------------------------------
cat > /etc/systemd/system/otelcol.service <<'EOF'
[Unit]
Description=OpenTelemetry Collector (Claude Code and Codex)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/otelcol/env
ExecStartPre=/usr/local/bin/ccdash-codex --check
ExecStartPre=/usr/local/bin/otelcol-contrib validate --config /etc/otelcol/config.yaml
ExecStart=/usr/local/bin/otelcol-contrib --config /etc/otelcol/config.yaml
Restart=always
RestartSec=5
# 로컬 수신만 하므로 외부 노출 최소화
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

COLLECTOR_SERVICE_CHANGED=1
systemctl daemon-reload
systemctl enable otelcol.service
systemctl restart otelcol.service
for startup_check in 1 2 3 4 5; do
  sleep 1
  if ! systemctl is-active --quiet otelcol.service; then
    echo "ERROR: Collector did not remain active during startup" >&2
    exit 1
  fi
done

# ---- 6. Claude Code managed settings 배포 ----------------------------------
# managed settings의 env는 우선순위가 높아 사용자가 덮어쓸 수 없음 → A/B 무결성 확보
#
# 운영 주의 (STEP 5, 문서로 확인된 동작):
#   - 여기 OTEL_EXPORTER_OTLP_*를 넣으면 Claude Code가 시작 시 개발자가 설정한 per-signal
#     endpoint/protocol/credential(OTEL_EXPORTER_OTLP_METRICS_ENDPOINT 등)을 전부 제거한다.
#     우리는 이 동작을 의도한다(모든 시그널이 항상 이 managed endpoint로만 가야 함) —
#     디버깅 시 `claude --debug`로 이 제거가 실제 일어났는지 warning을 확인할 수 있다.
#   - Claude Code는 OTEL_*를 Bash 툴·훅·MCP 서버·language server 같은 서브프로세스에
#     전달하지 않는다. 훅에서 자체 계측이 필요하면 훅 스크립트 쪽에 별도로 env를 주입해야
#     한다. (단 tracing이 켜지면 Bash/PowerShell 서브프로세스는 TRACEPARENT는 자동 상속한다 —
#     이건 예외.)
#   - claude_code.internal_error 이벤트는 Bedrock에서 emit되지 않는다(문서 확인) — 에러율
#     비교 패널에서 그룹 간 직접 비교 금지(grafana-ab-queries.sql에도 동일 경고).
if [ "$CLAUDE_ENABLED" = "true" ]; then
mkdir -p /etc/claude-code

# 그룹별 분기 env
if [ "$EXPERIMENT_GROUP" = "bedrock" ]; then
  GROUP_ENV='"CLAUDE_CODE_USE_BEDROCK": "1",
    "AWS_REGION": "'"${AWS_DEFAULT_REGION}"'",'
else
  GROUP_ENV=''
fi

# OTEL_RESOURCE_ATTRIBUTES는 값에 공백 금지, 쉼표로 key=value 구분 — enduser.id는 위
# 1c 단계에서 이미 그 포맷을 검증했다(위험 문자 있으면 빈 문자열). END_USER_ID가 비어 있으면
# 아래 if가 enduser.id 세그먼트 자체를 붙이지 않는다 — 빈 attribute(`enduser.id=`)조차
# 만들지 않는다.
RESOURCE_ATTRS="experiment.group=${EXPERIMENT_GROUP},team=fsi"
if [ -n "$END_USER_ID" ]; then
  RESOURCE_ATTRS="${RESOURCE_ATTRS},enduser.id=${END_USER_ID}"
fi
# FORCED_USER_EMAIL은 위에서 이미 bedrock 그룹 + 값 존재로 게이팅됐다 — Enterprise는 항상
# 빈 문자열이라 이 줄이 실행되지 않는다(실제 인증된 user.email을 덮어쓰지 않음).
if [ -n "$FORCED_USER_EMAIL" ]; then
  RESOURCE_ATTRS="${RESOURCE_ATTRS},user.email=${FORCED_USER_EMAIL}"
fi

# project.name은 여기서 넣지 않는다 — 인스턴스 단위가 아니라 저장소 단위 값이라 한 인스턴스가
# 여러 저장소를 오가면 틀린 태그가 붙는다. 다만 이 파일이 managed-settings.json으로
# OTEL_RESOURCE_ATTRIBUTES를 소유하므로 저장소별 .claude/settings.json은 이 플릿에서 무효다
# (프로젝트 값이 문자열 전체를 교체하지만 managed가 프로젝트를 이긴다) — 주입 방법과 운영자가
# 골라야 하는 두 선택지는 README §Telemetry Ingestion의 'Project tag (project.name)' 참고.
cat > /etc/claude-code/managed-settings.json <<EOF
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "grpc",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4317",
    "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "cumulative",
    "OTEL_METRIC_EXPORT_INTERVAL": "30000",
    "OTEL_LOGS_EXPORT_INTERVAL": "5000",
    "OTEL_METRICS_INCLUDE_SESSION_ID": "true",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_TRACES_EXPORT_INTERVAL": "5000",
    ${GROUP_ENV}
    "OTEL_RESOURCE_ATTRIBUTES": "${RESOURCE_ATTRS}"
  }
}
EOF
chmod 644 /etc/claude-code/managed-settings.json
fi

echo "=== Telemetry bootstrap configured (claude=${CLAUDE_ENABLED}, codex=${CODEX_ENABLED}, codex_endpoint=${CODEX_BEDROCK_ENDPOINT}, cc_version=${FINAL_CC_VERSION}) ==="
