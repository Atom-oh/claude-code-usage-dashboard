#!/usr/bin/env bash
if python3 tests/structure/test_local_client_telemetry.py; then
    pass "local telemetry setup preserves routing and configures both clients"
else
    fail "local telemetry setup preserves routing and configures both clients" "client configuration regression"
fi
