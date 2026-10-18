import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../scripts/build-release.py", import.meta.url));
const probe = fileURLToPath(new URL("../verify-runtime.mjs", import.meta.url));

function fixture(run) {
  const directory = mkdtempSync(path.join(tmpdir(), "ccdash-release-test-"));
  try {
    const root = path.join(directory, "repo");
    const bin = path.join(directory, "bin");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(path.join(root, "dashboard/server"), { recursive: true });
    mkdirSync(path.join(root, "dashboard/web"), { recursive: true });
    mkdirSync(bin);
    copyFileSync(source, path.join(root, "scripts/build-release.py"));
    copyFileSync(probe, path.join(root, "dashboard/verify-runtime.mjs"));
    writeFileSync(path.join(root, "dashboard/Dockerfile"), "FROM scratch\n");
    writeFileSync(path.join(root, "dashboard/server/index.js"), "// synthetic source\n");
    writeFileSync(path.join(root, "dashboard/server/package-lock.json"), '{"fixture":"server"}\n');
    writeFileSync(path.join(root, "dashboard/web/package-lock.json"), '{"fixture":"web"}\n');
    for (const file of ["LICENSE", "dashboard/APPLICATION_LICENSE"]) {
      writeFileSync(path.join(root, file), "Synthetic application terms.\n");
    }
    writeFileSync(path.join(root, ".gitignore"), ".env\n");
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q"); git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("add", "."); git("commit", "-qm", "fixture");
    const revision = git("rev-parse", "HEAD").toString().trim();
    writeFileSync(path.join(root, "dashboard/server/.env"), "YOUR_SYNTHETIC_SECRET=never-ship\n");
    const events = path.join(directory, "events.jsonl");
    writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env python3
import sys,json,pathlib,subprocess,os
args=sys.argv[1:]
with open(os.environ['FIXTURE_EVENTS'],'a') as log: log.write(json.dumps(args)+'\\n')
revision=subprocess.check_output(['git','rev-parse','HEAD']).decode().strip()
fault=os.environ.get('FIXTURE_FAULT','')
config_digest='sha256:'+'c'*64
if args[:2]==['buildx','build']:
  context=pathlib.Path(args[-1])
  assert (context/'server/index.js').exists()
  assert not (context/'server/.env').exists()
  assert 'APP_REVISION='+revision in args
  assert 'linux/arm64' in args and '--load' in args and '--push' not in args
  metadata=pathlib.Path(args[args.index('--metadata-file')+1])
  metadata.write_text(json.dumps({'containerimage.digest':'sha256:'+'b'*64,'containerimage.config.digest':config_digest}))
elif args[:2]==['image','inspect']:
  env=[] if fault=='revision' else ['APP_REVISION='+revision]
  image_id='sha256:'+'e'*64 if fault=='config_digest' else config_digest
  print(json.dumps([{'Architecture':'arm64','Os':'linux','Id':image_id,'Config':{'User':'root' if fault=='root' else 'node','Labels':{'org.opencontainers.image.revision':revision},'Env':env}}]))
elif args[0]=='create':
  assert '--network' in args and 'none' in args and '--read-only' in args
  assert config_digest in args
  assert 'expectedRevision' in args[-1] and revision in args[-1]
  print('a'*64)
elif args[:2]==['start','--attach']:
  assert args[-1]=='a'*64
  if fault=='runtime': sys.exit(12)
  print(json.dumps({'revision':revision,'uid':1000,'node':'24.22.0','openssl':'synthetic-version','packageManagersAbsent':True,'noticePackageCount':1}))
elif args[:2]==['rm','--force']:
  assert args[-1]=='a'*64
elif args[:2]==['container','inspect']:
  assert args[-1]=='a'*64
  print('permission denied' if fault=='cleanup' else 'Error: No such container: '+'a'*64,file=sys.stderr)
  sys.exit(1)
elif args[0]=='push':
  assert fault not in ['runtime','cleanup','root','revision','config_digest']
elif args[:3]==['buildx','imagetools','inspect']:
  if '--raw' in args:
    print(json.dumps({'config':{'digest':'sha256:'+'e'*64 if fault=='registry_config' else config_digest}}))
  else:
    print(json.dumps({'digest':'sha256:'+'d'*64,'manifests':[{'digest':'sha256:'+'b'*64,'platform':{'os':'linux','architecture':'arm64'}}]}))
else: raise RuntimeError('unexpected docker command')
`, { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_EVENTS: events };
    const record = path.join(directory, "release.json");
    const invoke = (args = [], fault = "") => spawnSync("python3",
      ["scripts/build-release.py", "--image", "fixture:version-one", "--record", record, ...args,
        ...(args.includes("--push") && !args.includes("--expected-image-id")
          ? ["--expected-image-id", "sha256:" + "c".repeat(64)] : [])],
      { cwd: root, env: { ...env, FIXTURE_FAULT: fault }, encoding: "utf8" });
    const calls = () => {
      try { return readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    };
    run({ root, revision, record, invoke, calls, env, git });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("release builder rejects latest and archives only committed source with verified metadata", () => {
  fixture(({ root, revision, record, invoke, calls, env }) => {
    const invalid = spawnSync("python3", ["scripts/build-release.py", "--image", "fixture:latest", "--record", record],
      { cwd: root, env, encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.deepEqual(calls(), []);
    const valid = invoke();
    assert.equal(valid.status, 0, valid.stderr);
    const metadata = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(metadata.revision, revision);
    assert.equal(metadata.platform, "linux/arm64");
    assert.equal(metadata.source, "git-archive");
    assert.equal(metadata.digest, "sha256:" + "b".repeat(64));
    assert.equal(metadata.localImageId, "sha256:" + "c".repeat(64));
    assert.match(metadata.sourceArchiveSha256, /^[a-f0-9]{64}$/);
    assert.match(metadata.lockfileSha256.server, /^[a-f0-9]{64}$/);
    assert.equal(metadata.runtime.uid, 1000);
    assert.equal(metadata.runtime.packageManagersAbsent, true);
    assert.ok(Date.parse(metadata.completedAt) >= Date.parse(metadata.builtAt));
    assert.equal(statSync(record).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(metadata).includes("SYNTHETIC_SECRET"));
    assert.ok(calls().some((args) => args[0] === "rm"));
    assert.ok(calls().some((args) => args[0] === "container" && args[1] === "inspect"));
  });
});

test("publishing validates locally before upload and binds the registry ARM64 config", () => {
  fixture(({ record, invoke, calls }) => {
    const valid = invoke(["--push"]);
    assert.equal(valid.status, 0, valid.stderr);
    const commands = calls();
    const start = commands.findIndex((args) => args[0] === "start");
    const cleanup = commands.findIndex((args) => args[0] === "container");
    const push = commands.findIndex((args) => args[0] === "push");
    assert.ok(start >= 0 && cleanup > start && push > cleanup);
    const metadata = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(metadata.pushed, true);
    assert.equal(metadata.digest, "sha256:" + "d".repeat(64));
    assert.equal(metadata.arm64ManifestDigest, "sha256:" + "b".repeat(64));
    assert.equal(metadata.localBuildDigest, "sha256:" + "b".repeat(64));
  });
});

test("publishing requires the approved image identity and rejects a different rebuilt artifact", () => {
  fixture(({ root, record, env, calls }) => {
    const invalid = spawnSync("python3",
      ["scripts/build-release.py", "--image", "fixture:version-one", "--record", record, "--push"],
      { cwd: root, env, encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /expected-image-id/);
    assert.deepEqual(calls(), []);
  });
  fixture(({ invoke, calls }) => {
    const invalid = invoke(["--push", "--expected-image-id", "sha256:" + "e".repeat(64)]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /approved image ID/);
    assert.ok(!calls().some((args) => args[0] === "push"));
  });
});

test("publishing refuses an unverified runtime, identity, config or cleanup before upload", () => {
  for (const fault of ["runtime", "cleanup", "root", "revision", "config_digest"]) {
    fixture(({ record, invoke, calls }) => {
      const invalid = invoke(["--push"], fault);
      assert.notEqual(invalid.status, 0, fault);
      assert.ok(!calls().some((args) => args[0] === "push"), fault);
      assert.throws(() => readFileSync(record), { code: "ENOENT" });
      if (fault === "runtime") assert.ok(calls().some((args) => args[0] === "rm"));
      if (fault === "cleanup") {
        assert.equal(calls().filter((args) => args[0] === "container").length, 3);
      }
    });
  }
});

test("a different published config cannot produce a verified release record", () => {
  fixture(({ record, invoke, calls }) => {
    const invalid = invoke(["--push"], "registry_config");
    assert.notEqual(invalid.status, 0);
    assert.ok(calls().some((args) => args[0] === "push"));
    assert.throws(() => readFileSync(record), { code: "ENOENT" });
  });
});

test("dirty source fails before any Docker operation", () => {
  fixture(({ root, invoke, calls }) => {
    writeFileSync(path.join(root, "dashboard/APPLICATION_LICENSE"), "Different terms.\n");
    const invalid = invoke(["--push"]);
    assert.notEqual(invalid.status, 0);
    assert.deepEqual(calls(), []);
  });
});

test("committed license mismatch fails before any Docker operation", () => {
  fixture(({ root, invoke, calls, git }) => {
    writeFileSync(path.join(root, "dashboard/APPLICATION_LICENSE"), "Different committed terms.\n");
    git("add", "dashboard/APPLICATION_LICENSE");
    git("commit", "-qm", "synthetic license mismatch");
    const invalid = invoke(["--push"]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /license differs/);
    assert.deepEqual(calls(), []);
  });
});
