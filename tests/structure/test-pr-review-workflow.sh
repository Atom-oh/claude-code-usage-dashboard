#!/usr/bin/env bash
# Runs the workflow's own lens, panel, gate and comment step scripts against stub CLIs
# (no model or GitHub calls) and pins the comment contract that pr-autofix parses.

RW_WF=.github/workflows/pr-review.yml
RW_SHA=0123456789abcdef0123456789abcdef01234567
RW_WF_SRC="$(grep -v '^\s*#' "$RW_WF" || true)"
RW_WF_TEXT="$(cat "$RW_WF" 2>/dev/null || true)"

# Section A: static workflow contract
assert_grep_match "CI runs the required specialist path" 'ROLE_REVIEW: "1"' "$RW_WF_SRC"
assert_grep_match "runner label is unchanged" 'runs\-on: claude-code-usage-dashboard-claude-arm' "$RW_WF_SRC"
assert_grep_no_match "the diff is not read from the live PR" 'gh pr diff' "$RW_WF_SRC"
assert_grep_no_match "the diff is never truncated" 'head \-"\$MAX_LINES"|pr-diff-truncated' "$RW_WF_SRC"
assert_grep_no_match "no workflow-wide GitHub token" '^  GH_TOKEN:' "$RW_WF_TEXT"
assert_grep_match "specialist evidence upload only runs for ROLE_REVIEW=1" "env\\.ROLE_REVIEW == '1'" "$RW_WF_SRC"

RW_OUT="$(python3 - "$RW_WF" scripts/pr-review/role-input-scope.json 2>&1 <<'PY'
import json, sys
text = open(sys.argv[1], encoding="utf-8").read()
scope = json.load(open(sys.argv[2], encoding="utf-8"))
wanted = ["**/" + b for b in scope["basenames"]]
wanted += ["**/*" + e for e in scope["extensions"]]
wanted += ["**/" + d + "/**" for d in scope["directories"]]
wanted += [p + "**" for p in scope.get("prefixes", [])]
missing = [w for w in wanted if "':(glob,exclude)" + w + "'" not in text]
print("ok" if not missing else "missing: " + " ".join(missing))
PY
)" || true
assert_eq "workflow diff exclusions match role-input-scope.json" "ok" "$RW_OUT"

# Section B: executed workflow steps
if command -v timeout >/dev/null 2>&1; then
    RW_DIR="$(mktemp -d)"
    mkdir -p "$RW_DIR/bin"

    cat > "$RW_DIR/extract_step.py" <<'PY'
import sys

workflow, name, output, directory = sys.argv[1:5]
lines = open(workflow, encoding="utf-8").read().splitlines()
start = next(i for i, line in enumerate(lines) if line.strip() == "- name: " + name)
run = next(i for i in range(start + 1, len(lines)) if lines[i].strip() == "run: |")
indent = None
body = []
for line in lines[run + 1:]:
    if not line.strip():
        body.append("")
        continue
    width = len(line) - len(line.lstrip())
    if indent is None:
        indent = width
    if width < indent:
        break
    body.append(line[indent:])
text = "\n".join(body).rstrip() + "\n"
text = text.replace("${{ github.event.pull_request.head.sha }}", "${HEAD_SHA}")
text = text.replace("/tmp/", directory + "/")
if "${{" in text:
    sys.exit("unsubstituted workflow expression in step: " + name)
open(output, "w", encoding="utf-8").write(text)
PY

    cat > "$RW_DIR/bin/gh" <<'EOF'
