#!/usr/bin/env bash
# Test the actual Bedrock policy with mocked AWS data and no account access.
set -euo pipefail
PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ! -d "$PROJECT_ROOT/infra/.terraform/providers" ]]; then
  echo "Initialize committed providers first: terraform -chdir=infra init -backend=false" >&2
  exit 1
fi
TASK_DIR=$(mktemp -d /tmp/ccdash-bedrock-routing-tf.XXXXXX)
trap 'rm -rf "$TASK_DIR"' EXIT
cp "$PROJECT_ROOT"/infra/{bedrock,variables}.tf "$TASK_DIR/"
cp "$PROJECT_ROOT/infra/.terraform.lock.hcl" "$TASK_DIR/"
mkdir "$TASK_DIR/tests"
cp "$PROJECT_ROOT/infra/test-fixtures/bedrock-routing.tftest.hcl" "$TASK_DIR/tests/"
cat > "$TASK_DIR/fixture.tf" <<'HCL'
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
data "aws_caller_identity" "current" {}
resource "aws_iam_role" "dashboard_bedrock" {
  name               = "fixture-dashboard-role"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [] })
}
HCL
terraform -chdir="$TASK_DIR" init -backend=false -input=false \
  -plugin-dir="$PROJECT_ROOT/infra/.terraform/providers" >/dev/null
terraform -chdir="$TASK_DIR" test -no-color
