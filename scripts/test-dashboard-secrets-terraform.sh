#!/usr/bin/env bash
# Plan the actual deployment and secret-mount locals with mock providers only.
set -euo pipefail
PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ! -d "$PROJECT_ROOT/infra/.terraform/providers" ]]; then
  echo "Initialize providers first: terraform -chdir=infra init -backend=false" >&2
  exit 1
fi
TASK_DIR=$(mktemp -d /tmp/ccdash-dashboard-tf.XXXXXX)
trap 'rm -rf "$TASK_DIR"' EXIT
cp "$PROJECT_ROOT/infra/.terraform.lock.hcl" "$TASK_DIR/"
mkdir "$TASK_DIR/tests"
cp "$PROJECT_ROOT/infra/test-fixtures/dashboard-secrets.tftest.hcl" "$TASK_DIR/tests/"
python3 - "$PROJECT_ROOT/infra/dashboard.tf" "$TASK_DIR/deployment.tf" <<'PY'
from pathlib import Path
import sys
source = Path(sys.argv[1]).read_text()
def block(start):
    begin = source.index(start)
    depth = 0
    for pos in range(begin, len(source)):
        if source[pos] == "{": depth += 1
        elif source[pos] == "}":
            depth -= 1
            if depth == 0: return source[begin:pos + 1]
    raise ValueError(start)
prefix = source[:source.index('resource "kubernetes_secret" "dashboard_basic_auth"')]
Path(sys.argv[2]).write_text(prefix + '\n' + block('locals {\n  dashboard_secret_mounts') + '\n' + block('resource "kubernetes_deployment_v1" "dashboard"') + '\n')
PY
cat > "$TASK_DIR/fixture.tf" <<'HCL'
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.33" }
  }
}
variable "region" { default = "ap-northeast-2" }
variable "chat_model_id" { default = "fixture" }
variable "bedrock_region" { default = "" }
variable "pii_mask_enabled" { default = false }
variable "auth_mode" { default = "basic" }
variable "oidc_secret_name" { default = "fixture-oidc" }
variable "device_ingest_enabled" { default = false }
variable "device_ingest_secret_name" { default = "fixture-device" }
locals {
  chi_service = "fixture"
  ch_node_selector = { "node-type" = "fixture" }
  oidc_environment = {}
  device_ingest_environment = {}
  insights_environment = {}
}
resource "aws_ecr_repository" "dashboard" { name = "fixture" }
resource "kubernetes_namespace" "claude_code" {
  metadata { name = "fixture" }
}
resource "kubernetes_service_account" "dashboard" {
  metadata { name = "dashboard" }
}
resource "kubernetes_secret" "clickhouse_reader" {
  metadata { name = "reader" }
}
resource "kubernetes_secret" "dashboard_basic_auth" {
  metadata { name = "basic" }
}
resource "kubernetes_secret" "dashboard_alert" {
  count = var.alert_webhook_url == null ? 0 : 1
  metadata { name = "alert" }
}
resource "kubernetes_job_v1" "schema_init" {
  metadata { name = "fixture" }
  spec {
    template {
      metadata { name = "fixture" }
      spec {
        container {
          name  = "fixture"
          image = "fixture"
        }
      }
    }
  }
}
HCL
terraform -chdir="$TASK_DIR" init -backend=false -input=false -plugin-dir="$PROJECT_ROOT/infra/.terraform/providers" >/dev/null
TF_VAR_dashboard_image_tag=fixture terraform -chdir="$TASK_DIR" test -no-color