#!/bin/bash
if [ "$1" = api ] && [[ "$2" == repos/*/pulls/* ]]; then printf '%s\n' "${RW_CURRENT_HEAD:-}"; exit 0; fi
if [ "$1" = api ] && [[ "$2" == repos/*/issues/*/comments ]]; then exit 0; fi
if [ "$1" = pr ] && [ "$2" = comment ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --body-file ]; then cp "$2" "$0.posted"; exit 0; fi
    shift
  done
fi
echo "unexpected gh call: $*" >&2
exit 2
EOF

    cat > "$RW_DIR/bin/codex" <<'EOF'
#!/bin/bash
rw_out=""; rw_prev=""
for rw_a in "$@"; do [ "$rw_prev" = "-o" ] && rw_out="$rw_a"; rw_prev="$rw_a"; done
cat >/dev/null; if [ -f "$0.fail-L3" ]; then case "$*" in *"LENS: L3"*) exit 1 ;; esac; fi
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"no findings"}}' '{"type":"turn.completed"}'
echo "no findings" > "$rw_out"
EOF

    cat > "$RW_DIR/bin/claude" <<'EOF'
#!/bin/bash
cat >/dev/null; if [ -f "$0.fail" ]; then echo "MAJOR: rw finding"; echo "VERDICT: FAIL"; else echo "Looks fine."; echo "VERDICT: PASS"; fi
EOF
    chmod +x "$RW_DIR/bin/gh" "$RW_DIR/bin/codex" "$RW_DIR/bin/claude"

    rw_case() {
        RW_CASE="$RW_DIR/$1"
        mkdir -p "$RW_CASE/pr-review/lenses"
        local rw_l
        for rw_l in L2 L3 L4 L5; do
            echo "LENS: $rw_l" > "$RW_CASE/pr-review/lenses/$rw_l.txt"
        done
        printf 'diff --git a/x b/x\n+RW_DIFF_MARKER\n' > "$RW_CASE/pr-diff.txt"
        : > "$RW_CASE/pr-changed-paths.txt"
        : > "$RW_CASE/github-env"
        python3 "$RW_DIR/extract_step.py" "$RW_WF" "Build lens prompts (L2-L5, one self-contained lens each)" "$RW_CASE/lens.sh" "$RW_CASE" || true
        python3 "$RW_DIR/extract_step.py" "$RW_WF" "Run Codex lens panel and Claude chair" "$RW_CASE/panel.sh" "$RW_CASE" || true
        python3 "$RW_DIR/extract_step.py" "$RW_WF" "Check for blocking issues" "$RW_CASE/gate.sh" "$RW_CASE" || true
        python3 "$RW_DIR/extract_step.py" "$RW_WF" "Post review comment (upsert)" "$RW_CASE/post.sh" "$RW_CASE" || true
    }

    rw_panel() {
        env -u BASE_SHA PATH="$RW_DIR/bin:$PATH" GITHUB_ENV="$RW_CASE/github-env" ROLE_REVIEW=0 PR_NUMBER=42 PR_TITLE="rw title" PANEL_TIMEOUT=30 PANEL_RETRIES=1 CHAIR_TIMEOUT=30 GH_TOKEN= bash "$RW_CASE/panel.sh" > "$RW_CASE/panel.out" 2>&1 || true
    }

    rw_publish() {
        local rw_head="${1:-$RW_SHA}" rw_gate
        rm -f "$RW_DIR/bin/gh.posted"
        GITHUB_OUTPUT="$RW_CASE/gh-output" bash "$RW_CASE/gate.sh" >/dev/null 2>&1 || true
        rw_gate="$(sed -n 's/^result=//p' "$RW_CASE/gh-output" 2>/dev/null | tail -n 1 || true)"
        RW_POST_RC=0
        RW_POST_OUT="$(
            while IFS= read -r rw_line; do
                [ -z "$rw_line" ] || export "$rw_line"
            done < "$RW_CASE/github-env"
            export GATE_RESULT="$rw_gate" HEAD_SHA="$RW_SHA" RW_CURRENT_HEAD="$rw_head" PR_NUMBER=42 REPO=example/repo
            PATH="$RW_DIR/bin:$PATH" bash "$RW_CASE/post.sh" 2>&1
        )" || RW_POST_RC=$?
        RW_BODY="$(cat "$RW_DIR/bin/gh.posted" 2>/dev/null || true)"
    }

    rw_line() { sed -n "${1}p" "$RW_DIR/bin/gh.posted" 2>/dev/null || true; }
    rw_last() { tail -n 1 "$RW_DIR/bin/gh.posted" 2>/dev/null || true; }
    rw_count_lenses() { find "$RW_CASE/pr-review/lenses" -maxdepth 1 -name '*.txt' | wc -l | tr -d ' '; }

    # B1 complete coverage and a chair PASS
    rw_case pass; rw_panel; rw_publish
    assert_eq "comment line 1 is the review marker" "<!-- multi-ai-pr-review -->" "$(rw_line 1)"
    assert_eq "comment title names the specialists" "## AI Code Review — Specialists" "$(rw_line 2)"
    assert_eq "comment header names responding reviewers and summary" "_Specialists responded: codex/L2 codex/L3 codex/L4 codex/L5 · Summary: Claude Opus 5.5_" "$(rw_line 3)"
    if grep -qxF '**Status: PASSED** — No blocking issues found' <<< "$RW_BODY"; then
        pass "PASSED badge is unchanged"
    else
        fail "PASSED badge is unchanged" "badge line not found"
    fi
    assert_eq "footer binds the triggering commit" "_Triggered by commit \`$RW_SHA\` · workflow: \`.github/workflows/pr-review.yml\`_" "$(rw_last)"
    assert_grep_no_match "the final VERDICT line is not published" '^VERDICT:' "$RW_BODY"
    assert_grep_match "the chair review is published" '^Looks fine\.$' "$RW_BODY"

    # B2 a missing lens blocks as an execution failure
    rw_case missing
    touch "$RW_DIR/bin/codex.fail-L3"
    rw_panel; rw_publish
    rm -f "$RW_DIR/bin/codex.fail-L3"
    if grep -qxF '**Status: BLOCKED** — required review execution or coverage failed' <<< "$RW_BODY"; then
        pass "coverage failure uses the execution-failure badge"
    else
        fail "coverage failure uses the execution-failure badge" "badge line not found"
    fi
    assert_grep_match "coverage failure is explained in the comment" '^\*\*Required coverage failed\*\*' "$RW_BODY"

    # B3 a chair FAIL blocks as findings
    rw_case findings
    touch "$RW_DIR/bin/claude.fail"
    rw_panel; rw_publish
    rm -f "$RW_DIR/bin/claude.fail"
    if grep -qxF '**Status: BLOCKED** — CRITICAL/MAJOR issues must be resolved before merge' <<< "$RW_BODY"; then
        pass "chair findings use the CRITICAL/MAJOR badge"
    else
        fail "chair findings use the CRITICAL/MAJOR badge" "badge line not found"
    fi

    # B4 a changed head is refused
    rw_case stale; rw_panel; rw_publish fedcba9876543210fedcba9876543210fedcba98
    assert_eq "a changed PR head stops publication" "1" "$RW_POST_RC"
    assert_grep_match "the refusal is explained" '::error::PR head changed' "$RW_POST_OUT"
    if [ ! -e "$RW_DIR/bin/gh.posted" ]; then
        pass "nothing is posted for an older commit"
    else
        fail "nothing is posted for an older commit" "gh.posted exists"
    fi

    RW_BASE="$(git rev-parse HEAD 2>/dev/null || true)"

    # B5 oversize by lines
    rw_case lines
    rm -f "$RW_CASE"/pr-review/lenses/*.txt
    total_lines=12001 total_bytes=10 BASE_SHA="$RW_BASE" GITHUB_ENV="$RW_CASE/github-env" bash "$RW_CASE/lens.sh" >/dev/null 2>&1 || true
    assert_eq "an oversized diff is blocked, not truncated" "## Review blocked" "$(head -n 1 "$RW_CASE/review.md" 2>/dev/null || true)"
    RW_REVIEW="$(cat "$RW_CASE/review.md" 2>/dev/null || true)"
    RW_GENV="$(cat "$RW_CASE/github-env" 2>/dev/null || true)"
    assert_grep_match "the block states the limits" 'over the 12000\-line / 512000\-byte review limit' "$RW_REVIEW"
    assert_grep_match "oversize marks an execution failure" '^chair_failed=1$' "$RW_GENV"
    assert_grep_match "oversize skips the panel" '^diff_oversize=1$' "$RW_GENV"
    assert_eq "no lens prompts are built for an oversized diff" "0" "$(rw_count_lenses)"
    rw_publish
    if grep -qxF '**Status: BLOCKED** — required review execution or coverage failed' <<< "$RW_BODY"; then
        pass "oversize uses the execution-failure badge"
    else
        fail "oversize uses the execution-failure badge" "badge line not found"
    fi

    # B6 oversize by bytes
    rw_case bytes
    rm -f "$RW_CASE"/pr-review/lenses/*.txt
    total_lines=10 total_bytes=512001 BASE_SHA="$RW_BASE" GITHUB_ENV="$RW_CASE/github-env" bash "$RW_CASE/lens.sh" >/dev/null 2>&1 || true
    assert_eq "a diff over the byte limit is blocked" "## Review blocked" "$(head -n 1 "$RW_CASE/review.md" 2>/dev/null || true)"

    # B7 a diff at the limits is reviewed
    rw_case limits
    rm -f "$RW_CASE"/pr-review/lenses/*.txt
    total_lines=12000 total_bytes=512000 BASE_SHA="$RW_BASE" GITHUB_ENV="$RW_CASE/github-env" bash "$RW_CASE/lens.sh" >/dev/null 2>&1 || true
    if [ ! -e "$RW_CASE/review.md" ]; then
        pass "a diff at the limits is not blocked"
    else
        fail "a diff at the limits is not blocked" "review.md exists"
    fi
    assert_eq "four lens prompts are built from the base snapshot" "4" "$(rw_count_lenses)"

    rm -rf "$RW_DIR"
else
    skip "pr-review workflow step behaviour" "timeout(1) not available"
fi
