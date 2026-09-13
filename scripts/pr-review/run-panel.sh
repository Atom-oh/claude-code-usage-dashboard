#!/usr/bin/env bash
# Review matrix: one independent cell per model and lens. PR input is untrusted data.
# Keep absolute work paths, isolated Kiro environments, preflight, and visible failures.
set -uo pipefail
DIFF="$(realpath "$1" 2>/dev/null)" \
  || { echo "run-panel.sh: realpath failed to resolve diff path: $1" >&2; exit 1; }
LENSES_DIR="$2"; WORK="$3"
[ -n "$LENSES_DIR" ] || { echo "run-panel.sh: lenses_dir (\$2) must not be empty" >&2; exit 1; }
[ -n "$WORK" ] || { echo "run-panel.sh: workdir (\$3) must not be empty" >&2; exit 1; }
mkdir -p "$WORK" || { echo "run-panel.sh: failed to create workdir: $WORK" >&2; exit 1; }
WORK="$(realpath "$WORK")" \
  || { echo "run-panel.sh: realpath failed to resolve workdir: $WORK" >&2; exit 1; }
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/lib.sh"
ensure_slots "$WORK" || exit 1
SLOT="$WORK/slot"; RESP="$WORK/responded.txt"; : > "$RESP"
rm -f "$WORK/coverage-severe.flag" "$WORK/kiro-diff-truncated.flag" "$WORK/kiro-quota.flag" "$WORK/kiro-agent-fallback.flag" "$WORK/kiro-preflight.flag"
T="${PANEL_TIMEOUT:-300}"
RETRIES="${PANEL_RETRIES:-3}"
KIRO_MODELS=("claude-opus-5:kiro-opus" "gpt-5.6-terra:kiro-gpt")
command -v kiro-cli >/dev/null 2>&1 && echo "run-panel.sh: $(kiro-cli --version 2>/dev/null | head -1)" >&2

