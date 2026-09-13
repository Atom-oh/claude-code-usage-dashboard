#!/usr/bin/env bash
# Pure local snapshot/prompt tests; no model or network calls.
if python3 tests/structure/test_review_context.py; then
    pass "review prompts use bounded trusted English context"
else
    fail "review prompts use bounded trusted English context" "snapshot/prompt checks failed"
fi
