#!/bin/bash
set -euxo pipefail

# =============================================================================
# Claude Code A/B Telemetry — EC2 user-data
# 두 그룹 공통 스크립트. 그룹 구분은 EXPERIMENT_GROUP 값 하나로만.
#   - Group A: EXPERIMENT_GROUP=bedrock      (Claude Code on Bedrock)
#   - Group B: EXPERIMENT_GROUP=enterprise   (Claude Code Enterprise / Anthropic API)
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

# ---- 1. 기본 패키지 ---------------------------------------------------------
if command -v dnf >/dev/null 2>&1; then PKG=dnf; else PKG=yum; fi
$PKG install -y tar gzip curl unzip

# AWS CLI v2 (SSM 파라미터 로드에 사용) — Amazon Linux는 보통 기본 포함
if ! command -v aws >/dev/null 2>&1; then
  curl -sL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install
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
mkdir -p /etc/claude-code

# 그룹별 분기 env
if [ "$EXPERIMENT_GROUP" = "bedrock" ]; then
  GROUP_ENV='"CLAUDE_CODE_USE_BEDROCK": "1",
    "AWS_REGION": "'"${AWS_DEFAULT_REGION}"'",'
else
  GROUP_ENV=''
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
    ${GROUP_ENV}
    "OTEL_RESOURCE_ATTRIBUTES": "experiment.group=${EXPERIMENT_GROUP},team=fsi"
  }
}
EOF
chmod 644 /etc/claude-code/managed-settings.json

echo "=== Claude Code A/B telemetry provisioning complete (group=${EXPERIMENT_GROUP}) ==="
