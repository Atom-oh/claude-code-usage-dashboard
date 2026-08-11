#!/bin/bash
set -euxo pipefail

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
CH_USER="otel_writer"
# 비밀번호는 하드코딩 금지 → SSM Parameter Store(SecureString)에서 로드
CH_PASSWORD_SSM_PARAM="/claude-code/ab/clickhouse-writer-password"

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
$PKG install -y tar gzip curl unzip

# AWS CLI v2 (SSM 파라미터 로드에 사용) — Amazon Linux는 보통 기본 포함
if ! command -v aws >/dev/null 2>&1; then
  curl -sL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install
fi

# ---- 1b. Claude Code CLI 설치 (버전 핀, 4-2) -------------------------------
# 이 AMI가 Claude Code를 프리베이크한다면 이 블록은 no-op(이미 설치돼 있으면 건너뜀) —
# 버전이 CLAUDE_CODE_VERSION과 다르면 경고만 내고 부팅을 막지는 않는다(set -e로 인스턴스가
# 죽으면 워크숍 전체가 막히므로).
if ! command -v npm >/dev/null 2>&1; then
  $PKG install -y nodejs npm
fi
INSTALLED_CC_VERSION="$(command -v claude >/dev/null 2>&1 && claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo '')"
if [ "$INSTALLED_CC_VERSION" != "$CLAUDE_CODE_VERSION" ]; then
  npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" || \
    echo "WARN: claude-code ${CLAUDE_CODE_VERSION} 설치 실패 — 기존 버전(${INSTALLED_CC_VERSION:-미설치})으로 계속 진행. A/B 버전 혼재 위험, 패널 19로 확인할 것."
fi
FINAL_CC_VERSION="$(command -v claude >/dev/null 2>&1 && claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo 'unknown')"
if [ "$FINAL_CC_VERSION" != "$CLAUDE_CODE_VERSION" ]; then
  echo "WARN: 이 인스턴스의 Claude Code 버전(${FINAL_CC_VERSION})이 기대값(${CLAUDE_CODE_VERSION})과 다름 — A/B 이중계상/MCP 의미 변경 경계를 넘을 수 있음"
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

# ---- 2. SSM에서 ClickHouse 비밀번호 로드 -----------------------------------
# 인스턴스 프로파일에 ssm:GetParameter + kms:Decrypt 권한 필요
CH_PASSWORD="$(aws ssm get-parameter \
  --name "$CH_PASSWORD_SSM_PARAM" \
  --with-decryption \
  --region "$AWS_DEFAULT_REGION" \
  --query 'Parameter.Value' --output text)"

# ---- 3. OTel Collector (contrib) 설치 --------------------------------------
ARCH="$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')"
curl -sL -o /tmp/otelcol.tar.gz \
  "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTELCOL_VERSION}/otelcol-contrib_${OTELCOL_VERSION}_linux_${ARCH}.tar.gz"
mkdir -p /opt/otelcol
tar -xzf /tmp/otelcol.tar.gz -C /opt/otelcol otelcol-contrib
install -m 0755 /opt/otelcol/otelcol-contrib /usr/local/bin/otelcol-contrib

# ---- 4. Collector 설정/시크릿 파일 -----------------------------------------
mkdir -p /etc/otelcol
# collector config 본문은 별도 파일(collector-config.yaml)을 여기에 복사해두는 방식.
# user-data 안에 인라인으로 넣고 싶으면 heredoc으로 바꿔도 됨.
cat > /etc/otelcol/env <<EOF
EXPERIMENT_GROUP=${EXPERIMENT_GROUP}
CH_HOST=${CH_HOST}
CH_PORT=${CH_PORT}
CH_DB=${CH_DB}
CH_USER=${CH_USER}
CH_PASSWORD=${CH_PASSWORD}
EOF
chmod 600 /etc/otelcol/env

# collector-config.yaml 배포 (S3 등에서 받아오거나, AMI에 미리 포함).
# 예: aws s3 cp s3://my-bucket/collector-config.yaml /etc/otelcol/config.yaml
# 아래는 임시로 최소 config를 직접 생성하는 fallback. (2단계 산출물로 교체 권장)
if [ ! -f /etc/otelcol/config.yaml ]; then
  aws s3 cp "s3://YOUR-CONFIG-BUCKET/collector-config.yaml" /etc/otelcol/config.yaml \
    --region "$AWS_DEFAULT_REGION" || {
      echo "WARN: collector-config.yaml 미배포 — 2단계 산출물을 /etc/otelcol/config.yaml 로 넣으세요"; }
fi

# ---- 5. Collector systemd 서비스 -------------------------------------------
cat > /etc/systemd/system/otelcol.service <<'EOF'
[Unit]
Description=OpenTelemetry Collector (Claude Code A/B)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/otelcol/env
ExecStart=/usr/local/bin/otelcol-contrib --config /etc/otelcol/config.yaml
Restart=always
RestartSec=5
# 로컬 수신만 하므로 외부 노출 최소화
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now otelcol.service

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

echo "=== Claude Code A/B telemetry provisioning complete (group=${EXPERIMENT_GROUP}, cc_version=${FINAL_CC_VERSION}) ==="
