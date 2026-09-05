#!/bin/bash
# Tests for .claude/hooks/*.sh

# .claude/ 는 gitignore 대상(로컬 도구 전용)이라 fresh clone / CI 체크아웃에는 아예 없다 —
# 없으면 실패가 아니라 skip이다. run-all.sh가 set -euo pipefail 아래에서 이 파일을 source하므로,
# 없는 파일을 읽는 명령 치환(SETTINGS=$(cat …), OUTPUT=$(bash …))은 한 건의 실패가 아니라
# 스위트 전체를 중단시킨다 — 그래서 개별 단정문을 고치는 게 아니라 블록 전체를 가드로 감싼다.
if [ -d .claude ]; then
    # --- Existence and permissions ---
    HOOKS=(check-doc-sync secret-scan session-context notify)
    for hook in "${HOOKS[@]}"; do
        assert_file_exists "$hook.sh exists" ".claude/hooks/$hook.sh"
        assert_file_executable "$hook.sh is executable" ".claude/hooks/$hook.sh"
        assert_bash_syntax "$hook.sh valid bash" ".claude/hooks/$hook.sh"
    done

    # --- settings.json hook registration ---
    assert_file_exists "settings.json exists" ".claude/settings.json"
    assert_json_valid "settings.json is valid JSON" ".claude/settings.json"

    SETTINGS=$(cat .claude/settings.json)
    assert_contains "SessionStart hook registered" "$SETTINGS" "session-context.sh"
    assert_contains "PreToolUse hook registered" "$SETTINGS" "secret-scan.sh"
    assert_contains "PostToolUse hook registered" "$SETTINGS" "check-doc-sync.sh"
    assert_contains "PostToolUse matcher is Write|Edit" "$SETTINGS" "Write|Edit"
    assert_contains "Notification hook registered" "$SETTINGS" "notify.sh"

    # --- Behavior tests ---
    # check-doc-sync: empty path should produce no output
    OUTPUT=$(bash .claude/hooks/check-doc-sync.sh "" 2>&1)
    assert_eq "check-doc-sync: empty path produces no output" "" "$OUTPUT"

    # check-doc-sync: source root detection matches this repo (not the generic src/app/lib default)
    assert_contains "check-doc-sync: adapted to dashboard/server source root" "$(cat .claude/hooks/check-doc-sync.sh)" "dashboard/server"
    assert_contains "check-doc-sync: adapted to infra source root" "$(cat .claude/hooks/check-doc-sync.sh)" "infra"

    # session-context: should output project info
    OUTPUT=$(bash .claude/hooks/session-context.sh 2>&1)
    assert_contains "session-context: shows project header" "$OUTPUT" "Project Context"

    # notify: no webhook URL should exit silently
    OUTPUT=$(CLAUDE_NOTIFY_WEBHOOK="" bash .claude/hooks/notify.sh "test" "msg" 2>&1)
    assert_eq "notify.sh: no webhook URL produces no output" "" "$OUTPUT"
else
    skip ".claude/hooks/*.sh exist, are executable and are valid bash" ".claude/ is local-only (gitignored)"
    skip ".claude/settings.json registers every hook" ".claude/ is local-only (gitignored)"
    skip ".claude/hooks/*.sh behavior (check-doc-sync, session-context, notify)" ".claude/ is local-only (gitignored)"
fi
