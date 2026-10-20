#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if python3 -B "$ROOT/tests/structure/test_eks_provider_auth.py"; then
  pass "EKS providers use runtime credentials with explicit cluster and TLS configuration"
else
  fail "EKS providers use runtime credentials with explicit cluster and TLS configuration" "source contract failed"
fi
