#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if python3 -B "$ROOT/tests/structure/test_capacity_benchmark.py"; then
  pass "capacity benchmark keeps synthetic isolation, complete usage, limits and semantic checks"
else
  fail "capacity benchmark keeps synthetic isolation, complete usage, limits and semantic checks"
fi
