const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * POSIX sh bootstrap served at /api/ingest/install.sh for `curl -fsSL URL | sh`.
 * It holds no secret: the device token is typed at /dev/tty, reaches curl through a
 * stdin config (never argv/env) and reaches install.py as a private --token-file.
 */
export function collectorInstallScript(endpoint) {
  return `#!/bin/sh
# ccdash collector installer. Run on the device: curl -fsSL ${endpoint}/install.sh | sh
set -eu

ccdash_fail() {
  printf 'ccdash: %s\\n' "$1" >&2
  exit 1
}

ccdash_main() {
  endpoint=${shellQuote(endpoint)}
  case "$(uname -s)" in
    Linux) platform=linux ;;
    Darwin) platform=darwin ;;
    *) ccdash_fail '지원하지 않는 운영체제입니다. Linux 또는 macOS에서 실행하세요.' ;;
  esac
  for tool in curl tar python3 mktemp stty; do
    command -v "$tool" >/dev/null 2>&1 || ccdash_fail "$tool 명령이 필요합니다."
  done
  # Prompts and install.py read the terminal: stdin is this script when piped from curl.
  (exec </dev/tty) 2>/dev/null || ccdash_fail '터미널에서 실행하세요. 사용자 ID와 기기 토큰을 입력해야 합니다.'

  umask 077
  work=$(mktemp -d "\${TMPDIR:-/tmp}/ccdash-install.XXXXXX") || ccdash_fail '임시 폴더를 만들지 못했습니다.'
  trap 'stty echo </dev/tty 2>/dev/null || :; rm -rf "$work"' EXIT
  trap 'exit 130' HUP INT TERM

  printf '수집 사용자 ID/이메일 (기존 설치는 동일한 값): ' >/dev/tty
  IFS= read -r user_id </dev/tty || user_id=
  [ -n "$user_id" ] || ccdash_fail '사용자 ID를 입력한 뒤 다시 실행하세요.'

  # Echo goes off before the prompt so fast pasted input is never displayed.
  stty -echo </dev/tty
  printf '기기 토큰 (입력 내용은 표시되지 않음): ' >/dev/tty
  IFS= read -r token </dev/tty || token=
  stty echo </dev/tty
  printf '\\n' >/dev/tty
  case "$token" in
    ''|*[!A-Za-z0-9._-]*) ccdash_fail '기기 토큰 형식이 올바르지 않습니다. 대시보드에서 복사한 토큰을 붙여 넣으세요.' ;;
  esac
  printf '%s\\n' "$token" >"$work/token"

  printf 'header = "Authorization: Bearer %s"\\n' "$token" |
    curl -fsS --proto '=https' -K - -o "$work/package.tar.gz" "$endpoint/package/$platform" ||
    ccdash_fail '패키지를 내려받지 못했습니다. 토큰이 만료되거나 해지되지 않았는지 확인하세요.'
  token=
  tar -xzf "$work/package.tar.gz" -C "$work" || ccdash_fail '패키지 압축을 풀지 못했습니다.'
  python3 -I "$work/ccdash-collector/install.py" install --endpoint "$endpoint" \\
    --user-id "$user_id" --token-file "$work/token" </dev/tty
}

# Called last so a truncated download never runs a partial script.
ccdash_main
`;
}
