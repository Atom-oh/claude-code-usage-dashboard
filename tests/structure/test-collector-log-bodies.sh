#!/usr/bin/env bash
if python3 -B tests/structure/test_collector_log_bodies.py; then
    pass "body-only Collector drafts preserve authentication and measurements"
else
    fail "body-only Collector drafts preserve authentication and measurements" "configuration regression"
fi
