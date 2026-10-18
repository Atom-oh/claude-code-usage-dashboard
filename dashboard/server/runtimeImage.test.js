import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { verifyRuntime } from "../verify-runtime.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");

function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "ccdash-runtime-"));
  try {
    for (const directory of ["opt", "app/notices", "app/server", "usr/local/bin"]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    const license = "Synthetic fixture license.\n";
    const serverLock = '{"fixture":"server"}\n';
    const expectedLockfiles = { server: hash(serverLock), web: hash('{"fixture":"web"}\n') };
    const notices = {
      schemaVersion: 1, complete: true, unresolved: [],
      packages: [{ name: "synthetic-fixture", version: "1.0.0" }],
      lockfiles: expectedLockfiles,
    };
    writeFileSync(path.join(root, "app/APPLICATION_LICENSE"), license);
    writeFileSync(path.join(root, "app/server/package-lock.json"), serverLock);
    writeFileSync(path.join(root, "app/notices/THIRD_PARTY_NOTICES.json"), JSON.stringify(notices));
    writeFileSync(path.join(root, "app/notices/THIRD_PARTY_NOTICES.txt"), "Synthetic dependency notices.\n");
    const options = {
      root, uid: 1000, versions: { node: "24.22.0", openssl: "synthetic-version" },
      revision: "a".repeat(40), expectedRevision: "a".repeat(40),
      expectedLicenseSha256: hash(license), expectedLockfiles,
    };
    run({ root, options, notices });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("runtime inspection binds actual notices, license, lock and nonroot release identity", () => {
  fixture(({ options }) => {
    const result = verifyRuntime(options);
    assert.equal(result.uid, 1000);
    assert.equal(result.node, "24.22.0");
    assert.equal(result.revision, options.expectedRevision);
    assert.equal(result.noticePackageCount, 1);
    assert.equal(result.packageManagersAbsent, true);
    assert.equal(result.applicationLicenseSha256, options.expectedLicenseSha256);
    assert.equal(result.serverLockSha256, options.expectedLockfiles.server);
    assert.match(result.noticesJsonSha256, /^[a-f0-9]{64}$/);
    assert.match(result.noticesTextSha256, /^[a-f0-9]{64}$/);
  });
});

test("runtime inspection rejects root, unsupported Node and missing release identity", () => {
  fixture(({ options }) => {
    assert.throws(() => verifyRuntime({ ...options, uid: 0 }), /nonroot/);
    assert.throws(() => verifyRuntime({ ...options, versions: { node: "22.0.0", openssl: "x" } }), /Node 24/);
    assert.throws(() => verifyRuntime({ ...options, versions: { node: "24.22.0" } }), /OpenSSL/);
    assert.throws(() => verifyRuntime({ ...options, revision: undefined }), /revision/);
    assert.throws(() => verifyRuntime({ ...options, expectedRevision: "short" }), /revision/);
  });
});

test("runtime inspection detects broken package-manager symlinks and Yarn directories", () => {
  fixture(({ root, options }) => {
    const npm = path.join(root, "usr/local/bin/npm");
    symlinkSync("/synthetic/missing/npm", npm);
    assert.throws(() => verifyRuntime(options), /unexpected build artifact/);
    rmSync(npm);
    mkdirSync(path.join(root, "opt/yarn-v1.22.22"));
    assert.throws(() => verifyRuntime(options), /Yarn installation/);
  });
});

test("runtime inspection rejects frontend modules and build collectors", () => {
  for (const filename of ["app/web/node_modules", "app/collect-notices.mjs", "app/verify-runtime.mjs"]) {
    fixture(({ root, options }) => {
      mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
      writeFileSync(path.join(root, filename), "synthetic build artifact");
      assert.throws(() => verifyRuntime(options), /unexpected build artifact/);
    });
  }
});

test("runtime inspection rejects different application terms and missing license hash", () => {
  fixture(({ root, options }) => {
    assert.throws(() => verifyRuntime({ ...options, expectedLicenseSha256: undefined }), /license differs/);
    writeFileSync(path.join(root, "app/APPLICATION_LICENSE"), "Different synthetic terms.");
    assert.throws(() => verifyRuntime(options), /license differs/);
  });
});

test("runtime inspection rejects incomplete, unresolved or empty distribution notices", () => {
  for (const change of [{ complete: false }, { unresolved: ["synthetic"] }, { packages: [] }]) {
    fixture(({ root, options, notices }) => {
      writeFileSync(path.join(root, "app/notices/THIRD_PARTY_NOTICES.json"),
        JSON.stringify({ ...notices, ...change }));
      assert.throws(() => verifyRuntime(options), /notices are incomplete/);
    });
  }
  fixture(({ root, options }) => {
    writeFileSync(path.join(root, "app/notices/THIRD_PARTY_NOTICES.txt"), " \n");
    assert.throws(() => verifyRuntime(options), /notices are incomplete/);
  });
});

test("runtime inspection rejects notices or installed locks from another source", () => {
  for (const component of ["server", "web"]) {
    fixture(({ root, options, notices }) => {
      writeFileSync(path.join(root, "app/notices/THIRD_PARTY_NOTICES.json"), JSON.stringify({
        ...notices, lockfiles: { ...notices.lockfiles, [component]: "b".repeat(64) },
      }));
      assert.throws(() => verifyRuntime(options), /notices lock differs/);
    });
  }
  fixture(({ root, options }) => {
    writeFileSync(path.join(root, "app/server/package-lock.json"), '{"different":"fixture"}');
    assert.throws(() => verifyRuntime(options), /runtime server lock differs/);
  });
});
