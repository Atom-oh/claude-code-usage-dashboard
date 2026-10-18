#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if python3 -B "$ROOT/tests/structure/test_schema_lifecycle.py"; then
  pass "Schema lifecycle freezes bootstrap inputs and verifies existing installations without DDL"
else
  fail "Schema lifecycle freezes bootstrap inputs and verifies existing installations without DDL"
fi
