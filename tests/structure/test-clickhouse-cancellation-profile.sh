#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if python3 -B "$ROOT/tests/structure/test_clickhouse_cancellation_profile.py"; then
  pass "ClickHouse reader enables disconnect cancellation and retains readonly resource ceilings"
else
  fail "ClickHouse reader enables disconnect cancellation and retains readonly resource ceilings"
fi
