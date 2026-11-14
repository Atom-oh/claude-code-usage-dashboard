#!/usr/bin/env bash
if node --test video/docs-demo/remotion/audio.test.mjs video/product-tour/media.test.mjs && python3 -m unittest discover -s video/product-tour -p test_audio_generation.py; then
    pass "documentation narration fits scenes, captions match speech, and music ducks"
else
    fail "documentation audio composition" "narration, caption or mix checks failed"
fi
