#!/usr/bin/env bash
# Exercise actual installation lookups using mocked providers; never contact AWS.
set -euo pipefail
PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TASK_DIR=$(mktemp -d /tmp/ccdash-installation-tf.XXXXXX)
trap 'rm -rf "$TASK_DIR"' EXIT
cp "$PROJECT_ROOT"/infra/{data,installation,variables,identity,nodepool}.tf "$TASK_DIR/"
cp "$PROJECT_ROOT/infra/.terraform.lock.hcl" "$TASK_DIR/"
mkdir "$TASK_DIR/tests"
cp "$PROJECT_ROOT/infra/test-fixtures/installation.tftest.hcl" "$TASK_DIR/tests/"
cat > "$TASK_DIR/fixture.tf" <<'HCL'
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = "~> 6.0"
      configuration_aliases = [aws.us_east_1]
    }
    kubectl = {
      source  = "gavinbunney/kubectl"
      version = "~> 1.14"
    }
  }
}
output "node_role_name" { value = local.node_role_name }
output "nodeclass" {
  value     = yamldecode(kubectl_manifest.claude_code_nodeclass.yaml_body)
  sensitive = true
}
output "subnet_ids" { value = data.aws_subnets.private.ids }
HCL
terraform -chdir="$TASK_DIR" init -backend=false -input=false \
  -plugin-dir="$PROJECT_ROOT/infra/.terraform/providers" >/dev/null
terraform -chdir="$TASK_DIR" test -no-color
