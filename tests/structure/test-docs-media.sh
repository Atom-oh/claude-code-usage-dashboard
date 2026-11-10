#!/usr/bin/env bash
if python3 tests/structure/test_docs_media.py; then
    pass "documentation media uses pinned hashes and safe cached files"
else
    fail "documentation media uses pinned hashes and safe cached files" "media checks failed"
fi
