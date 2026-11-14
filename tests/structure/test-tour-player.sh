#!/usr/bin/env bash
if node --test tests/structure/tour-player.test.mjs; then
    pass "tour caption initialization handles preloaded metadata and preserves user choices"
else
    fail "tour caption initialization" "caption state regression"
fi
