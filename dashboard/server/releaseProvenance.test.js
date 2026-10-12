import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../scripts/build-release.py", import.meta.url));
test("release builder rejects latest and archives only committed source with verified metadata", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ccdash-release-test-"));
  try {
    const root = path.join(directory, "repo");
    const bin = path.join(directory, "bin");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(path.join(root, "dashboard/server"), { recursive: true });
    mkdirSync(bin);
    copyFileSync(source, path.join(root, "scripts/build-release.py"));
    writeFileSync(path.join(root, "dashboard/Dockerfile"), "FROM scratch\n");
    writeFileSync(path.join(root, "dashboard/server/index.js"), "// synthetic source\n");
    writeFileSync(path.join(root, ".gitignore"), ".env\n");
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q"); git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("add", "."); git("commit", "-qm", "fixture");
    const revision = git("rev-parse", "HEAD").toString().trim();
    writeFileSync(path.join(root, "dashboard/server/.env"), "YOUR_SYNTHETIC_SECRET=never-ship\n");
    writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env python3
import sys,json,pathlib,subprocess
args=sys.argv[1:]
revision=subprocess.check_output(['git','rev-parse','HEAD']).decode().strip()
if args[:2]==['buildx','build']:
  context=pathlib.Path(args[-1])
  assert (context/'server/index.js').exists()
  assert not (context/'server/.env').exists()
  assert 'APP_REVISION='+revision in args
  assert 'linux/arm64' in args and '--load' in args
  metadata=pathlib.Path(args[args.index('--metadata-file')+1])
  metadata.write_text(json.dumps({'containerimage.digest':'sha256:'+'b'*64}))
elif args[:2]==['image','inspect']:
  print(json.dumps([{'Architecture':'arm64','Id':'sha256:'+'c'*64,'Config':{'Labels':{'org.opencontainers.image.revision':revision},'Env':['APP_REVISION='+revision]}}]))
else: raise RuntimeError('unexpected docker command')
`, { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const record = path.join(directory, "release.json");
    const invalid = spawnSync("python3", ["scripts/build-release.py", "--image", "fixture:latest", "--record", record],
      { cwd: root, env, encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    const valid = spawnSync("python3", ["scripts/build-release.py", "--image", "fixture:version-one", "--record", record],
      { cwd: root, env, encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);
    const metadata = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(metadata.revision, revision);
    assert.equal(metadata.platform, "linux/arm64");
    assert.equal(metadata.source, "git-archive");
    assert.equal(metadata.digest, "sha256:" + "b".repeat(64));
    assert.equal(statSync(record).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(metadata).includes("SYNTHETIC_SECRET"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
