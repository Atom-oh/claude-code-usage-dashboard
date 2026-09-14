#!/bin/bash
# Launcher and bootstrap tests require no AWS credentials or model calls.
if python3 -B tests/structure/test_client_collection.py; then
    pass "selectable client configuration and bootstrap"
else
    fail "selectable client configuration and bootstrap" "Python contract tests failed"
fi

if [ "${RUN_COLLECTOR_TESTS:-0}" = "1" ]; then
    if python3 -B tests/structure/test_collector_clients.py; then
        pass "Collector 0.119 client ingestion"
    else
        fail "Collector 0.119 client ingestion" "isolated integration tests failed"
    fi
else
    skip "Collector 0.119 client ingestion" "set RUN_COLLECTOR_TESTS=1; requires Docker and PyYAML"
fi
