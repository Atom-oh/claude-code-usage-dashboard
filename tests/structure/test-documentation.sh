#!/usr/bin/env bash
if python3 scripts/check-docs.py && python3 tests/structure/test_docs.py; then
    pass "project documentation is English, linked, and scoped"
else
    fail "project documentation is English, linked, and scoped" "documentation checks failed"
fi
