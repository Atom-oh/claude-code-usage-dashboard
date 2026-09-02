#!/bin/bash
# user-data.sh는 set -euxo pipefail로 돌아서, SSM 비밀번호 읽기 구간의 xtrace를 끄는 가드가
# 유일한 방어다. 가드가 사라지면 /var/log/cloud-init-output.log에 ClickHouse 비밀번호가
# 평문으로 남고, 그 로그는 콘솔 출력으로도 조회된다 — 조용히 되돌려지는 걸 막으려고 여기서 핀다.
assert_bash_syntax "user-data.sh valid bash" "user-data.sh"

UD_SSM_LINE=$(grep -n 'CH_PASSWORD="\$(aws ssm get-parameter' user-data.sh | head -1 | cut -d: -f1 || true)
# 패턴을 줄 전체에 고정한다 — 가드 위의 설명 주석이 같은 문자열을 백틱 안에 담고 있어서,
# 고정하지 않으면 주석 줄이 먼저 잡혀 가드를 지워도 이 검사가 통과한다(실측: 뮤테이션 생존).
UD_XTRACE_OFF=$(grep -n '^{ set +x; } 2>/dev/null$' user-data.sh | head -1 | cut -d: -f1 || true)
if [ -n "$UD_SSM_LINE" ] && [ -n "$UD_XTRACE_OFF" ] && [ "$UD_XTRACE_OFF" -lt "$UD_SSM_LINE" ]; then
    pass "user-data.sh: xtrace off before the SSM password read"
else
    fail "user-data.sh: xtrace off before the SSM password read" \
        "expected '{ set +x; } 2>/dev/null' above the CH_PASSWORD assignment (assignment line: ${UD_SSM_LINE:-none}, guard line: ${UD_XTRACE_OFF:-none})"
fi

UD_ENV_HEREDOC=$(grep -n 'cat > /etc/otelcol/env <<EOF' user-data.sh | head -1 | cut -d: -f1 || true)
UD_ENV_EOF=$(awk -v s="${UD_ENV_HEREDOC:-0}" 'NR>s && $0=="EOF" {print NR; exit}' user-data.sh || true)
UD_AFTER_EOF=$(awk -v s="${UD_ENV_EOF:-0}" 'NR==s+1 {print; exit}' user-data.sh || true)
if [ -n "$UD_ENV_HEREDOC" ] && [ "$UD_AFTER_EOF" = "set -x" ]; then
    pass "user-data.sh: xtrace back on right after the otelcol env heredoc"
else
    fail "user-data.sh: xtrace back on right after the otelcol env heredoc" \
        "expected 'set -x' on the line after the heredoc's closing EOF, found '${UD_AFTER_EOF:-none}'"
fi
