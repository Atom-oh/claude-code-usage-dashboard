const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * POSIX sh bootstrap served at /api/ingest/install.sh for `curl -fsSL URL | sh`. It holds no secret.
 * Default: download the digest-pinned enroll.py helper, which pairs this device through browser SSO.
 * `sh -s -- --token` keeps the manual flow: the device token is typed at /dev/tty, reaches curl through
 * a stdin config (never argv/env) and reaches install.py as a private --token-file.
 * Without a helper digest (packages not built) only the manual flow is offered.
 */
export function collectorInstallScript(endpoint, helperSha256 = null) {
  if (helperSha256 !== null && !/^[a-f0-9]{64}$/.test(helperSha256)) throw new Error("invalid helper digest");
  return `#!/bin/sh
# ccdash collector installer. Run on the device: curl -fsSL ${endpoint}/install.sh | sh
# Manual token installation: curl -fsSL ${endpoint}/install.sh | sh -s -- --token
set -eu

ccdash_fail() {
  printf 'ccdash: %s\\n' "$1" >&2
  exit 1
}

ccdash_main() {
  endpoint=${shellQuote(endpoint)}
  helper_sha256='${helperSha256 ?? ""}'
  mode=browser
  user_id=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --token) mode=token ;;
      --user-id) [ "$#" -ge 2 ] || ccdash_fail '--user-id 값이 필요합니다.'; shift; user_id=$1 ;;
      --user-id=*) user_id=\${1#--user-id=} ;;
      *) ccdash_fail "알 수 없는 옵션입니다: $1 (사용 가능: --token, --user-id ID)" ;;
    esac
    shift
  done
  [ -n "$helper_sha256" ] || mode=token
  case "$(uname -s)" in
    Linux) platform=linux ;;
    Darwin) platform=darwin ;;
    *) ccdash_fail '지원하지 않는 운영체제입니다. Linux 또는 macOS에서 실행하세요.' ;;
  esac
  for tool in curl tar python3 mktemp stty; do
    command -v "$tool" >/dev/null 2>&1 || ccdash_fail "$tool 명령이 필요합니다."
  done
  python3 -I -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null ||
    ccdash_fail 'Python 3.9 이상이 필요합니다.'
  # Prompts and install.py read the terminal: stdin is this script when piped from curl.
  (exec </dev/tty) 2>/dev/null || ccdash_fail '터미널에서 실행하세요. 설치 중 확인과 입력이 필요합니다.'

  umask 077
  work=$(mktemp -d "\${TMPDIR:-/tmp}/ccdash-install.XXXXXX") || ccdash_fail '임시 폴더를 만들지 못했습니다.'
  trap 'stty echo </dev/tty 2>/dev/null || :; rm -rf "$work"' EXIT
  trap 'exit 130' HUP INT TERM

  if [ "$mode" = browser ]; then
    # curl does not follow redirects without -L: the helper must come from this dashboard.
    curl -fsS --proto '=https' -o "$work/enroll.py" "$endpoint/enroll.py" ||
      ccdash_fail '설치 도우미를 내려받지 못했습니다. 네트워크를 확인한 뒤 다시 실행하세요.'
    actual=$(python3 -I -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$work/enroll.py")
    [ "$actual" = "$helper_sha256" ] ||
      ccdash_fail '설치 도우미 버전이 맞지 않습니다. 대시보드 배포 중일 수 있으니 잠시 후 다시 실행하세요.'
    set -- --endpoint "$endpoint" --platform "$platform"
    [ -z "$user_id" ] || set -- "$@" --user-id "$user_id"
    python3 -I "$work/enroll.py" "$@" </dev/tty
    return
  fi

  if [ -z "$user_id" ]; then
    printf '수집 사용자 ID/이메일 (기존 설치는 동일한 값): ' >/dev/tty
    IFS= read -r user_id </dev/tty || user_id=
  fi
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
ccdash_main "$@"
`;
}
