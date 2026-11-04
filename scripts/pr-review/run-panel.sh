#!/usr/bin/env bash
# Lens panel: one Codex review per lens, all lenses in parallel. PR input is untrusted data.
# Usage: run-panel.sh <diff> <lenses_dir> <workdir>
# Each *.txt in lenses_dir is one self-contained lens prompt from build-prompts.py (file
# stem = lens tag, L2..L5). Codex (PANEL_MODEL) reviews each lens with the diff on stdin;
# synthesize.sh then has the Claude chair review the same diff and adjudicate. Every cell
# runs tool-less in its own empty HOME/cwd under $WORK with a timeout and up to
# PANEL_RETRIES attempts. A lens Codex did not complete, or a cell that ran a tool, fails closed.
set -uo pipefail

# ROLE_REVIEW=1 selects the retained specialist protocol.
if [ "${ROLE_REVIEW:-0}" = 1 ]; then
  exec bash "$(dirname "$0")/run-specialists.sh" "$@"
fi
DIFF="$(realpath "$1" 2>/dev/null)" \
  || { echo "run-panel.sh: realpath failed to resolve diff path: $1" >&2; exit 1; }
LENSES_DIR="$2"; WORK="$3"
[ -n "$LENSES_DIR" ] || { echo "run-panel.sh: lenses_dir (\$2) must not be empty" >&2; exit 1; }
[ -n "$WORK" ] || { echo "run-panel.sh: workdir (\$3) must not be empty" >&2; exit 1; }
# Check for a symlink before realpath resolves it away.
[ -L "$WORK" ] && { echo "run-panel.sh: workdir ($WORK) is a symlink, refusing" >&2; exit 1; }
mkdir -p "$WORK" || { echo "run-panel.sh: failed to create workdir: $WORK" >&2; exit 1; }
WORK="$(realpath "$WORK")" \
  || { echo "run-panel.sh: realpath failed to resolve workdir: $WORK" >&2; exit 1; }
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/lib.sh"
ensure_slots "$WORK" || exit 1
SLOT="$WORK/slot"; RESP="$WORK/responded.txt"; : > "$RESP"
# A reused workdir must not carry over the previous run's flags or banners.
rm -f "$WORK"/*.flag; : > "$WORK/degraded-models.txt"
T="${PANEL_TIMEOUT:-300}"
RETRIES="${PANEL_RETRIES:-2}"
PANEL_MODEL="${PANEL_MODEL:-global.openai.gpt-6.1-sol}"
PANEL_PROVIDER="${PANEL_PROVIDER:-amazon-bedrock-runtime}"
PANEL_REASONING_EFFORT="${PANEL_REASONING_EFFORT:-xhigh}"
for v in "$PANEL_MODEL" "$PANEL_PROVIDER" "$PANEL_REASONING_EFFORT"; do
  [[ "$v" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "run-panel.sh: invalid panel model/provider/effort: $v" >&2; exit 1; }
done
REQUIRED_LENSES=(L2 L3 L4 L5)
CELLS="$WORK/cells"
[ -L "$CELLS" ] && { echo "run-panel.sh: $CELLS is a symlink, refusing" >&2; exit 1; }
rm -rf "$CELLS"; mkdir -p "$CELLS" || exit 1

shopt -s nullglob
LENS_FILES=("$LENSES_DIR"/*.txt)
shopt -u nullglob
if [ "${#LENS_FILES[@]}" -eq 0 ]; then
  echo "run-panel.sh: no *.txt lens files found in $LENSES_DIR" >&2
  exit 1
fi

# Each attempt gets a fresh cell: empty HOME, CODEX_HOME, cwd and TMPDIR under $WORK, and a
# generated config with no user config, auth, plugins, skills, hooks or MCP servers. Shell,
# exec, image, browser and agent tools are disabled, so the model has no file, environment
# or network access; the environment is review_env's allowlist (lib.sh).
write_codex_config() {  # $1 = CODEX_HOME
  cat > "$1/config.toml" <<EOF
model_provider = "$PANEL_PROVIDER"
model_reasoning_effort = "$PANEL_REASONING_EFFORT"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"

[features]
shell_tool = false
unified_exec = false
shell_snapshot = false
view_image = false
apps = false
plugins = false
remote_plugin = false
multi_agent = false
hooks = false
browser_use = false
browser_use_external = false
computer_use = false
in_app_browser = false
code_mode_host = false
image_generation = false
skill_search = false
tool_suggest = false
memories = false
workspace_dependencies = false
EOF
}

# Tool-use tripwire over `codex exec --json` events. Exit 0: completed turn with only
# message/reasoning/plan/error items; 2: any other item (a tool ran; discard, never retry);
# 3: malformed, failed or incomplete stream (retryable).
codex_events_check() {
  python3 -I - "$1" <<'PY'
import json, sys
completed = False
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    if not line.strip():
        continue
    try:
        event = json.loads(line)
    except ValueError:
        sys.exit(3)
    if not isinstance(event, dict):
        sys.exit(3)
    item = event.get("item")
    if item is not None and (not isinstance(item, dict)
                             or item.get("type") not in ("agent_message", "reasoning", "todo_list", "error")):
        sys.exit(2)
    if event.get("type") in ("turn.failed", "error"):
        sys.exit(3)
    completed = completed or event.get("type") == "turn.completed"
sys.exit(0 if completed else 3)
PY
}

# Run one lens up to $RETRIES times; a nonzero exit, incomplete stream or empty final
# message is retried. Only the final message (-o) becomes the cell output.
try_panel() {  # try_panel <lens> <prompt>   (stdin=$DIFF)
  local lens="$1" prompt="$2"
  local slot="$SLOT/codex-$lens.md" err="$SLOT/codex-$lens.err" cell="$CELLS/codex-$lens"
  local a rc=1 check
  for a in $(seq 1 "$RETRIES"); do
    : > "$slot"
    { fresh_review_dir "$cell" && mkdir "$cell/home/.codex" && write_codex_config "$cell/home/.codex"; } \
      || { echo "cell setup failed" > "$err"; rc=1; break; }
    ( cd "$cell/cwd" && review_env "$cell/home" "$cell/tmp" CODEX_HOME="$cell/home/.codex" -- \
        timeout "$T" codex -c web_search=disabled exec --model "$PANEL_MODEL" -s read-only \
          --skip-git-repo-check --ephemeral --ignore-rules --color never --json \
          -o "$cell/last-message.md" "$prompt" ) > "$cell/events.jsonl" 2>"$err" < "$DIFF"; rc=$?
    # Check the events whatever the exit code, so a tool call is never repeated by a retry.
    codex_events_check "$cell/events.jsonl"; check=$?
    if [ "$check" -eq 2 ]; then
      rc=1; : > "$SLOT/codex-$lens.tooluse"
      echo "[tool-use] codex-$lens ran a tool; response discarded, not retried" >&2
      break
    fi
    if [ "$rc" -eq 0 ]; then
      [ "$check" -eq 0 ] && [ -s "$cell/last-message.md" ] && cp "$cell/last-message.md" "$slot" && break
      rc=1
    fi
    [ "$a" -lt "$RETRIES" ] && echo "[retry $a/$RETRIES] codex-$lens" >&2
  done
  echo "$rc" > "$slot.rc"
}

if ! command -v codex >/dev/null 2>&1; then
  echo "::error::codex CLI not found on runner — no panel coverage" >&2
fi
for lens_file in "${LENS_FILES[@]}"; do
  lens="$(basename "$lens_file" .txt)"
  LENS_PROMPT="$(cat "$lens_file")"
  if command -v codex >/dev/null 2>&1; then
    ( try_panel "$lens" "$LENS_PROMPT" ) &
  else
    echo "codex CLI not found on runner" > "$SLOT/codex-$lens.err"
    : > "$SLOT/codex-$lens.md"
  fi
done
wait

for lens_file in "${LENS_FILES[@]}"; do
  lens="$(basename "$lens_file" .txt)"
  record_result "$SLOT/codex-$lens.md" "codex/$lens" "$RESP"
done
RESPONDED="$(wc -l < "$RESP" 2>/dev/null | tr -d ' ')"
echo "Panel responded (${RESPONDED:-0} / ${#LENS_FILES[@]} cells, $PANEL_MODEL): $(tr '\n' ' ' < "$RESP")"
[ -n "${GITHUB_ENV:-}" ] && echo "panel_model=$PANEL_MODEL" >> "$GITHUB_ENV"

# Codex is the only panel vendor: every lens prompt and every required lens must have a
# successful cell. A missing lens has no review left and forces VERDICT: FAIL in
# synthesize.sh, whatever the chair decides.
MISSING=()
for lens in "${REQUIRED_LENSES[@]}"; do
  grep -qx "codex/$lens" "$RESP" || MISSING+=("$lens")
done
if [ "${RESPONDED:-0}" -lt "${#LENS_FILES[@]}" ] || [ "${#MISSING[@]}" -gt 0 ]; then
  echo "codex" >> "$WORK/degraded-models.txt"
  echo "::error::codex did not complete every lens (missing: ${MISSING[*]:-see skipped cells}) — forcing VERDICT: FAIL" >&2
  : > "$WORK/coverage-severe.flag"
fi
shopt -s nullglob
TOOLUSE=("$SLOT"/*.tooluse)
shopt -u nullglob
if [ "${#TOOLUSE[@]}" -gt 0 ]; then
  TOOLUSE_CELLS="$(for f in "${TOOLUSE[@]}"; do basename "$f" .tooluse; done | tr '\n' ' ' | sed 's/ *$//')"
  echo "::error::codex ran a tool in [$TOOLUSE_CELLS] although tools are disabled — responses discarded, forcing VERDICT: FAIL" >&2
  : > "$WORK/coverage-severe.flag"
fi

# Surface why a cell was skipped. Actions logs are public, so stderr passes the same
# scrub_secrets() as the cell output.
for e in "$SLOT"/*.err; do
  [ -s "$e" ] || continue
  b="$(basename "$e" .err)"
  [ -s "$SLOT/$b.md" ] && continue
  echo "--- [$b] skipped; stderr (last 25 lines, scrubbed) ---" >&2
  tail -25 "$e" | scrub_secrets >&2
done
# Coverage is reported through the flag files above, not the exit status.
exit 0
