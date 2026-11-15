#!/usr/bin/env bash
if python3 tests/structure/test_docs_media.py; then
    pass "documentation media uses pinned hashes and safe cached files"
else
    fail "documentation media uses pinned hashes and safe cached files" "media checks failed"
fi

if node --test scripts/docs-capture/locale-labels.test.mjs scripts/docs-capture/fixtures.test.mjs; then
    pass "guide capture selectors and synthetic Skills fixture remain valid"
else
    fail "guide capture selectors and synthetic Skills fixture remain valid" "capture checks failed"
fi