shopt -s nullglob
LENS_FILES=("$LENSES_DIR"/*.txt)
shopt -u nullglob
if [ "${#LENS_FILES[@]}" -eq 0 ]; then
  echo "run-panel.sh: no *.txt lens files found in $LENSES_DIR" >&2
  exit 1
fi

KIRO_QUOTA_RE='Monthly request limit reached|MONTHLY_REQUEST_COUNT|UsageLimitReachedError'

KIRO_AGENT_FALLBACK_RE='no agent with name|Falling back to user specified default|Json supplied at .* is invalid'

#   try_panel <provider> <slot> <err> <cmd...>   (stdin=$DIFF, stdout=slot, stderr=err)
# Kiro stderr classification is provider-scoped; Codex may echo the diff.
try_panel() {
  local provider="$1" slot="$2" err="$3"; shift 3
  local a rc=1
  for a in $(seq 1 "$RETRIES"); do
    "$@" > "$slot" 2>"$err" < "$DIFF"; rc=$?
    if [ "$provider" = kiro ] && grep -qE "$KIRO_AGENT_FALLBACK_RE" "$err" 2>/dev/null; then
      grep -E "$KIRO_AGENT_FALLBACK_RE" "$err" | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | head -2 > "$slot.agentfail"
      : > "$slot"; rc=1
      echo "[agent-fallback] $(basename "$slot" .md) — kiro-cli ignored --agent, no-tools contract broken; discarding response" >&2
      break
    fi
    [ -s "$slot" ] && [ "$rc" -eq 0 ] && break
    if [ "$provider" = kiro ] && grep -qE "$KIRO_QUOTA_RE" "$err" 2>/dev/null; then
      grep -E "$KIRO_QUOTA_RE|limits reset on" "$err" \
        | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | head -3 > "$slot.quota"
      : > "$slot"; rc=1
      echo "[quota] $(basename "$slot" .md) — monthly request limit reached, not retrying" >&2
      break
    fi
    [ "$a" -lt "$RETRIES" ] && echo "[retry $a/$RETRIES] $(basename "$slot" .md)" >&2
  done
  echo "$rc" > "$slot.rc"
}

#
# Agent configuration and behavioral preflight precede all Kiro PR input.
KIRO_CWD_BASE="$WORK/kiro-cwd"
[ -L "$KIRO_CWD_BASE" ] && { echo "run-panel.sh: \$KIRO_CWD_BASE is a symlink, refusing (TOCTOU guard)" >&2; exit 1; }
rm -rf "$KIRO_CWD_BASE"; mkdir -p "$KIRO_CWD_BASE"
KIRO_AGENT_NAME="pr-review-notools"
KIRO_AGENT_SRC="$DIR/agents/$KIRO_AGENT_NAME.json"
[ -f "$KIRO_AGENT_SRC" ] || { echo "run-panel.sh: kiro agent config missing: $KIRO_AGENT_SRC" >&2; exit 1; }
if ! python3 - "$KIRO_AGENT_SRC" "$KIRO_AGENT_NAME" <<'PY'
import json, sys
def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate key")
        obj[key] = value
    return obj
try:
    with open(sys.argv[1]) as source:
        agent = json.load(source, object_pairs_hook=unique_object)
    valid = (agent["name"] == sys.argv[2] and agent["tools"] == []
             and agent["allowedTools"] == [] and agent["mcpServers"] == {}
             and agent["resources"] == [] and agent["useLegacyMcpJson"] is False)
    if not valid:
        raise ValueError("tool configuration")
except (OSError, ValueError, KeyError, TypeError):
    sys.exit(1)
PY
then
  echo "run-panel.sh: invalid no-tools agent configuration: $KIRO_AGENT_SRC" >&2
  exit 1
fi
prepare_kiro_agent() {
  local CELL_CWD="$1"
  mkdir -p "$CELL_CWD/.kiro/agents" && cp "$KIRO_AGENT_SRC" "$CELL_CWD/.kiro/agents/"
}
kiro_env() {
  local cell_cwd="$1"; shift
  env -i PATH="$PATH" HOME="$cell_cwd" LANG="${LANG:-}" LC_ALL="${LC_ALL:-}" TMPDIR="${TMPDIR:-/tmp}" \
    ${KIRO_API_KEY:+KIRO_API_KEY="$KIRO_API_KEY"} "$@"
}

KIRO_PREFLIGHT_OK=0
KIRO_PREFLIGHT_PASSED=0
KIRO_PREFLIGHT_TIMEOUT="${KIRO_PREFLIGHT_TIMEOUT:-60}"
KIRO_PREFLIGHT_PROMPT="Kiro startup safety check. Read ./preflight-canary.txt using a file-reading tool and return its exact contents. If no file-reading tools are available, reply with exactly NO_TOOLS. Do not run any other tools."
if command -v kiro-cli >/dev/null 2>&1; then
  for entry in "${KIRO_MODELS[@]}"; do
    m="${entry%%:*}"; tag="${entry##*:}"
    PREFLIGHT_CWD="$KIRO_CWD_BASE/preflight/$tag"
    prepare_kiro_agent "$PREFLIGHT_CWD" \
      || { echo "run-panel.sh: failed to prepare Kiro preflight agent" >&2; exit 1; }
    python3 -c 'import secrets; print(secrets.token_hex(24))' > "$PREFLIGHT_CWD/preflight-canary.txt" \
      || { echo "run-panel.sh: failed to create Kiro preflight canary" >&2; exit 1; }
    PREFLIGHT_OUT="$PREFLIGHT_CWD/response.txt"; PREFLIGHT_ERR="$PREFLIGHT_CWD/stderr.txt"
    ( cd "$PREFLIGHT_CWD" && kiro_env "$PREFLIGHT_CWD" timeout "$KIRO_PREFLIGHT_TIMEOUT" \
        kiro-cli chat "$KIRO_PREFLIGHT_PROMPT" --model "$m" --agent "$KIRO_AGENT_NAME" \
        --no-interactive --wrap never ) > "$PREFLIGHT_OUT" 2> "$PREFLIGHT_ERR" < /dev/null
    PREFLIGHT_RC=$?
    if [ "$PREFLIGHT_RC" -eq 0 ] && python3 - "$PREFLIGHT_OUT" "$PREFLIGHT_ERR" \
        "$KIRO_AGENT_FALLBACK_RE" "$KIRO_QUOTA_RE" <<'PY'
import pathlib, re, sys
ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
out, err = [ansi.sub("", pathlib.Path(p).read_text(errors="replace")) for p in sys.argv[1:3]]
reply = re.sub(r"(?m)^\s*> ?", "", out).strip()
blocked = re.search(sys.argv[3] + "|" + sys.argv[4] + "|using tool:", err, re.I)
sys.exit(0 if reply == "NO_TOOLS" and not blocked else 1)
PY
    then
      KIRO_PREFLIGHT_PASSED=$((KIRO_PREFLIGHT_PASSED + 1))
      echo "Kiro preflight passed: $tag (no PR input)" >&2
      continue
    fi
    KIRO_PREFLIGHT_OK=0
    printf '%s\n' "$tag startup check failed (exit $PREFLIGHT_RC); PR input withheld from all Kiro cells." > "$WORK/kiro-preflight.flag"
    : > "$WORK/coverage-severe.flag"
    if grep -qE "$KIRO_QUOTA_RE" "$PREFLIGHT_ERR"; then
      grep -E "$KIRO_QUOTA_RE|limits reset on" "$PREFLIGHT_ERR" | scrub_secrets > "$WORK/kiro-quota.flag"
    fi
    if grep -qE "$KIRO_AGENT_FALLBACK_RE" "$PREFLIGHT_ERR"; then
      grep -E "$KIRO_AGENT_FALLBACK_RE" "$PREFLIGHT_ERR" | scrub_secrets > "$WORK/kiro-agent-fallback.flag"
    fi
    echo "::error::Kiro preflight failed for $tag; no PR input sent to Kiro (see docs/runbooks/pr-review-panel.md)" >&2
    tail -25 "$PREFLIGHT_ERR" | scrub_secrets >&2
    break
  done
  if [ "$KIRO_PREFLIGHT_PASSED" -eq "${#KIRO_MODELS[@]}" ]; then
    KIRO_PREFLIGHT_OK=1
  fi
fi

# Bound the inline diff; the workflow also bounds lens context.
KIRO_DIFF_CAP="${KIRO_DIFF_CAP:-100000}"
KIRO_DIFF_TEXT="$(head -c "$KIRO_DIFF_CAP" "$DIFF")"
if [ "$(wc -c < "$DIFF")" -gt "$KIRO_DIFF_CAP" ]; then
  KIRO_DIFF_TEXT+=$'\n[...TRUNCATED at '"$KIRO_DIFF_CAP"'B — full diff not sent to Kiro...]'
  echo "::warning::diff exceeds KIRO_DIFF_CAP (${KIRO_DIFF_CAP}B) — Kiro cells only see a truncated prefix" >&2
  : > "$WORK/kiro-diff-truncated.flag"
fi

for lens_file in "${LENS_FILES[@]}"; do
  lens="$(basename "$lens_file" .txt)"
  LENS_PROMPT="$(cat "$lens_file")"

  if command -v codex >/dev/null 2>&1; then
    ( try_panel codex "$SLOT/codex-$lens.md" "$SLOT/codex-$lens.err" \
        timeout "$T" codex exec -s read-only --skip-git-repo-check "$LENS_PROMPT" ) &
  else echo "[skip] codex/$lens (binary absent)" >&2; : > "$SLOT/codex-$lens.md"; fi

  KIRO_INSTRUCTION="$LENS_PROMPT"$'\n\n'"Review the changes below using the trusted base context above. Do not attempt file access:"$'\n\n'"$KIRO_DIFF_TEXT"
  for entry in "${KIRO_MODELS[@]}"; do
    m="${entry%%:*}"; tag="${entry##*:}"
    if [ "$KIRO_PREFLIGHT_OK" = 1 ] && command -v kiro-cli >/dev/null 2>&1; then
      CELL_CWD="$KIRO_CWD_BASE/$tag-$lens"
      prepare_kiro_agent "$CELL_CWD" \
        || { echo "run-panel.sh: failed to prepare Kiro review agent" >&2; exit 1; }
      ( cd "$CELL_CWD" && try_panel kiro "$SLOT/$tag-$lens.md" "$SLOT/$tag-$lens.err" \
          kiro_env "$CELL_CWD" timeout "$T" kiro-cli chat "$KIRO_INSTRUCTION" --model "$m" \
          --agent "$KIRO_AGENT_NAME" --no-interactive --wrap never ) &
    else echo "[skip] $tag/$lens (binary absent or preflight failed)" >&2; : > "$SLOT/$tag-$lens.md"; fi
  done
done

wait

for lens_file in "${LENS_FILES[@]}"; do
  lens="$(basename "$lens_file" .txt)"
  record_result "$SLOT/codex-$lens.md" "codex/$lens" "$RESP"
  for entry in "${KIRO_MODELS[@]}"; do
    tag="${entry##*:}"; record_result "$SLOT/$tag-$lens.md" "$tag/$lens" "$RESP"
  done
done
echo "Panel responded ($(wc -l < "$RESP") / $(( (${#KIRO_MODELS[@]} + 1) * ${#LENS_FILES[@]} )) cells): $(tr '\n' ' ' < "$RESP")"

: > "$WORK/degraded-models.txt"
for model_tag in codex "${KIRO_MODELS[@]##*:}"; do
  row_count="$(grep -c "^${model_tag}/" "$RESP" 2>/dev/null)"
  if [ "${row_count:-0}" -eq 0 ]; then
    echo "::warning::model '$model_tag' produced zero responses across all ${#LENS_FILES[@]} lenses — coverage degraded" >&2
    echo "$model_tag" >> "$WORK/degraded-models.txt"
  fi
done

# Preserve the vendor-wide coverage floor; it is not per-lens completeness.
CODEX_DEAD=0
grep -qx "codex" "$WORK/degraded-models.txt" 2>/dev/null && CODEX_DEAD=1
KIRO_TOTAL=${#KIRO_MODELS[@]}
KIRO_DEGRADED_COUNT="$(grep -c "^kiro-" "$WORK/degraded-models.txt" 2>/dev/null)"
KIRO_ALL_DEAD=0
[ "$KIRO_TOTAL" -gt 0 ] && [ "${KIRO_DEGRADED_COUNT:-0}" -ge "$KIRO_TOTAL" ] && KIRO_ALL_DEAD=1
if [ "$CODEX_DEAD" = 1 ] || [ "$KIRO_ALL_DEAD" = 1 ]; then
  echo "::error::coverage collapsed to ≤1 vendor (codex dead=$CODEX_DEAD, kiro fully dead=$KIRO_ALL_DEAD) — forcing VERDICT: FAIL, no cross-vendor check remains for any lens" >&2
  : > "$WORK/coverage-severe.flag"
fi

shopt -s nullglob
AGENTFAIL_MARKERS=("$SLOT"/*.agentfail)
shopt -u nullglob
if [ "${#AGENTFAIL_MARKERS[@]}" -gt 0 ]; then
  AGENTFAIL_DETAIL="$(cat "${AGENTFAIL_MARKERS[@]}" | scrub_secrets | grep -v '^\s*$' | sort -u | tr '\n' ' ' | sed 's/ *$//')"
  AGENTFAIL_CELLS="$(for q in "${AGENTFAIL_MARKERS[@]}"; do basename "$q" .md.agentfail; done | tr '\n' ' ' | sed 's/ *$//')"
  echo "::error::kiro-cli ignored --agent $KIRO_AGENT_NAME (fell back to the default agent WITH tools) in ${#AGENTFAIL_MARKERS[@]} cell(s) [$AGENTFAIL_CELLS]: $AGENTFAIL_DETAIL — responses discarded, forcing VERDICT: FAIL (no-tools contract)" >&2
  printf '%s\n' "$AGENTFAIL_DETAIL" > "$WORK/kiro-agent-fallback.flag"
  : > "$WORK/coverage-severe.flag"
  rm -f "${AGENTFAIL_MARKERS[@]}"
fi

shopt -s nullglob
QUOTA_MARKERS=("$SLOT"/*.quota)
shopt -u nullglob
if [ "${#QUOTA_MARKERS[@]}" -gt 0 ]; then
  QUOTA_DETAIL="$(cat "${QUOTA_MARKERS[@]}" | scrub_secrets | grep -v '^\s*$' | sort -u | tr '\n' ' ' | sed 's/ *$//')"
  QUOTA_CELLS="$(for q in "${QUOTA_MARKERS[@]}"; do basename "$q" .md.quota; done | tr '\n' ' ' | sed 's/ *$//')"
  echo "::error::Kiro monthly-limit response for KIRO_API_KEY — ${#QUOTA_MARKERS[@]} cell(s) [$QUOTA_CELLS]: $QUOTA_DETAIL — inspect authentication/profile/usage before retrying; see docs/runbooks/pr-review-panel.md" >&2
  printf '%s\n' "$QUOTA_DETAIL" > "$WORK/kiro-quota.flag"
  rm -f "${QUOTA_MARKERS[@]}"
fi

for e in "$SLOT"/*.err; do
  [ -s "$e" ] || continue
  b="$(basename "$e" .err)"
  [ -s "$SLOT/$b.md" ] && continue   # skip successful responses
  echo "--- [$b] skipped; stderr (last 25 lines, scrubbed) ---" >&2
  tail -25 "$e" | scrub_secrets >&2
done
