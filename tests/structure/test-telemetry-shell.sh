#!/usr/bin/env bash
if python3 tests/structure/test_telemetry_shell.py; then
    pass "telemetry shell distinguishes inaccessible systemd from confirmed inactivity"
else
    fail "telemetry shell distinguishes inaccessible systemd from confirmed inactivity" "shell lifecycle regression"
fi
