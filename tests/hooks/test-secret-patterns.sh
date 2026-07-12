#!/bin/bash
# True positive tests — patterns that MUST match
assert_grep_match "TP: AWS Access Key ID" 'AKIA[0-9A-Z]{16}' "AKIAIOSFODNN7EXAMPLE"

# Runtime-constructed tokens (avoid GitHub Push Protection)
SLACK_PREFIX="xoxb-"
SLACK_BODY="123456789012-1234567890123-abcdef"
assert_grep_match "TP: Slack Bot Token" 'xoxb-[0-9]+-[A-Za-z0-9]+' "${SLACK_PREFIX}${SLACK_BODY}"

GH_PREFIX="ghp_"
GH_BODY="1234567890123456789012345678901234AB"
assert_grep_match "TP: GitHub PAT" 'ghp_[A-Za-z0-9]{36}' "${GH_PREFIX}${GH_BODY}"

CH_LINE='CH_PASSWORD = "supersecretpassword"'
assert_grep_match "TP: ClickHouse password literal" 'CH_PASSWORD\s*[:=]\s*["\x27][^"\x27]{4,}' "$CH_LINE"

# False positive tests — patterns that must NOT match
assert_grep_no_match "FP: Normal base64" 'AKIA[0-9A-Z]{16}' "dGhpcyBpcyBhIHRlc3Q="
assert_grep_no_match "FP: Empty password" 'password\s*[:=]\s*["\x27][^"\x27]{8,}' 'password = ""'
assert_grep_no_match "FP: CH_PASSWORD placeholder (empty)" 'CH_PASSWORD\s*[:=]\s*["\x27][^"\x27]{4,}' 'CH_PASSWORD='
assert_grep_no_match "FP: env var reference, not a literal" 'CH_PASSWORD\s*[:=]\s*["\x27][^"\x27]{4,}' 'CH_PASSWORD=$CH_PASSWORD_SECRET'
