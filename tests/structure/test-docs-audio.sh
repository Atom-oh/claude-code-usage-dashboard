#!/usr/bin/env bash
if node --test video/docs-demo/remotion/audio.test.mjs; then
    pass "documentation narration fits scenes, captions match speech, and music ducks"
else
    fail "documentation audio composition" "narration, caption or mix checks failed"
fi
