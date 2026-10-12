#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if python3 "$PROJECT_ROOT/tests/structure/test_install_preflight.py"; then
  pass "read-only customer installation preflight"
else
  fail "read-only customer installation preflight" "Python preflight tests failed"
fi
