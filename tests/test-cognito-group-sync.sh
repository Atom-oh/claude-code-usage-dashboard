#!/usr/bin/env bash

if python3 -m unittest discover -s integrations/cognito-group-sync -p 'test_*.py'; then
    pass "Cognito group reconciliation preserves policy and shared-pool boundaries"
else
    fail "Cognito group reconciliation preserves policy and shared-pool boundaries" "offline integration tests failed"
fi
