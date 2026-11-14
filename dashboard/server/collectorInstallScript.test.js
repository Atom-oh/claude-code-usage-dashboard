import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectorInstallScript } from "./collectorInstallScript.js";

const endpoint = "https://dashboard.example.invalid/api/ingest";
const token = `ccd1.${"a".repeat(64)}.${"b".repeat(32)}.${"C".repeat(43)}`;
const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();

// Runs `cat install.sh | sh` on a pseudo-terminal and answers the prompts like a person would.
const DRIVER = String.raw`
import json, os, pty, sys
script, answers, extra = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    os.execvp("sh", ["sh", "-c", 'script=$1; shift; cat "$script" | sh -s -- "$@"', "sh", script, *extra])
output, sent = b"", 0
prompts = ["사용자 ID".encode(), "기기 토큰".encode()]
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
    while sent < len(answers) and prompts[sent] in output:
        os.write(fd, (answers[sent] + "\n").encode())
        sent += 1
status = os.waitpid(pid, 0)[1]
print(json.dumps({"status": os.waitstatus_to_exitcode(status), "output": output.decode("utf-8", "replace")}))
`;

const STUBS = {
  uname: `#!/bin/sh\nprintf '%s\\n' "$CCDASH_TEST_UNAME"\n`,
  curl: `#!/bin/sh
printf '%s\\n' "$@" >"$CCDASH_TEST_OUT/curl-args"
cat >"$CCDASH_TEST_OUT/curl-config"
[ -z "\${CCDASH_TEST_CURL_FAIL:-}" ] || exit 22
while [ $# -gt 0 ]; do [ "$1" != -o ] || out=$2; shift; done
cp "$CCDASH_TEST_PACKAGE" "$out"
`,
  python3: `#!/bin/sh
if [ "$1" = -I ] && [ "$2" = -c ]; then
  case "$3" in
    *version_info*) exit "\${CCDASH_TEST_PYTHON_OLD:-0}" ;;
    *hashlib*) printf '%s\\n' "$CCDASH_TEST_HELPER_SHA"; exit 0 ;;
  esac
fi
printf '%s\\n' "$@" >"$CCDASH_TEST_OUT/python-args"
[ -t 0 ] && echo tty >"$CCDASH_TEST_OUT/python-stdin"
case "$2" in */enroll.py) exit 0 ;; esac
[ -t 0 ] && echo tty >"$CCDASH_TEST_OUT/python-stdin"
while [ $# -gt 0 ]; do [ "$1" != --token-file ] || file=$2; shift; done
printf '%s\\n' "$file" >"$CCDASH_TEST_OUT/token-path"
{ stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file"; } >"$CCDASH_TEST_OUT/token-mode"
cp "$file" "$CCDASH_TEST_OUT/token-copy"
`,
};

const helperSha = "d".repeat(64);

function run(t, { answers = ["alice@example.com", token], uname = "Linux", curlFail = false, args = [],
  digest = null, servedSha = helperSha, pythonOld = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "collector-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const out = join(root, "out");
  const work = join(root, "tmp");
  for (const directory of [bin, out, work, join(root, "package/ccdash-collector")])
    mkdirSync(directory, { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(root, "package/ccdash-collector/install.py"), "# fixture\n");
  const archive = join(root, "package.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", archive, "-C", join(root, "package"), "ccdash-collector"]).status, 0);
  const script = join(root, "install.sh");
  writeFileSync(script, collectorInstallScript(endpoint, digest));
  const result = spawnSync(python, ["-I", "-c", DRIVER, script, JSON.stringify(answers), JSON.stringify(args)], {
    encoding: "utf8", timeout: 20000,
    env: { PATH: `${bin}:${process.env.PATH}`, TMPDIR: work, LANG: "C.UTF-8", CCDASH_TEST_OUT: out,
      CCDASH_TEST_PACKAGE: archive, CCDASH_TEST_UNAME: uname, CCDASH_TEST_HELPER_SHA: servedSha,
      ...(curlFail ? { CCDASH_TEST_CURL_FAIL: "1" } : {}), ...(pythonOld ? { CCDASH_TEST_PYTHON_OLD: "1" } : {}) },
  });
  assert.equal(result.status, 0, result.stderr);
  const read = name => existsSync(join(out, name)) ? readFileSync(join(out, name), "utf8") : undefined;
  return { ...JSON.parse(result.stdout), read, work };
}

const skip = !python || process.platform === "win32" ? "python3 and a POSIX pty are required" : false;

test("curl | sh downloads with the device token off argv and installs from a private token file", { skip }, t => {
  const { status, output, read, work } = run(t);
  assert.equal(status, 0, output);
  const curlArgs = read("curl-args").trimEnd().split("\n");
  assert.deepEqual(curlArgs.slice(0, 5), ["-fsS", "--proto", "=https", "-K", "-"]);
  assert.equal(curlArgs.at(-1), `${endpoint}/package/linux`);
  assert.equal(read("curl-config"), `header = "Authorization: Bearer ${token}"\n`);
  const pythonArgs = read("python-args").trimEnd().split("\n");
  const tokenPath = read("token-path").trim();
  assert.match(pythonArgs[1], /\/ccdash-install\.[^/]+\/ccdash-collector\/install\.py$/);
  assert.deepEqual([pythonArgs[0], ...pythonArgs.slice(2)], ["-I", "install", "--endpoint", endpoint,
    "--user-id", "alice@example.com", "--token-file", tokenPath]);
  assert.equal(read("python-stdin"), "tty\n");
  assert.equal(read("token-mode"), "600\n");
  assert.equal(read("token-copy"), `${token}\n`);
  for (const args of [read("curl-args"), read("python-args")]) assert.equal(args.includes(token), false);
  assert.equal(output.includes(token), false, "the token prompt must not echo");
  assert.equal(existsSync(tokenPath), false);
  assert.equal(spawnSync("sh", ["-c", `ls -A "${work}"`], { encoding: "utf8" }).stdout, "");
});

