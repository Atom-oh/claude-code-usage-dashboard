#!/usr/bin/env bash
. scripts/pr-review/lib.sh

VERDICT_DIR=$(mktemp -d)
VERDICT_FILE="$VERDICT_DIR/review.md"
printf 'Quoted example:\nVERDICT: FAIL\nFinal decision:\nVERDICT: PASS\n\n' > "$VERDICT_FILE"
VERDICT_RESULT=$(review_verdict "$VERDICT_FILE" 2>/dev/null) || VERDICT_RESULT="invalid"
assert_eq "quoted verdict does not override final PASS" "pass" "$VERDICT_RESULT"

printf 'VERDICT: PASS\nVERDICT: FAIL\n' > "$VERDICT_FILE"
VERDICT_RESULT=$(review_verdict "$VERDICT_FILE" 2>/dev/null) || VERDICT_RESULT="invalid"
assert_eq "final FAIL remains blocking" "fail" "$VERDICT_RESULT"

for VERDICT_TEXT in 'VERDICT: MAYBE' ' VERDICT: PASS' 'VERDICT: PASS ' 'No verdict'; do
    printf '%s\n' "$VERDICT_TEXT" > "$VERDICT_FILE"
    VERDICT_RESULT=$(review_verdict "$VERDICT_FILE" 2>/dev/null) || VERDICT_RESULT="invalid"
    assert_eq "noncanonical verdict stays invalid: $VERDICT_TEXT" "invalid" "$VERDICT_RESULT"
done

: > "$VERDICT_FILE"
VERDICT_RESULT=$(review_verdict "$VERDICT_FILE" 2>/dev/null) || VERDICT_RESULT="invalid"
assert_eq "empty review is not approval" "invalid" "$VERDICT_RESULT"
rm "$VERDICT_FILE"
VERDICT_RESULT=$(review_verdict "$VERDICT_FILE" 2>/dev/null) || VERDICT_RESULT="invalid"
assert_eq "missing review is not approval" "invalid" "$VERDICT_RESULT"
rm -rf "$VERDICT_DIR"
