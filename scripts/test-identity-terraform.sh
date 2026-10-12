#!/usr/bin/env bash
# Validate actual identity input files without providers, AWS credentials or deployment.
set -euo pipefail
PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TASK_DIR=$(mktemp -d /tmp/ccdash-identity-tf.XXXXXX)
trap 'rm -rf "$TASK_DIR"' EXIT
cp "$PROJECT_ROOT/infra/identity.tf" "$PROJECT_ROOT/infra/variables.tf" "$TASK_DIR/"
mkdir "$TASK_DIR/tests"
cp "$PROJECT_ROOT/tests/fixtures/identity.tftest.hcl" "$TASK_DIR/tests/"
cat > "$TASK_DIR/outputs.tf" <<'HCL'
terraform {
  required_version = ">= 1.9"
}
output "oidc_environment" {
  value = local.oidc_environment
}
output "auth_mode" {
  value = var.auth_mode
}
output "oidc_secret_name" {
  value = var.oidc_secret_name
}
HCL
terraform -chdir="$TASK_DIR" init -backend=false -input=false >/dev/null
terraform -chdir="$TASK_DIR" test -no-color
