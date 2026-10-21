#!/usr/bin/env bash
# Exercise the actual opt-in device resources with mocked providers only.
set -euo pipefail
PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TASK_DIR=$(mktemp -d /tmp/ccdash-device-tf.XXXXXX)
trap 'rm -rf "$TASK_DIR"' EXIT
mkdir -p "$TASK_DIR/infra/tests" "$TASK_DIR/dashboard/collector/generated"
cp "$PROJECT_ROOT/infra/device_ingest.tf" "$TASK_DIR/infra/"
cp "$PROJECT_ROOT/dashboard/collector/generated/central.yaml" "$TASK_DIR/dashboard/collector/generated/"
cp "$PROJECT_ROOT/infra/.terraform.lock.hcl" "$TASK_DIR/infra/"
cp "$PROJECT_ROOT/infra/test-fixtures/device-ingest.tftest.hcl" "$TASK_DIR/infra/tests/"
cat > "$TASK_DIR/infra/fixture.tf" <<'HCL'
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.33" }
  }
}
variable "auth_mode" { default = "oidc" }
variable "region" { default = "us-east-1" }
variable "k8s_namespace" { default = "fixture" }
variable "claude_enabled" { default = true }
variable "codex_enabled" { default = true }
locals {
  chi_service = "clickhouse.fixture.svc.cluster.local"
  ch_node_selector = { "fixture" = "true" }
}
resource "kubernetes_namespace" "claude_code" {
  metadata { name = var.k8s_namespace }
}
resource "kubernetes_secret" "clickhouse_ingest" {
  metadata { name = "fixture-ingest" }
}
resource "aws_iam_role" "dashboard_bedrock" {
  name = "fixture"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [] })
}
HCL
terraform -chdir="$TASK_DIR/infra" init -backend=false -input=false \
  -plugin-dir="$PROJECT_ROOT/infra/.terraform/providers" >/dev/null
terraform -chdir="$TASK_DIR/infra" test -no-color
