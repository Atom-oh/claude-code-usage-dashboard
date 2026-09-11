#!/bin/bash
# scripts/pr-review/run-panel.sh 의 Kiro 셀 fail-closed 계약을 핀한다.
# kiro-cli 2.11.1 에서 `--trust-tools=`(빈 값)은 "무툴"이 아니라 무시되는 경고 한 줄로
# 퇴화했다(내장 툴 이름이 fs_read → read 등으로 바뀌며 cwd 안 read 가 기본 신뢰됨). 무툴은
# `tools: []` 에이전트를 `--agent` 로 지정해야만 성립하고(v2 엔진; `--v3` 는 이를 무시함),
# 월간 요청 한도(MONTHLY_REQUEST_COUNT) 소진은 rc=0+빈 stdout 으로 끝나 재시도만 태우므로
# 시그니처 감지가 있어야 원인이 코멘트/로그에 드러난다. 둘 다 조용히 되돌려지는 걸 막는다.
PANEL="scripts/pr-review/run-panel.sh"
SYNTH="scripts/pr-review/synthesize.sh"
AGENT="scripts/pr-review/agents/pr-review-notools.json"

assert_bash_syntax "run-panel.sh valid bash" "$PANEL"
assert_bash_syntax "synthesize.sh valid bash" "$SYNTH"
assert_file_exists "kiro no-tools agent config present" "$AGENT"
assert_json_valid "kiro no-tools agent config is valid JSON" "$AGENT"

AGENT_NAME=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$AGENT" 2>/dev/null || true)
assert_eq "agent .name is pr-review-notools" "pr-review-notools" "$AGENT_NAME"

AGENT_TOOLS=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get("tools",["x"])), len(d.get("mcpServers",{"x":1})))' "$AGENT" 2>/dev/null || true)
assert_eq "agent declares tools: [] and no mcpServers" "0 0" "$AGENT_TOOLS"

PANEL_SRC=$(grep -v '^\s*#' "$PANEL")
assert_grep_match "run-panel.sh passes --agent \"\$KIRO_AGENT_NAME\" to kiro-cli chat" \
    'kiro-cli chat .*--agent "\$KIRO_AGENT_NAME"' "$(echo "$PANEL_SRC" | tr '\n' ' ')"
assert_grep_match "run-panel.sh copies the agent file into each cell cwd" \
    'cp "\$KIRO_AGENT_SRC" "\$CELL_CWD/\.kiro/agents/"' "$PANEL_SRC"
assert_grep_no_match "run-panel.sh no longer relies on --trust-tools= (ignored by kiro-cli 2.11.1)" \
    '\-{2}trust-tools' "$PANEL_SRC"
assert_grep_no_match "run-panel.sh does not use the --v3 engine (ignores tools: [])" \
    'kiro-cli -{2}v3|-{2}agent-engine' "$PANEL_SRC"

assert_grep_match "run-panel.sh detects the Kiro monthly quota signature (v2 stderr)" \
    'Monthly request limit reached' "$PANEL_SRC"
assert_grep_match "run-panel.sh detects the Kiro monthly quota signature (v3/JSON)" \
    'MONTHLY_REQUEST_COUNT' "$PANEL_SRC"
assert_grep_match "run-panel.sh writes kiro-quota.flag for synthesize.sh" \
    'kiro-quota\.flag' "$PANEL_SRC"
assert_grep_match "synthesize.sh renders the Kiro quota banner" \
    'kiro-quota\.flag' "$(grep -v '^\s*#' "$SYNTH")"

# 동작 테스트: kiro-cli 스텁이 2.11.1 v2 엔진의 한도 소진 시그니처(rc=0, 빈 stdout, stderr
# 메시지)를 재현하면 재시도 없이 즉시 중단하고 quota 플래그를 남겨야 한다.
if command -v timeout >/dev/null 2>&1; then
    T_STUB=$(mktemp -d)
    cat > "$T_STUB/kiro-cli" <<'EOF'
#!/bin/bash
printf 'Monthly request limit reached\nThe limits reset on 10/01.\n' >&2
exit 0
EOF
    cat > "$T_STUB/codex" <<'EOF'
#!/bin/bash
cat > /dev/null; echo "no findings"
EOF
    chmod +x "$T_STUB/kiro-cli" "$T_STUB/codex"
    mkdir -p "$T_STUB/lenses" && echo "lens" > "$T_STUB/lenses/L2.txt"
    printf 'diff --git a/x b/x\n+x\n' > "$T_STUB/diff.txt"
    PANEL_OUT=$(PATH="$T_STUB:$PATH" PANEL_TIMEOUT=30 PANEL_RETRIES=3 \
        bash "$PANEL" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" 2>&1 || true)
    assert_grep_no_match "quota exhaustion is not retried" '\[retry ' "$PANEL_OUT"
    assert_grep_match "quota exhaustion is reported as ::error:: with the reset date" \
        '::error::Kiro monthly request quota exhausted.*reset on 10/01' "$PANEL_OUT"
    assert_file_exists "quota exhaustion leaves kiro-quota.flag" "$T_STUB/work/kiro-quota.flag"
    assert_file_exists "quota exhaustion still forces coverage-severe (fail-closed kept)" "$T_STUB/work/coverage-severe.flag"
    rm -rf "$T_STUB"
else
    skip "run-panel.sh quota stub behaviour" "timeout(1) not available"
fi
