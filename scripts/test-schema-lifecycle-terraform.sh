#!/usr/bin/env bash
# Plan the actual schema lifecycle resources with mocked providers; never access a cluster.
set -euo pipefail
PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ! -d "$PROJECT_ROOT/infra/.terraform/providers" ]]; then
  echo "Initialize the committed providers first: terraform -chdir=infra init -backend=false" >&2
  exit 1
fi
TASK_DIR=$(mktemp -d /tmp/ccdash-schema-tf.XXXXXX)
trap 'rm -rf "$TASK_DIR"' EXIT
cp "$PROJECT_ROOT/infra/schema.tf" "$PROJECT_ROOT/infra/.terraform.lock.hcl" "$TASK_DIR/"
mkdir "$TASK_DIR/tests" "$TASK_DIR/files"
cp "$PROJECT_ROOT"/infra/files/clickhouse-schema-{replicated.sql,contract.sql,init.sh} "$TASK_DIR/files/"
cp "$PROJECT_ROOT/infra/test-fixtures/schema-lifecycle.tftest.hcl" "$TASK_DIR/tests/"
cat > "$TASK_DIR/fixture.tf" <<'HCL'
terraform {
  required_version = ">= 1.9"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.33"
    }
    kubectl = {
      source  = "gavinbunney/kubectl"
      version = "~> 1.14"
    }
  }
}
locals {
  ch_node_selector = { "node-type" = "claude-code" }
  chi_service      = "clickhouse-cc-ab.fixture-namespace.svc.cluster.local"
}
resource "kubernetes_namespace" "claude_code" {
  metadata { name = "fixture-namespace" }
}
resource "kubernetes_secret" "clickhouse_writer" {
  metadata { name = "fixture-writer" }
  data = { CH_PASSWORD = "YOUR_SYNTHETIC_SCHEMA_FIXTURE_PASSWORD" }
}
resource "kubectl_manifest" "chi" {
  yaml_body = <<-YAML
    apiVersion: clickhouse.altinity.com/v1
    kind: ClickHouseInstallation
    metadata:
      name: fixture
  YAML
}
HCL
terraform -chdir="$TASK_DIR" init -backend=false -input=false \
  -plugin-dir="$PROJECT_ROOT/infra/.terraform/providers" >/dev/null
terraform -chdir="$TASK_DIR" test -no-color