test("macOS selects the darwin package", { skip }, t => {
  const { status, output, read } = run(t, { uname: "Darwin" });
  assert.equal(status, 0, output);
  assert.equal(read("curl-args").trimEnd().split("\n").at(-1), `${endpoint}/package/darwin`);
});

test("missing input, malformed tokens and failed downloads stop before installing", { skip }, t => {
  for (const [answers, message] of [
    [[""], "사용자 ID를 입력한 뒤"],
    [["alice", ""], "기기 토큰 형식이"],
    [["alice", `${token}" -o /etc/x`], "기기 토큰 형식이"],
  ]) {
    const { status, output, read } = run(t, { answers });
    assert.equal(status, 1, output);
    assert.match(output, new RegExp(message));
    assert.equal(read("curl-args"), undefined);
    assert.equal(read("python-args"), undefined);
  }
  const failed = run(t, { curlFail: true });
  assert.equal(failed.status, 1, failed.output);
  assert.match(failed.output, /패키지를 내려받지 못했습니다/);
  assert.equal(failed.read("python-args"), undefined);
  assert.equal(spawnSync("sh", ["-c", `ls -A "${failed.work}"`], { encoding: "utf8" }).stdout, "");
});

test("unsupported systems and runs without a terminal fail with guidance", { skip }, t => {
  const unsupported = run(t, { uname: "FreeBSD" });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.output, /지원하지 않는 운영체제/);
  const root = mkdtempSync(join(tmpdir(), "collector-install-notty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "install.sh"), collectorInstallScript(endpoint));
  // setsid detaches the controlling terminal, as in cron or CI.
  const result = spawnSync("setsid", ["sh", join(root, "install.sh")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error?.code === "ENOENT") return t.skip("setsid unavailable");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /터미널에서 실행하세요/);
});

test("by default the launcher runs the digest-pinned browser enrollment helper on the terminal", { skip }, t => {
  const { status, output, read, work } = run(t, { digest: helperSha, answers: [] });
  assert.equal(status, 0, output);
  const curlArgs = read("curl-args").trimEnd().split("\n");
  // No -L: a redirect away from this dashboard fails instead of fetching another helper.
  assert.deepEqual([...curlArgs.slice(0, 4), curlArgs.at(-1)], ["-fsS", "--proto", "=https", "-o", `${endpoint}/enroll.py`]);
  assert.equal(curlArgs.includes("-L"), false);
  assert.equal(read("curl-config"), "");
  const pythonArgs = read("python-args").trimEnd().split("\n");
  assert.match(pythonArgs[1], /\/ccdash-install\.[^/]+\/enroll\.py$/);
  assert.deepEqual([pythonArgs[0], ...pythonArgs.slice(2)], ["-I", "--endpoint", endpoint, "--platform", "linux"]);
  assert.equal(read("python-stdin"), "tty\n");
  assert.equal(/사용자 ID|기기 토큰/.test(output), false, "browser enrollment asks for neither");
  assert.equal(spawnSync("sh", ["-c", `ls -A "${work}"`], { encoding: "utf8" }).stdout, "");
});

test("a user ID override reaches the helper and --token keeps the manual flow", { skip }, t => {
  const override = run(t, { digest: helperSha, answers: [], args: ["--user-id", "bob@example.com"] });
  assert.equal(override.status, 0, override.output);
  assert.deepEqual(override.read("python-args").trimEnd().split("\n").slice(2),
    ["--endpoint", endpoint, "--platform", "linux", "--user-id", "bob@example.com"]);
  const manual = run(t, { digest: helperSha, args: ["--token"] });
  assert.equal(manual.status, 0, manual.output);
  assert.equal(manual.read("curl-args").trimEnd().split("\n").at(-1), `${endpoint}/package/linux`);
  assert.equal(manual.read("token-copy"), `${token}\n`);
});

test("a helper digest mismatch, old Python or unknown option stops before running anything", { skip }, t => {
  const mismatch = run(t, { digest: helperSha, answers: [], servedSha: "e".repeat(64) });
  assert.equal(mismatch.status, 1, mismatch.output);
  assert.match(mismatch.output, /설치 도우미 버전이 맞지 않습니다/);
  assert.equal(mismatch.read("python-args"), undefined);
  assert.equal(spawnSync("sh", ["-c", `ls -A "${mismatch.work}"`], { encoding: "utf8" }).stdout, "");
  const old = run(t, { digest: helperSha, answers: [], pythonOld: true });
  assert.equal(old.status, 1);
  assert.match(old.output, /Python 3\.9 이상/);
  assert.equal(old.read("curl-args"), undefined);
  const unknown = run(t, { digest: helperSha, answers: [], args: ["--sudo"] });
  assert.equal(unknown.status, 1);
  assert.match(unknown.output, /알 수 없는 옵션/);
  assert.throws(() => collectorInstallScript(endpoint, "not-a-digest"), /invalid helper digest/);
});
